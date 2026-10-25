import {posix} from "node:path";
import type {JsonObject} from "../../effect_program.ts";
import {validateTurnContextContribution} from "../../turn_driver/capability_context.ts";
import type {ModuleKnowledge, ModuleKnowledgeGraph} from "./module_graph.ts";

export interface RepositoryContextRequest {
  readonly writeScope: readonly string[];
  readonly maxBytes: number;
  readonly includeDirectDependencies?: boolean;
  /** Defaults to one hop, or zero when includeDirectDependencies is false. */
  readonly maxDependencyDepth?: number;
  readonly staleModulePaths?: readonly string[];
}
export interface RoutedModuleSummary extends ModuleKnowledge {
  readonly selectionReason: "owning_write_scope" | "direct_dependency" | "transitive_dependency";
  readonly stale: boolean;
}
export interface OmittedModuleSummary {
  readonly modulePath: string;
  readonly reason: "budget_exceeded" | "outside_write_scope";
}
export interface RepositoryContextPlan {
  readonly selectedModules: readonly RoutedModuleSummary[];
  readonly omittedModules: readonly OmittedModuleSummary[];
  /** UTF-8 bytes of the selected JSON array; no contribution costs zero bytes. */
  readonly totalBytes: number;
  readonly maxBytes: number;
}
function within(path: string, module: string): boolean {
  return module === "." || path === module || path.startsWith(`${module}/`);
}
function normalized(path: string): string {
  const result = posix.normalize(path.replaceAll("\\", "/"));
  if (!path.trim() || posix.isAbsolute(result) || result === ".." || result.startsWith("../")) {
    throw new Error(`Invalid repository path: ${path}`);
  }
  return result.replace(/\/$/, "");
}
export function routeRepositoryContext(graph: ModuleKnowledgeGraph, request: RepositoryContextRequest): RepositoryContextPlan {
  if (!Number.isSafeInteger(request.maxBytes) || request.maxBytes < 0) throw new Error("maxBytes must be a nonnegative safe integer");
  if (request.maxDependencyDepth !== undefined && (!Number.isSafeInteger(request.maxDependencyDepth) || request.maxDependencyDepth < 0)) {
    throw new Error("maxDependencyDepth must be a nonnegative safe integer");
  }
  if (request.includeDirectDependencies === false && request.maxDependencyDepth !== undefined && request.maxDependencyDepth > 0) {
    throw new Error("maxDependencyDepth > 0 conflicts with includeDirectDependencies: false");
  }
  const maxDepth = request.maxDependencyDepth ?? (request.includeDirectDependencies === false ? 0 : 1);
  const owners = new Set<string>();
  for (const entry of request.writeScope) {
    const path = normalized(entry);
    const matching = graph.modules.filter(module => within(path, module.modulePath));
    const longest = matching.sort((a, b) => b.modulePath.length - a.modulePath.length)[0];
    if (longest) owners.add(longest.modulePath);
    // A directory scope also authorizes modules nested beneath that directory.
    for (const module of graph.modules) if (within(module.modulePath, path)) owners.add(module.modulePath);
  }
  const byPath = new Map(graph.modules.map(module => [module.modulePath, module]));
  const depths = new Map([...owners].map(path => [path, 0]));
  let frontier = [...owners];
  for (let depth = 1; depth <= maxDepth && frontier.length; depth++) {
    const next: string[] = [];
    for (const path of frontier) for (const target of byPath.get(path)!.allowedDependencies) {
      if (!byPath.has(target)) throw new Error(`Missing dependency module: ${path} -> ${target}`);
      if (!depths.has(target)) { depths.set(target, depth); next.push(target); }
    }
    frontier = next;
  }
  const stale = new Set((request.staleModulePaths ?? []).map(normalized));
  const ordered = [...graph.modules].sort((a, b) => a.modulePath < b.modulePath ? -1 : a.modulePath > b.modulePath ? 1 : 0);
  const selectedModules: RoutedModuleSummary[] = [];
  const omittedModules: OmittedModuleSummary[] = [];
  for (const module of ordered) if (!depths.has(module.modulePath)) {
    omittedModules.push({modulePath: module.modulePath, reason: "outside_write_scope"});
  }
  // Stable path order within each shortest-hop frontier. Deeper context cannot
  // displace any earlier owning or direct-dependency selection under the budget.
  const candidates = ordered.filter(module => depths.has(module.modulePath))
    .sort((a, b) => depths.get(a.modulePath)! - depths.get(b.modulePath)!);
  for (const module of candidates) {
    const summary: RoutedModuleSummary = {
      modulePath: module.modulePath, specPath: module.specPath, specDigest: module.specDigest,
      responsibilities: module.responsibilities, publicInterfaces: module.publicInterfaces,
      allowedDependencies: module.allowedDependencies, invariants: module.invariants,
      selectionReason: depths.get(module.modulePath) === 0 ? "owning_write_scope"
        : depths.get(module.modulePath) === 1 ? "direct_dependency" : "transitive_dependency",
      stale: stale.has(module.modulePath),
    };
    if (Buffer.byteLength(JSON.stringify([...selectedModules, summary]), "utf8") > request.maxBytes) {
      omittedModules.push({modulePath: module.modulePath, reason: "budget_exceeded"});
    } else selectedModules.push(summary);
  }
  return {selectedModules, omittedModules,
    totalBytes: selectedModules.length ? Buffer.byteLength(JSON.stringify(selectedModules), "utf8") : 0, maxBytes: request.maxBytes};
}

/** Bind advisory knowledge to the existing governing turn; never invent authority. */
export function buildTurnContextContributionInput(plan: RepositoryContextPlan, options: {
  goalId: string; agentId: string; turnEnvelope: Record<string, unknown>;
  hookId?: string; capabilityId?: string;
}): JsonObject {
  const source = {...options.turnEnvelope, goal_id: options.goalId, agent_id: options.agentId};
  for (const [key, expected] of [["goal_id", options.goalId], ["agent_id", options.agentId]] as const) {
    if (!expected.trim() || (options.turnEnvelope[key] !== undefined && options.turnEnvelope[key] !== expected)) {
      throw new Error(`Turn context ${key} mismatch`);
    }
  }
  const input: JsonObject = {
    source,
    registration: {hook_id: options.hookId ?? "repository_context", capability_id: options.capabilityId ?? "repository_context",
      readback_slots: ["repository_context"], max_result_bytes: 65536},
    result: {context_fields: {repository_context: {selectedModules: plan.selectedModules}},
      readback: {repository_context: {omittedModules: plan.omittedModules, totalBytes: plan.totalBytes, maxBytes: plan.maxBytes}},
      instructions: [], result_fields: {}},
  };
  validateTurnContextContribution(input);
  return input;
}
