import assert from "node:assert/strict";
import test from "node:test";
import {buildModuleKnowledgeGraph, buildTurnContextContributionInput, comparePublicInterfaces,
  extractTypeScriptExportsAndImports, routeRepositoryContext} from "../../loopx/control_plane/capabilities/repository_context/index.ts";
import {validateTurnContextContribution} from "../../loopx/control_plane/turn_driver/capability_context.ts";

const specifications = [
  {modulePath: "api/orders", specPath: "api/orders/SPEC.md", content: `# Orders API\n## Responsibilities\n- Accept order commands and expose order reads.\n## Public Interfaces\n- export function createOrder(input: CreateOrderInput): Order\n## Allowed Dependencies\n- services/orders\n## Invariants\n- Validate every command before dispatch.`},
  {modulePath: "services/orders", specPath: "services/orders/SPEC.md", content: `# Orders Service\n## Responsibilities\n- Apply order changes and persist order state.\n## Public Interfaces\n- export function createOrder(input: CreateOrderInput): Order\n## Allowed Dependencies\n- services/audit\n## Invariants\n- Emit an audit event for each accepted change.`},
  {modulePath: "services/audit", specPath: "services/audit/SPEC.md", content: `# Audit Service\n## Responsibilities\n- Record immutable order activity.\n## Public Interfaces\n- export function recordOrderEvent(event: OrderEvent): void\n## Allowed Dependencies\n## Invariants\n- Existing events are never overwritten.`},
  {modulePath: "analytics/reporting", specPath: "analytics/reporting/SPEC.md", content: `# Reporting\n## Responsibilities\n- Build read-only order reports.\n## Public Interfaces\n- export function buildOrderReport(): Report\n## Allowed Dependencies\n- services/orders\n## Invariants\n- Reports never mutate order state.`},
];
const graph = buildModuleKnowledgeGraph(specifications);
const modules = graph.modules;
const sources: Record<string, string> = {
  "api/orders": `import {createOrder as createServiceOrder} from "../../services/orders/index.ts";\nexport function createOrder(input: CreateOrderInput): Order { return createServiceOrder(input); }`,
  "services/orders": `import {recordOrderEvent} from "../audit/index.ts";\nexport function createOrder(input: CreateOrderInput): Order { recordOrderEvent({input}); return {input}; }`,
  "services/audit": `export function recordOrderEvent(event: OrderEvent): void { void event; }`,
  "analytics/reporting": `import {createOrder} from "../../services/orders/index.ts";\nexport function buildOrderReport(): Report { return {count: 0}; }`,
};

test("module specs produce a four-module knowledge graph with declared dependency edges", () => {
  assert.equal(modules.length, 4);
  assert.ok(modules.every(module => module.responsibilities.length > 0 && module.publicInterfaces.length > 0 &&
    module.invariants.length > 0));
  assert.ok(graph.edges.some(edge => edge.from === "api/orders" && edge.to === "services/orders"));
});

test("routing follows write ownership and declared dependencies, marks exclusions and stale modules", () => {
  const route = routeRepositoryContext(graph, {writeScope: ["api/orders/controller.ts"],
    staleModulePaths: ["api/orders"], maxBytes: 16_384});
  const selected = route.selectedModules;
  assert.equal(selected.find(module => module.modulePath === "api/orders")?.selectionReason, "owning_write_scope");
  assert.equal(selected.find(module => module.modulePath === "services/orders")?.selectionReason, "direct_dependency");
  assert.deepEqual(selected.map(module => module.modulePath), ["api/orders", "services/orders"]);
  assert.ok(route.omittedModules.some(module => module.modulePath === "services/audit" && module.reason === "outside_write_scope"));
  assert.ok(route.omittedModules.some(module => module.modulePath === "analytics/reporting" && module.reason === "outside_write_scope"));
  assert.equal(selected.find(module => module.modulePath === "api/orders")?.stale, true);
  const constrained = routeRepositoryContext(graph, {writeScope: ["api/orders/controller.ts"], maxBytes: 1});
  assert.ok(constrained.omittedModules.some(module => module.reason === "budget_exceeded"));
});

test("dependency depth selects shortest-hop context and rejects invalid requests", () => {
  const request = {writeScope: ["api/orders/controller.ts"], maxBytes: 16_384};
  const transitive = routeRepositoryContext(graph, {...request, maxDependencyDepth: 2});
  assert.deepEqual(transitive.selectedModules.map(({modulePath, selectionReason}) => ({modulePath, selectionReason})), [
    {modulePath: "api/orders", selectionReason: "owning_write_scope"},
    {modulePath: "services/orders", selectionReason: "direct_dependency"},
    {modulePath: "services/audit", selectionReason: "transitive_dependency"},
  ]);
  assert.deepEqual(transitive.omittedModules, [{modulePath: "analytics/reporting", reason: "outside_write_scope"}]);

  const ownerOnly = routeRepositoryContext(graph, {...request, maxDependencyDepth: 0});
  assert.deepEqual(ownerOnly.selectedModules.map(({modulePath, selectionReason}) => ({modulePath, selectionReason})), [
    {modulePath: "api/orders", selectionReason: "owning_write_scope"},
  ]);
  assert.throws(() => routeRepositoryContext(graph, {...request, maxDependencyDepth: -1}), Error);
  assert.throws(() => routeRepositoryContext(graph, {...request, maxDependencyDepth: 1,
    includeDirectDependencies: false}), Error);
});

test("contribution input is accepted by the host turn-context validator", () => {
  const route = routeRepositoryContext(graph, {writeScope: ["api/orders/controller.ts"], maxBytes: 16_384});
  const contribution = buildTurnContextContributionInput(route, {goalId: "goal-orders", agentId: "agent-orders",
    turnEnvelope: {goal_id: "goal-orders", agent_id: "agent-orders", ok: true, should_run: true,
      mode: "should-run", effective_action: "normal_run", interaction_contract: {
        schema_version: "loopx_interaction_contract_v0", mode: "bounded_delivery",
        user_channel: {action_required: false, notify: "DONT_NOTIFY"},
        agent_channel: {must_attempt: true, delivery_allowed: true, quiet_noop_allowed: false}, cli_channel: {}},
      agent_identity: {agent_id: "agent-orders", registered: true},
      heartbeat_receipt: {status: "committed", turn_instance_id: "fixture-turn"},
      goal_boundary: {write_scope: ["api/orders/**"], capabilities: {}}}, hookId: "repository_context_hook",
    capabilityId: "repository_context"});
  assert.ok(validateTurnContextContribution(contribution));
});

test("interface comparison accepts compliant code and gates drift or forbidden imports", () => {
  const apiModule = modules.find(module => module.modulePath === "api/orders")!;
  const compliantFiles = [{filePath: "api/orders/index.ts", content: sources["api/orders"]}];
  const compliant = comparePublicInterfaces(apiModule, compliantFiles);
  assert.equal(compliant.hasDrift, false);
  assert.equal(compliant.requiresGateReview, false);
  assert.deepEqual(compliant.forbiddenImports, []);
  const removed = comparePublicInterfaces(apiModule, [{filePath: "api/orders/index.ts", content: `export function other(): void {}`}]);
  assert.ok(removed.missingExports.length > 0);
  assert.equal(removed.hasDrift, true);
  assert.equal(removed.requiresGateReview, true);
  const added = comparePublicInterfaces(apiModule, [{filePath: "api/orders/index.ts",
    content: `${sources["api/orders"]}\nexport function debugOnly(): void {}`}]);
  assert.ok(added.undeclaredExports.includes("debugOnly"));
  assert.equal(added.hasDrift, true);
  assert.equal(added.requiresGateReview, true);
  const forbidden = comparePublicInterfaces(apiModule, [{filePath: "api/orders/index.ts",
    content: `import {recordOrderEvent} from "../../services/audit/index.ts";\n${sources["api/orders"]}`}]);
  assert.ok(forbidden.forbiddenImports.length > 0);
  assert.equal(forbidden.hasDrift, true);
  assert.equal(forbidden.requiresGateReview, true);
  const parsed = extractTypeScriptExportsAndImports(sources["api/orders"]);
  assert.ok(parsed.exports.length > 0 && parsed.imports.length > 0);
});
