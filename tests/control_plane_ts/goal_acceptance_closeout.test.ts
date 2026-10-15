import assert from "node:assert/strict";
import test from "node:test";
import type {JsonObject} from "../../loopx/control_plane/effect_program.ts";
import {canonicalAuthoritySha256} from "../../loopx/control_plane/coordination/authority_store_codec.ts";
import {coordinationTodoReadModel} from "../../loopx/control_plane/coordination/coordination_projection.ts";
import {acceptanceWorkGuard, goalAcceptanceTodoDigest, goalAcceptanceWorkDigest,
  normalizeGoalAcceptanceDocument, projectGoalAcceptance} from "../../loopx/control_plane/goals/acceptance_contract.ts";
import {projectReplanSemantics} from "../../loopx/control_plane/work_items/replan_semantics.ts";

function source(verification: "unverified" | "partial" | "failed" | "stale" | "accepted",
  scope: "all_advancement" | "selected_work" | "legacy" = "all_advancement", open = false): JsonObject {
  const todo = {schema_version: "todo_domain_record_v0", todo_id: "todo_local", role: "agent", task_class: "advancement_task",
    status: open ? "open" : "done", done: !open, archive_state: "active", text: "Local work", no_followup: !open};
  const document = normalizeGoalAcceptanceDocument({objective: "Deliver both outcomes", non_goals: [],
    ...(scope === "legacy" ? {} : {scope: scope === "selected_work"
      ? {kind: scope, todo_ids: ["todo_local"]} : {kind: scope}}),
    criteria: ["local", "remaining"].map(id => ({id, description: id, validation_argv: ["true"]})),
    bindings: [{todo_id: "todo_local", criterion_ids: ["local"]}]});
  const revision = verification === "stale" ? 2 : 1;
  const state: JsonObject = {schema_version: "loopx_goal_acceptance_v0", enabled: true,
    revision, digest: canonicalAuthoritySha256(document), document,
    bindings: [{todo_id: "todo_local", todo_semantic_digest: goalAcceptanceTodoDigest(todo),
      revision, criterion_ids: ["local"], confirmed_by: "owner"}], verification: null};
  const head: JsonObject = {goal_id: "goal-a", handoff_mode: "soft_claim", todos: [todo], leases: [],
    todo_read_model: coordinationTodoReadModel([todo], "loopx_todo_domain_read_record_v0"), goal_acceptance: state};
  if (verification !== "unverified") state.verification = {operation_id: "verified", contract_revision: 1,
    contract_digest: state.digest, work_digest: goalAcceptanceWorkDigest(head, "goal-a", document.scope),
    todo_id: verification === "partial" ? "todo_local" : null,
    results: (verification === "partial" ? ["local"] : ["local", "remaining"]).map(criterion_id => ({criterion_id,
      passed: !(verification === "failed" && criterion_id === "remaining"),
      exit_code: verification === "failed" && criterion_id === "remaining" ? 1 : 0}))};
  return head;
}

for (const status of ["unverified", "partial", "failed", "stale"] as const) {
  test(`${status}: closed local work retains every Goal criterion and a canonical verification gap`, () => {
    const head = source(status);
    const before = JSON.stringify(head);
    const result = projectGoalAcceptance(head, "goal-a");
    assert.equal(result.status, status);
    const gap = result.verification_gap as JsonObject;
    assert.equal(gap.canonical_verification_required, true);
    assert.deepEqual(gap.criterion_ids, ["local", "remaining"]);
    assert.equal(JSON.stringify(head), before, "projection cannot rewrite contract or historical evidence");
    assert.equal(projectGoalAcceptance(head, "goal-a").verification_gap != null, true);
  });
}

test("current full verification clears the gap; a work change invalidates that success", () => {
  const head = source("accepted");
  assert.equal(projectGoalAcceptance(head, "goal-a").verification_gap, undefined);
  const records = head.todos as JsonObject[];
  records[0].text = "Changed required work";
  head.todo_read_model = coordinationTodoReadModel(records, "loopx_todo_domain_read_record_v0");
  const changed = projectGoalAcceptance(head, "goal-a");
  assert.equal(changed.status, "stale");
  assert.deepEqual((changed.verification_gap as JsonObject).criterion_ids, ["local", "remaining"]);
});

test("local scope, runnable work, disabled and absent contracts retain their existing boundary", () => {
  for (const state of ["unverified", "partial", "failed", "stale", "accepted"] as const) {
    assert.equal(projectGoalAcceptance(source(state, "selected_work"), "goal-a").verification_gap, undefined);
  }
  const open = source("unverified", "all_advancement", true);
  assert.equal(projectGoalAcceptance(open, "goal-a").verification_gap, undefined);
  assert.equal(acceptanceWorkGuard(open, "goal-a", "todo_local")?.allowed, true);
  const off = source("unverified");
  (off.goal_acceptance as JsonObject).enabled = false;
  assert.deepEqual(projectGoalAcceptance(off, "goal-a"), {enabled: false});
  delete off.goal_acceptance;
  assert.deepEqual(projectGoalAcceptance(off, "goal-a"), {enabled: false});
  assert.ok(projectGoalAcceptance(source("unverified", "legacy"), "goal-a").verification_gap);
});

test("a fresh vision ACK cannot satisfy a canonical verification gap", () => {
  const ordinary = {kind: "vision_acceptance_gap", generated_at: "2026-01-01T00:00:00Z"};
  const request = {operation: "vision_ack", acceptance_gaps: [ordinary], ack: {recorded: true,
    generated_at: "2026-01-01T00:01:00Z", semantic_delta: {accepted: true, outcomes: ["fresh_vision_path_outcome"]}}};
  assert.equal(projectReplanSemantics(request).acknowledged, true);
  assert.equal(projectReplanSemantics({...request,
    acceptance_gaps: [{...ordinary, canonical_verification_required: true}]}).acknowledged, false);
});

test("verification gap identity distinguishes Goals and Goal instances with identical criteria", () => {
  const first = source("unverified");
  const other = structuredClone(first);
  other.goal_id = "goal-b";
  const fingerprint = (head: JsonObject) =>
    (projectGoalAcceptance(head, String(head.goal_id)).verification_gap as JsonObject).frontier_revision;
  assert.notEqual(fingerprint(first), fingerprint(other));
  const instances = ["a", "b"].map(suffix => {
    const head = source("unverified");
    const goal_ref = {goal_id: "goal-a", goal_instance_id: "ginst_" + suffix.repeat(32)};
    head.goal_acceptance_lifecycle = {schema_version: "loopx_goal_acceptance_lifecycle_v0", state: "active", goal_ref};
    Object.assign(head.goal_acceptance as JsonObject,
      {schema_version: "loopx_goal_acceptance_v1", owner_goal_ref: goal_ref});
    return fingerprint(head);
  });
  assert.notEqual(instances[0], instances[1]);
});

test("verification gap identity follows changed evidence, not repeated operation IDs", () => {
  const head = source("failed");
  const fingerprint = () => (projectGoalAcceptance(head, "goal-a").verification_gap as JsonObject).frontier_revision;
  const original = fingerprint();
  const receipt = (head.goal_acceptance as JsonObject).verification as JsonObject;
  receipt.operation_id = "another-identical-check";
  assert.equal(fingerprint(), original);
  receipt.results = [{criterion_id: "local", passed: false, exit_code: 1},
    {criterion_id: "remaining", passed: true, exit_code: 0}];
  assert.notEqual(fingerprint(), original, "a different failed criterion is new evidence");
});
