import { createHash } from "node:crypto";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  EffectRuntimeLockTimeoutError,
  EffectRuntimeRequestError,
} from "../effect_runtime_errors.ts";
import { atomicWriteJson, withFileMutationLock } from "../effect_runtime_io.ts";
import {
  settlementIdentity,
  type JsonObject,
} from "../effect_program.ts";
import { requireJsonObject } from "../runtime_decode.ts";

export const TASK_LEASE_ACQUIRE_REQUEST_SCHEMA_VERSION =
  "loopx_task_lease_acquire_native_v0";
export const TASK_LEASE_SCHEMA_VERSION = "task_lease_v0";

const DEFAULT_TTL_SECONDS = 45 * 60;
const MAX_TTL_SECONDS = 24 * 60 * 60;
const TODO_WRITE_SCOPE_MAX_CHARS = 160;

type FileState = "file" | "missing";

interface SourceReceipt {
  source_id: string;
  path: string;
  state: FileState;
  sha256: string | null;
}

interface TodoFact {
  todo_id: string;
  status: string;
  claimed_by: string | null;
  excluded_agents: readonly string[];
}

interface AuthorityFacts {
  handoff_mode: string;
  registered_agents: readonly string[];
  todos: ReadonlyMap<string, TodoFact>;
  todo_projection_error: TaskLeaseFailure | null;
  source_receipts: readonly SourceReceipt[];
}

interface AcquireRequest {
  runtime_root: string;
  goal_id: string;
  owner: string;
  todo_id: string;
  idempotency_key: string;
  write_scopes: readonly string[];
  ttl_seconds: number;
  expected_version: number | null;
  authority: AuthorityFacts;
}

interface LeaseRecord extends JsonObject {
  schema_version?: unknown;
  goal_id?: unknown;
  todo_id?: unknown;
  owner?: unknown;
  idempotency_key?: unknown;
  write_scopes?: unknown;
  acquire_ttl_seconds?: unknown;
  version?: unknown;
  lease_epoch?: unknown;
  status?: unknown;
  acquired_at?: unknown;
  updated_at?: unknown;
  expires_at?: unknown;
}

interface TaskLeaseFailure {
  code: string;
  message: string;
  payload: JsonObject;
}

interface ExecutionContext {
  effectId: string | null;
  leasePath: string | null;
}

export interface TaskLeaseAcquireDependencies {
  now?: () => Date;
  beforeWrite?: (lease: JsonObject) => void | Promise<void>;
}

export type TaskLeaseAcquireEnvelope = JsonObject;

class TaskLeaseAcquireError extends Error {
  readonly code: string;
  readonly payload: JsonObject;

  constructor(message: string, code: string, payload: JsonObject = {}) {
    super(message);
    this.name = "TaskLeaseAcquireError";
    this.code = code;
    this.payload = payload;
  }
}

function stringValue(value: unknown, label: string): string {
  if (typeof value !== "string") {
    throw new EffectRuntimeRequestError(`${label} must be a string`);
  }
  return value;
}

function optionalInteger(value: unknown, label: string): number | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "number" || !Number.isInteger(value)) {
    throw new EffectRuntimeRequestError(`${label} must be an integer or null`);
  }
  return value;
}

function compactString(value: unknown): string {
  if (value === null || value === undefined) return "";
  switch (typeof value) {
    case "string":
      return value;
    case "number":
    case "bigint":
    case "symbol":
      return value.toString();
    case "boolean":
      return value ? "true" : "false";
    case "function":
      return Function.prototype.toString.call(value);
    case "object":
      return Array.isArray(value) ? value.join(",") : Object.prototype.toString.call(value);
  }
  return "";
}

function compact(value: unknown): string {
  return compactString(value).trim().split(/\s+/u).filter(Boolean).join(" ");
}

function normalizeAgent(value: unknown): string | null {
  const candidate = compact(value).toLowerCase().replaceAll(" ", "-");
  return /^[a-z][a-z0-9_.:@-]{0,79}$/u.test(candidate) ? candidate : null;
}

function normalizeGoalId(value: unknown): string {
  const goalId = stringValue(value, "goal_id").trim();
  if (
    goalId.length === 0 || goalId === "." || goalId === ".." ||
    goalId.includes("/") || goalId.includes("\\")
  ) {
    throw new TaskLeaseAcquireError(
      "goal id must be a single path segment",
      "invalid_goal_id",
    );
  }
  return goalId;
}

function normalizeTodoId(value: unknown, label = "todo_id"): string {
  const todoId = stringValue(value, label).trim().toLowerCase();
  if (!/^todo_[a-z0-9_-]{3,64}$/u.test(todoId)) {
    throw new TaskLeaseAcquireError(
      "todo id must use the todo_<token> shape",
      "invalid_todo_id",
    );
  }
  return todoId;
}

function normalizeOwner(value: unknown): string {
  const owner = normalizeAgent(stringValue(value, "owner"));
  if (owner === null) {
    throw new TaskLeaseAcquireError(
      "owner must be a public-safe agent id",
      "invalid_owner",
    );
  }
  return owner;
}

function normalizeIdempotencyKey(value: unknown): string {
  const key = stringValue(value, "idempotency_key").trim();
  if (!/^[A-Za-z0-9_.:@/-]{1,160}$/u.test(key)) {
    throw new TaskLeaseAcquireError(
      "idempotency key must be a public-safe token",
      "invalid_idempotency_key",
    );
  }
  return key;
}

function normalizeWriteScopes(value: unknown): string[] {
  let raw: unknown[];
  if (Array.isArray(value)) {
    raw = value;
  } else if (typeof value === "string") {
    raw = value.split(/[,;|]/u);
  } else {
    raw = [value];
  }
  const scopes: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    const scope = compact(item);
    if (
      scope.length === 0 || scope.length > TODO_WRITE_SCOPE_MAX_CHARS ||
      scope.startsWith("/") || scope.startsWith("~") ||
      scope.split("/").includes("..") || /[\s<>]/u.test(scope) ||
      seen.has(scope)
    ) {
      continue;
    }
    seen.add(scope);
    scopes.push(scope);
  }
  return scopes;
}

function normalizeTtl(value: unknown): number {
  const ttl = value === null || value === undefined
    ? DEFAULT_TTL_SECONDS
    : optionalInteger(value, "ttl_seconds");
  if (ttl === null || ttl <= 0 || ttl > MAX_TTL_SECONDS) {
    throw new TaskLeaseAcquireError(
      `ttl seconds must be between 1 and ${MAX_TTL_SECONDS}`,
      "invalid_ttl",
    );
  }
  return ttl;
}

function decodeSourceReceipt(value: unknown, index: number): SourceReceipt {
  const receipt = requireJsonObject(value, `authority.source_receipts[${index}]`);
  const sourceId = stringValue(receipt.source_id, "source receipt source_id").trim();
  const path = stringValue(receipt.path, "source receipt path");
  const state = stringValue(receipt.state, "source receipt state");
  if (!sourceId || !path || (state !== "file" && state !== "missing")) {
    throw new EffectRuntimeRequestError("authority source receipt is invalid");
  }
  const sha256 = receipt.sha256;
  if (
    (state === "file" &&
      (typeof sha256 !== "string" || !/^[a-f0-9]{64}$/u.test(sha256))) ||
    (state === "missing" && sha256 !== null)
  ) {
    throw new EffectRuntimeRequestError("authority source receipt digest is invalid");
  }
  return { source_id: sourceId, path, state, sha256: sha256 as string | null };
}

function decodeRegisteredAgentCandidate(value: unknown): string | null {
  if (Array.isArray(value)) return null;
  if (typeof value !== "object" || value === null) return normalizeAgent(value);
  const record = value as Record<string, unknown>;
  return normalizeAgent(record.id ?? record.agent_id ?? record.name);
}

function decodeRegisteredAgents(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new EffectRuntimeRequestError("authority.registered_agent_candidates must be an array");
  }
  const agents: string[] = [];
  const seen = new Set<string>();
  for (const candidate of value) {
    const entries = Array.isArray(candidate) ? candidate : [candidate];
    for (const entry of entries) {
      const agent = decodeRegisteredAgentCandidate(entry);
      if (agent && !seen.has(agent)) {
        seen.add(agent);
        agents.push(agent);
      }
    }
  }
  return agents;
}

function excludedAgentCandidates(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") return value.split(",");
  if (value === null || value === undefined) return [];
  return [value];
}

function decodeTodoFacts(value: unknown): ReadonlyMap<string, TodoFact> {
  if (!Array.isArray(value)) {
    throw new EffectRuntimeRequestError("authority.todos must be an array");
  }
  const todos = new Map<string, TodoFact>();
  for (let index = 0; index < value.length; index += 1) {
    const record = requireJsonObject(value[index], `authority.todos[${index}]`);
    const todoId = normalizeTodoId(record.todo_id, `authority.todos[${index}].todo_id`);
    const excluded = excludedAgentCandidates(record.excluded_agents);
    const excludedAgents = [...new Set(
      excluded.map(normalizeAgent).filter((agent): agent is string => agent !== null),
    )].sort((left, right) => left.localeCompare(right));
    todos.set(todoId, {
      todo_id: todoId,
      status: compact(record.status).toLowerCase(),
      claimed_by: normalizeAgent(record.claimed_by),
      excluded_agents: excludedAgents,
    });
  }
  return todos;
}

function decodeProjectionError(value: unknown): TaskLeaseFailure | null {
  if (value === null || value === undefined) return null;
  const error = requireJsonObject(value, "authority.todo_projection_error");
  const code = stringValue(error.code, "authority.todo_projection_error.code");
  const message = stringValue(error.message, "authority.todo_projection_error.message");
  const payload = error.payload === null || error.payload === undefined
    ? {}
    : requireJsonObject(error.payload, "authority.todo_projection_error.payload");
  return { code, message, payload };
}

function normalizeHandoffMode(value: unknown): string {
  const mode = compact(value) || "legacy";
  if (!new Set(["legacy", "soft_claim", "hard_lease"]).has(mode)) {
    throw new TaskLeaseAcquireError(
      `unsupported handoff_mode '${mode}'; expected one of: legacy, soft_claim, hard_lease`,
      "invalid_handoff_mode",
      { handoff_mode: mode, supported: ["legacy", "soft_claim", "hard_lease"] },
    );
  }
  return mode;
}

function decodeRequest(value: unknown): AcquireRequest {
  const request = requireJsonObject(value, "task lease acquire request");
  if (request.schema_version !== TASK_LEASE_ACQUIRE_REQUEST_SCHEMA_VERSION) {
    throw new EffectRuntimeRequestError("Task-lease acquire request schema mismatch");
  }
  const authority = requireJsonObject(request.authority, "authority");
  const receiptsValue = authority.source_receipts;
  if (!Array.isArray(receiptsValue) || receiptsValue.length === 0) {
    throw new EffectRuntimeRequestError("authority.source_receipts must be a non-empty array");
  }
  const receipts = receiptsValue.map((receipt, index) =>
    decodeSourceReceipt(receipt, index)
  );
  if (new Set(receipts.map((receipt) => receipt.source_id)).size !== receipts.length) {
    throw new EffectRuntimeRequestError("authority source ids must be unique");
  }
  return {
    runtime_root: stringValue(request.runtime_root, "runtime_root"),
    goal_id: normalizeGoalId(request.goal_id),
    owner: normalizeOwner(request.owner),
    todo_id: normalizeTodoId(request.todo_id),
    idempotency_key: normalizeIdempotencyKey(request.idempotency_key),
    write_scopes: normalizeWriteScopes(request.write_scopes),
    ttl_seconds: normalizeTtl(request.ttl_seconds),
    expected_version: optionalInteger(request.expected_version, "expected_version"),
    authority: {
      handoff_mode: normalizeHandoffMode(authority.handoff_mode),
      registered_agents: decodeRegisteredAgents(authority.registered_agent_candidates),
      todos: decodeTodoFacts(authority.todos),
      todo_projection_error: decodeProjectionError(authority.todo_projection_error),
      source_receipts: receipts,
    },
  };
}

function taskLeaseDirectory(request: AcquireRequest): string {
  return join(request.runtime_root, "goals", request.goal_id, "task-leases");
}

function taskLeasePath(request: AcquireRequest): string {
  return join(taskLeaseDirectory(request), `${request.todo_id}.json`);
}

function taskLeaseLockPath(request: AcquireRequest): string {
  return join(taskLeaseDirectory(request), ".task-leases");
}

function executionContext(value: unknown): ExecutionContext {
  const context: ExecutionContext = { effectId: null, leasePath: null };
  let request: JsonObject;
  try {
    request = requireJsonObject(value, "task lease acquire request");
  } catch {
    return context;
  }
  let runtimeRoot: string;
  let goalId: string;
  let todoId: string;
  try {
    runtimeRoot = stringValue(request.runtime_root, "runtime_root");
    goalId = normalizeGoalId(request.goal_id);
    todoId = normalizeTodoId(request.todo_id);
    context.leasePath = join(
      runtimeRoot,
      "goals",
      goalId,
      "task-leases",
      `${todoId}.json`,
    );
  } catch {
    return context;
  }
  try {
    context.effectId = settlementIdentity({
      goal_id: goalId,
      agent_id: normalizeOwner(request.owner),
      todo_id: todoId,
      turn_instance_id: normalizeIdempotencyKey(request.idempotency_key),
    }).effect_id;
  } catch {
    // An invalid settlement identity has no effect id. The CLI can still
    // report the deterministic lease path for a valid goal/work-item pair.
  }
  return context;
}

function asLeaseRecord(value: unknown, path: string): LeaseRecord {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TaskLeaseAcquireError(
      `lease file must contain an object: ${path}`,
      "corrupt_lease",
      { lease_path: path },
    );
  }
  return value as LeaseRecord;
}

async function readLease(path: string): Promise<LeaseRecord | null> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  try {
    return asLeaseRecord(JSON.parse(text), path);
  } catch (error) {
    if (error instanceof TaskLeaseAcquireError) throw error;
    throw new TaskLeaseAcquireError(
      `lease file is not valid JSON: ${path}`,
      "corrupt_lease",
      { lease_path: path, error: String(error) },
    );
  }
}

function leaseInteger(
  lease: LeaseRecord | null,
  field: "version" | "lease_epoch" | "acquire_ttl_seconds",
): number | null {
  const raw = lease?.[field];
  if (raw === null || raw === undefined) return null;
  let number = Number.NaN;
  if (typeof raw === "number") {
    number = raw;
  } else if (typeof raw === "string" && /^-?\d+$/u.test(raw)) {
    number = Number(raw);
  }
  const positive = field === "lease_epoch";
  const nonNegative = field === "version";
  if (
    typeof raw === "boolean" || !Number.isSafeInteger(number) ||
    (positive && number <= 0) || (nonNegative && number < 0)
  ) {
    let message = "lease acquire_ttl_seconds must be an integer";
    if (field === "lease_epoch") {
      message = "lease epoch must be a positive integer";
    } else if (field === "version") {
      message = "lease version must be a non-negative integer";
    }
    throw new TaskLeaseAcquireError(message, "corrupt_lease", { [field]: raw ?? null });
  }
  return number;
}

function leaseVersion(lease: LeaseRecord | null): number {
  return leaseInteger(lease, "version") ?? 0;
}

function leaseEpoch(lease: LeaseRecord | null): number {
  if (lease === null) return 0;
  return leaseInteger(lease, "lease_epoch") ?? 1;
}

function parseLeaseTimestamp(value: string): Date | null {
  let text = value.trim().replace(/z$/u, "Z");
  if (!text) return null;
  const hasTime = /[T ]\d{2}:\d{2}/u.test(text);
  if (hasTime) text = text.replace(/([+-]\d{2})$/u, "$1:00");
  const hasTimezone = /(?:Z|[+-]\d{2}(?::?\d{2})?)$/u.test(text);
  const parsed = new Date(hasTime && !hasTimezone ? `${text}Z` : text);
  return Number.isNaN(parsed.valueOf()) ? null : parsed;
}

function leaseIsActive(lease: LeaseRecord | null, at: Date): boolean {
  if (
    lease?.schema_version !== TASK_LEASE_SCHEMA_VERSION ||
    lease.status !== "active"
  ) {
    return false;
  }
  if (typeof lease.expires_at !== "string") return false;
  const expiresAt = parseLeaseTimestamp(lease.expires_at);
  return expiresAt !== null && expiresAt.valueOf() > at.valueOf();
}

function utcIsoformat(value: Date): string {
  return value.toISOString().replace(/\.\d{3}Z$/u, "Z");
}

function ownerRejection(
  todo: TodoFact | undefined,
  owner: string | null,
  registeredAgents: readonly string[],
): string | null {
  if (todo === undefined) return "todo_not_found";
  if (todo.status !== "open") return "todo_not_open";
  if (owner === null) return "invalid_owner";
  if (!registeredAgents.includes(owner)) return "owner_not_registered";
  if (todo.excluded_agents.includes(owner)) return "owner_excluded_from_todo";
  if (todo.claimed_by && todo.claimed_by !== owner) {
    return "owner_conflicts_with_claim";
  }
  return null;
}

function ownerFailure(
  code: string,
  request: AcquireRequest,
  todo: TodoFact | undefined,
): TaskLeaseAcquireError {
  let message: string;
  const detail: JsonObject = { effective: false, reason: code };
  if (code === "todo_not_found") {
    message = "todo is missing from the canonical projection";
  } else if (code === "todo_not_open") {
    detail.todo_status = todo?.status || "unknown";
    message = `task lease requires an open todo; '${request.todo_id}' is '${detail.todo_status}'`;
  } else if (code === "owner_excluded_from_todo") {
    detail.excluded_agents = [...(todo?.excluded_agents ?? [])];
    message = `task lease owner '${request.owner}' is excluded from todo '${request.todo_id}'`;
  } else if (code === "owner_conflicts_with_claim") {
    detail.claimed_by = todo?.claimed_by ?? null;
    message = `task lease owner '${request.owner}' conflicts with todo claim '${todo?.claimed_by}'`;
  } else {
    message = `task lease owner '${request.owner}' is not registered for goal '${request.goal_id}'`;
  }
  return new TaskLeaseAcquireError(message, code, {
    goal_id: request.goal_id,
    todo_id: request.todo_id,
    owner: request.owner,
    ...detail,
  });
}

function classMatch(
  pattern: string,
  start: number,
  value: string,
): { end: number; matches: boolean } | null {
  let end = start + 1;
  if (pattern[end] === "!") end += 1;
  if (pattern[end] === "]") end += 1;
  end = pattern.indexOf("]", end);
  if (end < 0) return null;
  let body = pattern.slice(start + 1, end);
  const negated = body.startsWith("!");
  if (negated) body = body.slice(1);
  let matches = false;
  for (let index = 0; index < body.length; index += 1) {
    if (index + 2 < body.length && body[index + 1] === "-") {
      if (body[index] <= value && value <= body[index + 2]) matches = true;
      index += 2;
    } else if (body[index] === value) {
      matches = true;
    }
  }
  return { end, matches: negated ? !matches : matches };
}

function fnmatchcase(value: string, pattern: string): boolean {
  const memo = new Map<string, boolean>();
  const match = (valueIndex: number, patternIndex: number): boolean => {
    const key = `${valueIndex}:${patternIndex}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    let result: boolean;
    if (patternIndex === pattern.length) {
      result = valueIndex === value.length;
    } else if (pattern[patternIndex] === "*") {
      result = match(valueIndex, patternIndex + 1) ||
        (valueIndex < value.length && match(valueIndex + 1, patternIndex));
    } else if (valueIndex === value.length) {
      result = false;
    } else if (pattern[patternIndex] === "?") {
      result = match(valueIndex + 1, patternIndex + 1);
    } else if (pattern[patternIndex] === "[") {
      const characterClass = classMatch(pattern, patternIndex, value[valueIndex]);
      result = characterClass === null
        ? value[valueIndex] === "[" && match(valueIndex + 1, patternIndex + 1)
        : characterClass.matches && match(valueIndex + 1, characterClass.end + 1);
    } else {
      result = value[valueIndex] === pattern[patternIndex] &&
        match(valueIndex + 1, patternIndex + 1);
    }
    memo.set(key, result);
    return result;
  };
  return match(0, 0);
}

function scopeLiteralPrefix(scope: string): string {
  const indexes = ["*", "?", "["]
    .map((token) => scope.indexOf(token))
    .filter((index) => index >= 0);
  return indexes.length > 0 ? scope.slice(0, Math.min(...indexes)) : scope;
}

function scopePairOverlaps(left: string, right: string): boolean {
  if (left === right) return true;
  if (["*", "**", "./"].includes(left) || ["*", "**", "./"].includes(right)) {
    return true;
  }
  const leftGlob = ["*", "?", "["].some((token) => left.includes(token));
  const rightGlob = ["*", "?", "["].some((token) => right.includes(token));
  if (leftGlob && !rightGlob) {
    const prefix = scopeLiteralPrefix(left);
    return fnmatchcase(right, left) ||
      (prefix.endsWith("/") && right.replace(/\/$/u, "") === prefix.replace(/\/$/u, ""));
  }
  if (rightGlob && !leftGlob) {
    const prefix = scopeLiteralPrefix(right);
    return fnmatchcase(left, right) ||
      (prefix.endsWith("/") && left.replace(/\/$/u, "") === prefix.replace(/\/$/u, ""));
  }
  if (leftGlob && rightGlob) {
    const leftPrefix = scopeLiteralPrefix(left);
    const rightPrefix = scopeLiteralPrefix(right);
    return !leftPrefix || !rightPrefix || leftPrefix.startsWith(rightPrefix) ||
      rightPrefix.startsWith(leftPrefix);
  }
  const leftRoot = left.replace(/\/$/u, "");
  const rightRoot = right.replace(/\/$/u, "");
  return (left.endsWith("/") && right.startsWith(`${leftRoot}/`)) ||
    (right.endsWith("/") && left.startsWith(`${rightRoot}/`));
}

function writeScopesOverlap(left: readonly string[], right: readonly string[]): boolean {
  if (left.length === 0 || right.length === 0) return false;
  return left.some((a) => right.some((b) => scopePairOverlaps(a, b)));
}

async function currentSourceReceipt(receipt: SourceReceipt): Promise<SourceReceipt> {
  try {
    const bytes = await readFile(receipt.path);
    return {
      source_id: receipt.source_id,
      path: receipt.path,
      state: "file",
      sha256: createHash("sha256").update(bytes).digest("hex"),
    };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { source_id: receipt.source_id, path: receipt.path, state: "missing", sha256: null };
    }
    throw error;
  }
}

async function revalidateAuthoritySources(receipts: readonly SourceReceipt[]): Promise<void> {
  const changed: string[] = [];
  const actuals = await Promise.all(receipts.map(currentSourceReceipt));
  for (let index = 0; index < receipts.length; index += 1) {
    const expected = receipts[index];
    const actual = actuals[index];
    if (actual.state !== expected.state || actual.sha256 !== expected.sha256) {
      changed.push(expected.source_id);
    }
  }
  if (changed.length > 0) {
    throw new TaskLeaseAcquireError(
      "task-lease authority sources changed before acquire commit; retry with a fresh projection",
      "authority_source_changed",
      { changed_sources: changed },
    );
  }
}

async function leaseFiles(directory: string): Promise<string[]> {
  try {
    return (await readdir(directory))
      .filter((name) => /^todo_[a-z0-9_-]{3,64}\.json$/u.test(name))
      .sort((left, right) => left.localeCompare(right))
      .map((name) => join(directory, name));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}

function conflictPayload(
  lease: LeaseRecord,
  path: string,
): JsonObject {
  return {
    todo_id: lease.todo_id ?? null,
    owner: lease.owner ?? null,
    expires_at: lease.expires_at ?? null,
    version: lease.version ?? null,
    lease_epoch: leaseEpoch(lease),
    write_scopes: lease.write_scopes || [],
    lease_path: path,
  };
}

async function activeConflicts(
  request: AcquireRequest,
  at: Date,
): Promise<JsonObject[]> {
  const conflicts: JsonObject[] = [];
  for (const path of await leaseFiles(taskLeaseDirectory(request))) {
    const lease = await readLease(path);
    if (!leaseIsActive(lease, at) || lease === null) continue;
    const leaseTodoId = normalizeTodoId(lease.todo_id, "lease.todo_id");
    if (leaseTodoId === request.todo_id) continue;
    const leaseOwner = normalizeAgent(lease.owner);
    if (
      ownerRejection(
        request.authority.todos.get(leaseTodoId),
        leaseOwner,
        request.authority.registered_agents,
      ) !== null
    ) {
      continue;
    }
    if (
      writeScopesOverlap(
        request.write_scopes,
        normalizeWriteScopes(lease.write_scopes),
      )
    ) {
      conflicts.push(conflictPayload(lease, path));
    }
  }
  return conflicts;
}

function transitionError(
  code: string,
  request: AcquireRequest,
  lease: LeaseRecord | null,
  leasePath: string,
  conflicts: readonly JsonObject[] = [],
  idempotencyReuseKind: "retired" | "acquire_parameters" = "acquire_parameters",
): TaskLeaseAcquireError {
  if (code === "version_mismatch") {
    const actual = leaseVersion(lease);
    return new TaskLeaseAcquireError(
      `lease version mismatch: expected ${request.expected_version}, got ${actual}`,
      code,
      { expected_version: request.expected_version, actual_version: actual },
    );
  }
  if (code === "idempotency_key_reuse") {
    if (idempotencyReuseKind === "retired") {
      return new TaskLeaseAcquireError(
        "idempotency key belongs to an expired or released lease generation; " +
          "a new execution must use a new key",
        code,
        { lease, lease_path: leasePath },
      );
    }
    return new TaskLeaseAcquireError(
      "idempotency key was reused with different acquire parameters",
      code,
      {
        lease,
        lease_path: leasePath,
        requested_write_scopes: [...request.write_scopes],
        requested_ttl_seconds: request.ttl_seconds,
      },
    );
  }
  if (code === "todo_lease_conflict") {
    return new TaskLeaseAcquireError(
      "todo already has an active lease",
      code,
      { lease, lease_path: leasePath },
    );
  }
  if (code === "write_scope_conflict") {
    return new TaskLeaseAcquireError(
      "write scope overlaps another active task lease",
      code,
      { conflicts: [...conflicts] },
    );
  }
  return new TaskLeaseAcquireError(
    `task lease acquire rejected by authority core: ${code}`,
    code,
    { lease, lease_path: leasePath },
  );
}

function equalScopeSets(left: readonly string[], right: readonly string[]): boolean {
  const a = [...new Set(left)].sort((first, second) => first.localeCompare(second));
  const b = [...new Set(right)].sort((first, second) => first.localeCompare(second));
  return a.length === b.length && a.every((value, index) => value === b[index]);
}

function successEnvelope(
  request: AcquireRequest,
  lease: LeaseRecord,
  leasePath: string,
  effectId: string,
  idempotent: boolean,
): TaskLeaseAcquireEnvelope {
  const status = idempotent ? "idempotent" : "committed";
  return {
    ok: true,
    schema_version: TASK_LEASE_SCHEMA_VERSION,
    action: "acquire",
    acquired: !idempotent,
    idempotent,
    lease,
    lease_path: leasePath,
    settlement: {
      effect_id: effectId,
      receipts: [
        { step: "validation", status, effect_id: effectId },
        { step: "durable_writeback", status, effect_id: effectId },
      ],
    },
  };
}

const INVALID_IDENTITY_CODES = new Set([
  "invalid_goal_id",
  "invalid_todo_id",
  "invalid_owner",
  "invalid_idempotency_key",
  "invalid_ttl",
  "idempotency_key_reuse",
]);
const PERMISSION_DENIED_CODES = new Set([
  "owner_not_registered",
  "todo_not_found",
  "todo_not_open",
  "owner_excluded_from_todo",
  "owner_conflicts_with_claim",
]);
const VALIDATION_FAILURE_CODES = new Set([
  "invalid_goal_id",
  "invalid_todo_id",
  "invalid_owner",
  "invalid_idempotency_key",
  ...PERMISSION_DENIED_CODES,
  "todo_lease_conflict",
  "write_scope_conflict",
  "authority_source_changed",
]);

function failureKind(code: string): string {
  if (INVALID_IDENTITY_CODES.has(code)) return "invalid_identity";
  if (PERMISSION_DENIED_CODES.has(code)) return "permission_denied";
  return "writeback_rejected";
}

function failureEnvelope(
  failure: TaskLeaseFailure,
  context: ExecutionContext,
): TaskLeaseAcquireEnvelope {
  const step = VALIDATION_FAILURE_CODES.has(failure.code)
    ? "validation"
    : "durable_writeback";
  const kind = failureKind(failure.code);
  const receipts = step === "validation" || context.effectId === null
    ? []
    : [{ step: "validation", status: "committed", effect_id: context.effectId }];
  return {
    ok: false,
    schema_version: TASK_LEASE_SCHEMA_VERSION,
    action: "acquire",
    error: failure.message,
    error_code: failure.code,
    ...(context.leasePath === null ? {} : { lease_path: context.leasePath }),
    ...failure.payload,
    settlement: {
      effect_id: receipts.length > 0 ? context.effectId : null,
      receipts,
      failure: { step, kind, code: failure.code },
    },
  };
}

function validateAcquireAuthority(request: AcquireRequest): TodoFact {
  if (request.authority.handoff_mode === "soft_claim") {
    throw new TaskLeaseAcquireError(
      "goal handoff mode 'soft_claim' forbids task lease acquire; " +
        "release and inspect remain available for legacy leftovers",
      "handoff_mode_forbids_lease",
      {
        goal_id: request.goal_id,
        todo_id: request.todo_id,
        action: "acquire",
        handoff_mode: request.authority.handoff_mode,
      },
    );
  }
  if (!request.authority.registered_agents.includes(request.owner)) {
    const registered = request.authority.registered_agents;
    const message = registered.length === 0
      ? `task lease owner='${request.owner}' cannot be used because goal ` +
        `'${request.goal_id}' has no coordination.registered_agents list. ` +
        "Register this peer identity first: loopx configure-goal --goal-id " +
        `${request.goal_id} --registered-agent ${request.owner} --execute`
      : `task lease owner='${request.owner}' is not registered for goal ` +
        `'${request.goal_id}'; registered_agents=${registered.join(", ")}`;
    throw new TaskLeaseAcquireError(message, "owner_not_registered", {
      goal_id: request.goal_id,
      todo_id: request.todo_id,
      owner: request.owner,
    });
  }
  if (request.authority.todo_projection_error !== null) {
    throw new TaskLeaseAcquireError(
      request.authority.todo_projection_error.message,
      request.authority.todo_projection_error.code,
      request.authority.todo_projection_error.payload,
    );
  }
  const todo = request.authority.todos.get(request.todo_id);
  const rejectionCode = ownerRejection(
    todo,
    request.owner,
    request.authority.registered_agents,
  );
  if (rejectionCode !== null) {
    throw ownerFailure(rejectionCode, request, todo);
  }
  return todo as TodoFact;
}

function acquireEffectId(request: AcquireRequest): string {
  return settlementIdentity({
    goal_id: request.goal_id,
    agent_id: request.owner,
    todo_id: request.todo_id,
    turn_instance_id: request.idempotency_key,
  }).effect_id;
}

function replayExistingAcquire(
  request: AcquireRequest,
  existing: LeaseRecord,
  leasePath: string,
): TaskLeaseAcquireEnvelope {
  const existingTtl = leaseInteger(existing, "acquire_ttl_seconds");
  const matches = equalScopeSets(
    normalizeWriteScopes(existing.write_scopes),
    request.write_scopes,
  ) && (existingTtl === null || existingTtl === request.ttl_seconds);
  if (!matches) {
    throw transitionError(
      "idempotency_key_reuse",
      request,
      existing,
      leasePath,
      [],
      "acquire_parameters",
    );
  }
  return successEnvelope(
    request,
    existing,
    leasePath,
    acquireEffectId(request),
    true,
  );
}

function resolveExistingAcquire(
  request: AcquireRequest,
  todo: TodoFact,
  existing: LeaseRecord | null,
  leasePath: string,
  version: number,
  active: boolean,
): TaskLeaseAcquireEnvelope | null {
  if (request.expected_version !== null && request.expected_version !== version) {
    throw transitionError("version_mismatch", request, existing, leasePath);
  }
  const existingEffective = existing !== null && active && ownerRejection(
    todo,
    normalizeAgent(existing.owner),
    request.authority.registered_agents,
  ) === null;
  if (!existingEffective || existing === null) {
    if (existing !== null && existing.idempotency_key === request.idempotency_key) {
      throw transitionError(
        "idempotency_key_reuse",
        request,
        existing,
        leasePath,
        [],
        active ? "acquire_parameters" : "retired",
      );
    }
    return null;
  }
  if (
    normalizeAgent(existing.owner) !== request.owner ||
    existing.idempotency_key !== request.idempotency_key
  ) {
    throw transitionError("todo_lease_conflict", request, existing, leasePath);
  }
  return replayExistingAcquire(request, existing, leasePath);
}

async function commitAcquire(
  request: AcquireRequest,
  dependencies: TaskLeaseAcquireDependencies,
): Promise<TaskLeaseAcquireEnvelope> {
  const at = (dependencies.now ?? (() => new Date()))();
  if (Number.isNaN(at.valueOf())) {
    throw new EffectRuntimeRequestError("task-lease acquire clock returned an invalid date");
  }
  await revalidateAuthoritySources(request.authority.source_receipts);
  const todo = validateAcquireAuthority(request);

  const leasePath = taskLeasePath(request);
  const existing = await readLease(leasePath);
  const version = leaseVersion(existing);
  const epoch = leaseEpoch(existing);
  const active = leaseIsActive(existing, at);
  const replay = resolveExistingAcquire(
    request,
    todo,
    existing,
    leasePath,
    version,
    active,
  );
  if (replay !== null) return replay;
  const conflicts = await activeConflicts(request, at);
  if (conflicts.length > 0) {
    throw transitionError("write_scope_conflict", request, existing, leasePath, conflicts);
  }

  const acquiredAt = utcIsoformat(at);
  const lease: LeaseRecord = {
    schema_version: TASK_LEASE_SCHEMA_VERSION,
    goal_id: request.goal_id,
    todo_id: request.todo_id,
    owner: request.owner,
    idempotency_key: request.idempotency_key,
    write_scopes: [...request.write_scopes],
    acquire_ttl_seconds: request.ttl_seconds,
    version: version + 1,
    lease_epoch: epoch + 1,
    acquired_at: acquiredAt,
    updated_at: acquiredAt,
    expires_at: utcIsoformat(
      new Date(at.valueOf() + request.ttl_seconds * 1_000),
    ),
    status: "active",
  };
  await dependencies.beforeWrite?.(lease);
  await revalidateAuthoritySources(request.authority.source_receipts);
  await atomicWriteJson(leasePath, lease);
  return successEnvelope(request, lease, leasePath, acquireEffectId(request), false);
}

export async function executeTaskLeaseAcquire(
  value: unknown,
  dependencies: TaskLeaseAcquireDependencies = {},
): Promise<TaskLeaseAcquireEnvelope> {
  let request: AcquireRequest;
  const context = executionContext(value);
  try {
    request = decodeRequest(value);
  } catch (error) {
    if (error instanceof TaskLeaseAcquireError) {
      return failureEnvelope(
        { code: error.code, message: error.message, payload: error.payload },
        context,
      );
    }
    throw error;
  }

  try {
    return await withFileMutationLock(
      taskLeaseLockPath(request),
      () => commitAcquire(request, dependencies),
    );
  } catch (error) {
    if (error instanceof TaskLeaseAcquireError) {
      return failureEnvelope(
        { code: error.code, message: error.message, payload: error.payload },
        context,
      );
    }
    if (error instanceof EffectRuntimeLockTimeoutError) {
      return failureEnvelope(
        {
          code: "lock_acquire_timeout",
          message: "task lease mutation lock timed out",
          payload: {},
        },
        context,
      );
    }
    throw error;
  }
}
