import {canonicalAuthoritySha256} from "../loopx/control_plane/coordination/authority_store_codec.ts";

/** Synthetic, deterministic inputs; task expectations are authored independently of router output. */
export interface BenchmarkSpec {
  readonly modulePath: string;
  readonly specPath: string;
  readonly content: string;
}
export interface BenchmarkModule extends BenchmarkSpec {
  readonly layer: "api" | "app" | "domain" | "infra" | "shared";
  readonly summary: string;
  readonly publicInterfaces: readonly string[];
  readonly allowedDependencies: readonly string[];
  readonly files: Readonly<Record<string, string>>;
}
export interface RoutingTaskOracle {
  readonly taskId: string;
  readonly category: "single_module" | "single_direct_dep" | "multi_direct_dep" |
    "transitive_dep" | "directory_scope" | "disjoint_scopes";
  readonly taskPrompt: string;
  readonly writeScope: readonly string[];
  readonly requiredModulePaths: readonly string[];
  readonly usefulModulePaths: readonly string[];
  readonly staleModulePaths?: readonly string[];
  readonly rationale: string;
}
export interface BoundaryEvalCase {
  readonly caseId: string;
  readonly category: "compliant" | "missing_export" | "undeclared_export" |
    "syntax_trap_comment_or_string" | "complex_ts_syntax_export" | "forbidden_import" |
    "prefix_trap_import" | "signature_only_limitation";
  readonly modulePath: string;
  readonly declaredInterfaces: readonly string[];
  readonly allowedDependencies: readonly string[];
  readonly files: Readonly<Record<string, string>>;
  readonly expectedExportDrift: boolean;
  readonly expectedForbiddenImport: boolean;
  readonly isSignatureOnlyLimitation: boolean;
  readonly description: string;
}

const M = {
  orders: "src/api/orders_controller", payments: "src/api/payments_controller", webhooks: "src/api/webhooks_controller",
  checkout: "src/app/order_checkout", trap: "src/app/order_audit_trap", orchestrator: "src/app/payment_orchestrator",
  ledger: "src/domain/order_ledger", policy: "src/domain/payment_policy", pricing: "src/domain/pricing_rules",
  repo: "src/infra/postgres_order_repo", stripe: "src/infra/stripe_gateway", outbox: "src/infra/event_outbox",
  money: "src/shared/money", idempotency: "src/shared/idempotency", clock: "src/shared/clock",
} as const;

function specContent(module: Pick<BenchmarkModule, "modulePath" | "summary" | "publicInterfaces" | "allowedDependencies">,
  sourceDigest: string): string {
  return [`# ${module.modulePath}`, "", "## Summary", module.summary, "", "## Public Interface",
    ...module.publicInterfaces.map(declaration => `- ${declaration}`), "", "## Allowed Dependencies",
    ...module.allowedDependencies.map(path => `- ${path}`), "", "## Source Digest", sourceDigest, ""].join("\n");
}

function moduleFixture(modulePath: string, layer: BenchmarkModule["layer"], summary: string,
  publicInterfaces: readonly string[], allowedDependencies: readonly string[], source: string): BenchmarkModule {
  const files = {[`${modulePath}/index.ts`]: source};
  const definition = {modulePath, layer, summary, publicInterfaces, allowedDependencies, files};
  return {...definition, specPath: `${modulePath}/SPEC.md`,
    content: specContent(definition, canonicalAuthoritySha256(files))};
}

export const BENCHMARK_MODULES: readonly BenchmarkModule[] = [
  moduleFixture(M.orders, "api",
    "Owns authenticated order creation and the HTTP representation of checkout results. It translates validated request fields into application commands, formats currency with the shared money contract, and maps rejected commands to stable response codes. Controllers must never write ledger rows or charge payment providers directly. An order checkout payment settlement request is accepted once, and retry responses must preserve the original order identifier without exposing internal transaction details.",
    ["export function submitOrder(input: OrderRequest): Promise<OrderResponse>"], [M.checkout, M.money],
    'import {checkoutOrder} from "../../app/order_checkout/index.ts";\nimport {formatMoney} from "../../shared/money/index.ts";\nexport async function submitOrder(input: OrderRequest): Promise<OrderResponse> { return {order: await checkoutOrder(input), total: formatMoney(input.total)}; }'),
  moduleFixture(M.payments, "api",
    "Provides the payment authorization endpoint and translates application payment decisions into retryable HTTP responses. The request idempotency key is normalized before orchestration begins; the controller may read but never synthesize provider authorization identifiers. Payment authorization, capture, and settlement errors retain their application category across response versions. The HTTP boundary does not choose fraud thresholds, calculate prices, persist account balances, or interpret raw gateway failure messages.",
    ["export function authorizePayment(input: PaymentRequest): Promise<PaymentResponse>"], [M.orchestrator, M.idempotency],
    'import {orchestratePayment} from "../../app/payment_orchestrator/index.ts";\nimport {normalizeKey} from "../../shared/idempotency/index.ts";\nexport async function authorizePayment(input: PaymentRequest): Promise<PaymentResponse> { return orchestratePayment({...input, key: normalizeKey(input.key)}); }'),
  moduleFixture(M.webhooks, "api",
    "Receives provider webhook notifications for order checkout payment settlement, pricing reconciliation, order ledger settlement, and checkout idempotency replay. These highly overlapping event names describe inbound notifications, not the synchronous order checkout command path. The adapter verifies delivery identity, delegates payment reconciliation, and appends an outbox notification once. A webhook replay cannot create an order, revise pricing rules, or bypass payment policy. Delivery timestamps remain evidence rather than authority to reorder accepted commands. " +
    "An order checkout settlement notification may arrive before an earlier authorization webhook. Reconciliation must retain that uncertainty and must never reinterpret notification arrival order as command acceptance order.",
    ["export function receiveWebhook(event: ProviderEvent): Promise<void>"], [M.orchestrator, M.outbox, M.idempotency],
    'import {orchestratePayment} from "../../app/payment_orchestrator/index.ts";\nimport {enqueueEvent} from "../../infra/event_outbox/index.ts";\nimport {normalizeKey} from "../../shared/idempotency/index.ts";\nexport async function receiveWebhook(event: ProviderEvent): Promise<void> { await orchestratePayment({...event, key: normalizeKey(event.id)}); enqueueEvent(event); }'),
  moduleFixture(M.checkout, "app",
    "Coordinates the synchronous order checkout transaction from a validated command to an accepted ledger result. It obtains a domain quote, applies the order ledger transition, reserves the command idempotency key, and emits the accepted order event through the transactional outbox. Pricing and ledger rules remain owned by their domain modules. Payment settlement wording in the command must not select reporting or audit projections. A failed quote cannot reserve an order permanently, and a replay cannot append a second order event. " +
    "Contract changes must preserve the order identifier, selected price rule version, and normalized command key as one accepted result. Recovery after an outbox failure resumes the same command instead of constructing a fresh purchase from a partially accepted quote.",
    ["export function checkoutOrder(command: CheckoutCommand): Promise<CheckoutResult>"], [M.ledger, M.pricing, M.outbox, M.idempotency],
    'import {appendOrder} from "../../domain/order_ledger/index.ts";\nimport {quoteOrder} from "../../domain/pricing_rules/index.ts";\nimport {enqueueEvent} from "../../infra/event_outbox/index.ts";\nimport {normalizeKey} from "../../shared/idempotency/index.ts";\nexport async function checkoutOrder(command: CheckoutCommand): Promise<CheckoutResult> { const result = appendOrder({...command, quote: quoteOrder(command), key: normalizeKey(command.key)}); enqueueEvent(result); return result; }'),
  moduleFixture(M.trap, "app",
    "Builds an asynchronous order checkout payment settlement audit report for order checkout reconciliation. Order ledger pricing, payment settlement idempotency, checkout totals, payment authorization, and order event outbox appear repeatedly as report dimensions. Despite this vocabulary, the audit projection is not a dependency of order checkout and cannot approve checkout payment settlement. It reads persisted orders after acceptance and records observation time. Missing audit rows never block a customer command, and report repair must never mutate canonical order or payment state. " +
    "The order checkout payment settlement dashboard groups order pricing settlement, checkout payment replay, and ledger settlement exceptions for observation only. These search terms describe a projection rather than a command dependency.",
    ["export function projectOrderAudit(orderId: string): Promise<AuditRow>"], [M.repo, M.clock],
    'import {loadOrder} from "../../infra/postgres_order_repo/index.ts";\nimport {nowMillis} from "../../shared/clock/index.ts";\nexport async function projectOrderAudit(orderId: string): Promise<AuditRow> { return {order: await loadOrder(orderId), observedAt: nowMillis()}; }'),
  moduleFixture(M.orchestrator, "app",
    "Coordinates payment authorization against the domain policy before requesting a gateway operation. It converts amounts through shared money utilities and emits a durable payment decision event through the outbox after a confirmed provider result. Gateway retries preserve the original command identity rather than creating independent authorizations. Policy refusal must occur before external charging. Provider responses do not override domain limits, and uncertain gateway outcomes remain explicitly pending until reconciliation supplies evidence. " +
    "A confirmed authorization and its emitted payment decision must carry the same amount and provider reference. Recovery must distinguish a refused policy check from a charge that might already have reached the provider.",
    ["export function orchestratePayment(command: PaymentCommand): Promise<PaymentResult>"], [M.policy, M.stripe, M.outbox, M.money],
    'import {canAuthorize} from "../../domain/payment_policy/index.ts";\nimport {chargeCard} from "../../infra/stripe_gateway/index.ts";\nimport {enqueueEvent} from "../../infra/event_outbox/index.ts";\nimport {roundMinor} from "../../shared/money/index.ts";\nexport async function orchestratePayment(command: PaymentCommand): Promise<PaymentResult> { if (!canAuthorize(command)) throw new Error("policy refused"); const result = await chargeCard({...command, amount: roundMinor(command.amount)}); enqueueEvent(result); return result; }'),
  moduleFixture(M.ledger, "domain",
    "Owns order state transitions and the append-only ledger representation of an accepted purchase. A transition validates amount units, reads the durable repository version, and records the effective domain timestamp through the shared clock. An accepted order cannot silently return to a pending state. Repository conflict handling must preserve the original expected version, and monetary comparisons use integer minor units. This module has no provider charging authority and does not format transport responses or build audit reports.",
    ["export function appendOrder(command: LedgerCommand): LedgerResult"], [M.repo, M.money, M.clock],
    'import {saveOrder} from "../../infra/postgres_order_repo/index.ts";\nimport {roundMinor} from "../../shared/money/index.ts";\nimport {nowMillis} from "../../shared/clock/index.ts";\nexport function appendOrder(command: LedgerCommand): LedgerResult { return saveOrder({...command, amount: roundMinor(command.amount), at: nowMillis()}); }'),
  moduleFixture(M.policy, "domain",
    "Decides whether a payment amount and authorization window satisfy merchant-neutral domain constraints. Policy evaluates integer minor units and a supplied effective time without calling a gateway or persisting orders. Expired authorization windows are refused consistently on retries, while rounding occurs before comparison with the amount ceiling. A transport-specific failure message cannot alter eligibility. Policy changes require clear treatment of boundary amounts and exact expiry instants so callers can distinguish refusal from provider uncertainty.",
    ["export function canAuthorize(input: PaymentPolicyInput): boolean"], [M.money, M.clock],
    'import {roundMinor} from "../../shared/money/index.ts";\nimport {nowMillis} from "../../shared/clock/index.ts";\nexport function canAuthorize(input: PaymentPolicyInput): boolean { return roundMinor(input.amount) <= input.limit && nowMillis() < input.expiresAt; }'),
  moduleFixture(M.pricing, "domain",
    "Calculates a deterministic order quote from line quantities, unit prices, and explicitly supplied discount rules. All arithmetic is performed in currency minor units through the shared money contract; a quote has no gateway, database, or wall-clock side effects. Reordering identical input lines must preserve the total, and negative quantities are rejected before discount allocation. Rounding residuals are assigned deterministically so the sum of displayed line totals equals the charged order amount. Historical quotes retain their chosen rule version.",
    ["export function quoteOrder(input: PricingInput): Quote"], [M.money],
    'import {roundMinor} from "../../shared/money/index.ts";\nexport function quoteOrder(input: PricingInput): Quote { return {total: roundMinor(input.lines.reduce((sum, line) => sum + line.quantity * line.price, 0))}; }'),
  moduleFixture(M.repo, "infra",
    "Implements order persistence with optimistic version checks and a stable mapping between database rows and repository records. Writes carry an idempotency key and receive an observation timestamp from the shared clock, while reads return the stored domain version unchanged. The adapter cannot infer an accepted transition from an incomplete row or retry a conflict as an unconditional overwrite. Transaction failure leaves both the order row and its key claim untouched. Connection details and raw query errors never become public domain fields. " +
    "Concurrent updates must compare the caller's expected version before writing any replacement value. Readback returns the committed row rather than an optimistic reconstruction assembled before the transaction completed.",
    ["export function loadOrder(id: string): Promise<OrderRecord>", "export function saveOrder(record: OrderRecord): OrderRecord"], [M.idempotency, M.clock],
    'import {normalizeKey} from "../../shared/idempotency/index.ts";\nimport {nowMillis} from "../../shared/clock/index.ts";\nexport async function loadOrder(id: string): Promise<OrderRecord> { return {id, version: 1}; }\nexport function saveOrder(record: OrderRecord): OrderRecord { return {...record, key: normalizeKey(record.key), updatedAt: nowMillis()}; }'),
  moduleFixture(M.stripe, "infra",
    "Adapts provider-neutral charge commands into gateway requests and normalizes confirmed or uncertain outcomes. Currency amounts are serialized in integer minor units, and retry requests retain a normalized idempotency key across transport reconnection. The adapter never chooses merchant policy, computes discounts, or writes the order ledger. A timeout after request acceptance remains uncertain instead of being reported as a definite refusal. Provider identifiers are opaque, and transport diagnostics must not expose card data or authentication material.",
    ["export function chargeCard(input: ChargeInput): Promise<ChargeResult>"], [M.money, M.idempotency],
    'import {roundMinor} from "../../shared/money/index.ts";\nimport {normalizeKey} from "../../shared/idempotency/index.ts";\nexport async function chargeCard(input: ChargeInput): Promise<ChargeResult> { return {amount: roundMinor(input.amount), key: normalizeKey(input.key), status: "confirmed"}; }'),
  moduleFixture(M.outbox, "infra",
    "Persists application events for eventual delivery without granting the delivery worker authority over domain state. Each event retains its normalized command key and original observation time. A duplicate append returns the existing envelope, while transport retries update delivery bookkeeping without changing the event payload. Ordering is scoped to the aggregate rather than inferred from global timestamps. Events become visible only with the associated accepted transaction, and a failed append must leave no apparently deliverable partial envelope.",
    ["export function enqueueEvent(event: EventInput): EventEnvelope"], [M.idempotency, M.clock],
    'import {normalizeKey} from "../../shared/idempotency/index.ts";\nimport {nowMillis} from "../../shared/clock/index.ts";\nexport function enqueueEvent(event: EventInput): EventEnvelope { return {...event, key: normalizeKey(event.key), observedAt: nowMillis()}; }'),
  moduleFixture(M.money, "shared",
    "Defines currency minor-unit rounding and presentation used consistently by transport, domain, and provider adapters. Amounts are finite numbers representing minor units, with no implicit exchange-rate lookup or locale-dependent parsing. Rounding is deterministic for positive and negative ties and formatting preserves the currency identifier supplied by the caller. This utility has no application dependencies, clock reads, persistence, or authorization behavior. Invalid numeric inputs fail explicitly rather than producing a display string that resembles an accepted payment amount.",
    ["export function roundMinor(amount: number): number", "export function formatMoney(amount: number): string"], [],
    'export function roundMinor(amount: number): number { if (!Number.isFinite(amount)) throw new Error("invalid amount"); return Math.round(amount); }\nexport function formatMoney(amount: number): string { return String(roundMinor(amount)); }'),
  moduleFixture(M.idempotency, "shared",
    "Normalizes caller-supplied command identifiers before repositories and gateway adapters use them as replay keys. Normalization removes surrounding whitespace while preserving case and internal separators, so distinct customer commands cannot collapse accidentally. An empty identifier is rejected rather than replaced with a random value. This helper stores no claims, chooses no expiry window, and does not assert that a previous command succeeded. Every caller must retain ownership of claim persistence and independently validate the returned command result.",
    ["export function normalizeKey(key: string): string"], [],
    'export function normalizeKey(key: string): string { const normalized = key.trim(); if (!normalized) throw new Error("empty key"); return normalized; }'),
  moduleFixture(M.clock, "shared",
    "Provides the single observation-time adapter used by repositories, policy evaluation, and audit projections. Values are epoch milliseconds and must remain finite integers; callers explicitly distinguish effective domain time from transport arrival time. Reading the clock cannot authorize a state transition, establish event order across aggregates, or reset a retry identity. Deterministic evaluation supplies a controlled clock at the owning host boundary. The utility has no dependency on payment providers, persistence, application orchestration, or customer-specific scheduling policy.",
    ["export function nowMillis(): number"], [],
    'export function nowMillis(): number { return Date.now(); }'),
];

/** Digest the canonical path/content map. Stale specs bind a deterministic prior source revision. */
export function buildBenchmarkSpecs(options: {staleModulePaths?: readonly string[]} = {}): readonly BenchmarkSpec[] {
  const stale = new Set(options.staleModulePaths ?? []);
  for (const path of stale) if (!BENCHMARK_MODULES.some(module => module.modulePath === path)) {
    throw new Error(`Unknown stale module: ${path}`);
  }
  return BENCHMARK_MODULES.map(module => {
    const files = stale.has(module.modulePath)
      ? Object.fromEntries(Object.entries(module.files).map(([path, source]) => [path, `${source}\n// Previous source revision.\n`]))
      : module.files;
    return {modulePath: module.modulePath, specPath: module.specPath,
      content: specContent(module, canonicalAuthoritySha256(files))};
  });
}

function routing(category: RoutingTaskOracle["category"], taskId: string, taskPrompt: string,
  writeScope: readonly string[], requiredModulePaths: readonly string[], usefulModulePaths: readonly string[],
  rationale: string, staleModulePaths?: readonly string[]): RoutingTaskOracle {
  return {taskId, category, taskPrompt, writeScope, requiredModulePaths, usefulModulePaths, rationale,
    ...(staleModulePaths === undefined ? {} : {staleModulePaths})};
}
const file = (path: string): string => `${path}/index.ts`;

// Required sets describe each requested contract change, not every edge reachable from its owner.
export const ROUTING_TASKS: readonly RoutingTaskOracle[] = [
  routing("single_module", "single-01", "Reject nonfinite minor-unit inputs before formatting money.",
    [file(M.money)], [M.money], [], "Pure amount validation changes only the money contract."),
  routing("single_module", "single-02", "Preserve case while trimming command replay keys.",
    [file(M.idempotency)], [M.idempotency], [], "Key normalization owns this behavior without downstream changes."),
  routing("single_module", "single-03", "Document epoch milliseconds without changing the clock export.",
    [file(M.clock)], [M.clock], [], "Observation-time documentation is local to the clock module."),
  routing("single_module", "single-04", "Clarify the order checkout HTTP response error wording only.",
    [file(M.orders)], [M.orders], [M.checkout], "Application context is useful but no application contract changes."),
  routing("single_module", "single-05", "Rename a private order checkout payment settlement audit column label.",
    [file(M.trap)], [M.trap], [M.repo], "The audit projection is the owner; checkout is an intentional lexical distractor."),
  routing("single_module", "single-06", "Improve private pricing rule variable names without changing the quote.",
    [file(M.pricing)], [M.pricing], [M.money], "The task preserves the shared amount contract."),
  routing("single_direct_dep", "direct-01", "Order checkout payment settlement must return the accepted application order identifier.",
    [file(M.orders)], [M.orders, M.checkout], [M.money], "The HTTP result must match its direct application contract, not webhook or audit terminology."),
  routing("single_direct_dep", "direct-02", "Order checkout payment settlement prices must use deterministic domain rounding.",
    [file(M.checkout)], [M.checkout, M.pricing], [M.ledger], "Pricing is a direct cross-layer dependency; audit keyword overlap is irrelevant."),
  routing("single_direct_dep", "direct-03", "Reserve the order checkout idempotency key without folding letter case.",
    [file(M.checkout)], [M.checkout, M.idempotency], [M.outbox], "The shared normalizer, not the neighboring audit module, owns case preservation."),
  routing("single_direct_dep", "direct-04", "Payment authorization must preserve a gateway uncertain outcome on retry.",
    [file(M.orchestrator)], [M.orchestrator, M.stripe], [M.policy], "The provider adapter defines the outcome contract."),
  routing("single_direct_dep", "direct-05", "Enforce the exact authorization expiry instant before payment settlement.",
    [file(M.orchestrator)], [M.orchestrator, M.policy], [M.money], "The required policy dependency lives outside the application's directory."),
  routing("single_direct_dep", "direct-06", "Order ledger conflict handling must retain the stored repository version.",
    [file(M.ledger)], [M.ledger, M.repo], [M.clock], "The persistence version contract is required, not merely useful context."),
  routing("single_direct_dep", "direct-07", "Normalize webhook replay identity before payment settlement reconciliation.",
    [file(M.webhooks)], [M.webhooks, M.idempotency], [M.orchestrator], "The webhook owns this replay change, and the shared key contract is required."),
  routing("single_direct_dep", "direct-08", "Keep order event outbox observation timestamps in epoch milliseconds.",
    [file(M.outbox)], [M.outbox, M.clock], [M.idempotency], "The clock dependency crosses infrastructure and shared utility layers."),
  routing("multi_direct_dep", "multi-01", "Order checkout payment settlement must quote before appending the order ledger.",
    [file(M.checkout)], [M.checkout, M.pricing, M.ledger], [M.outbox], "Both domain contracts determine checkout ordering; lexical audit matches cannot substitute."),
  routing("multi_direct_dep", "multi-02", "Order checkout replay must append one order event for the normalized command key.",
    [file(M.checkout)], [M.checkout, M.outbox, M.idempotency], [M.ledger], "Replay and event identity require two direct dependencies from different layers."),
  routing("multi_direct_dep", "multi-03", "Reject invalid order checkout quotes before producing settlement event payloads.",
    [file(M.checkout)], [M.checkout, M.pricing, M.outbox], [M.idempotency], "Quote validation and emitted payload shape are both part of acceptance."),
  routing("multi_direct_dep", "multi-04", "Refuse disallowed payment amounts before calling the card gateway.",
    [file(M.orchestrator)], [M.orchestrator, M.policy, M.stripe], [M.money], "Policy and gateway ordering must be inspected together."),
  routing("multi_direct_dep", "multi-05", "Emit one confirmed payment settlement event using rounded minor units.",
    [file(M.orchestrator)], [M.orchestrator, M.outbox, M.money], [M.stripe], "The changed event and amount contracts are not path-adjacent."),
  routing("multi_direct_dep", "multi-06", "Keep order checkout response totals consistent with the accepted application quote.",
    [file(M.orders)], [M.orders, M.checkout, M.money], [], "Both declared API dependencies are essential despite audit and webhook lexical traps."),
  routing("multi_direct_dep", "multi-07", "Return stable payment retry responses for normalized authorization keys.",
    [file(M.payments)], [M.payments, M.orchestrator, M.idempotency], [], "The HTTP adapter must coordinate the result and key contracts."),
  routing("multi_direct_dep", "multi-08", "Persist accepted order amounts with the optimistic repository version.",
    [file(M.ledger)], [M.ledger, M.repo, M.money], [M.clock], "Durable version and minor-unit contracts jointly constrain the ledger."),
  routing("multi_direct_dep", "multi-09", "Payment settlement gateway retries must retain the key and minor-unit amount.",
    [file(M.stripe)], [M.stripe, M.idempotency, M.money], [], "Both shared utilities are required for retry parity."),
  routing("multi_direct_dep", "multi-10", "Reconcile webhook payment settlement once before enqueueing its notification.",
    [file(M.webhooks)], [M.webhooks, M.orchestrator, M.outbox, M.idempotency], [],
    "All three direct dependencies participate; the application spec is deliberately stale.", [M.orchestrator]),
  routing("transitive_dep", "transitive-01", "Trace order checkout quote acceptance through the application into domain pricing.",
    [file(M.orders)], [M.orders, M.checkout, M.pricing], [M.money], "Pricing is two hops away via checkout and absent from a one-hop API route."),
  routing("transitive_dep", "transitive-02", "Trace checkout ledger version conflicts into the PostgreSQL repository contract.",
    [file(M.checkout)], [M.checkout, M.ledger, M.repo], [M.idempotency], "The required repository is two hops away via the domain ledger."),
  routing("transitive_dep", "transitive-03", "Trace payment HTTP refusal to the domain authorization policy.",
    [file(M.payments)], [M.payments, M.orchestrator, M.policy], [M.stripe], "Policy is two hops away and the one-hop limitation must remain visible."),
  routing("transitive_dep", "transitive-04", "Trace provider amount encoding from the payment HTTP endpoint into the gateway.",
    [file(M.payments)], [M.payments, M.orchestrator, M.stripe], [M.money], "The gateway is a required second-hop dependency, not an oracle derived from routing."),
  routing("directory_scope", "directory-01", "Review HTTP response and webhook delivery consistency across the API directory.",
    ["src/api/"], [M.orders, M.payments, M.webhooks], [M.checkout, M.orchestrator], "Every API owner is required, even when a budget cannot retain all three."),
  routing("directory_scope", "directory-02", "Align command and observation responsibilities across application modules.",
    ["src/app/"], [M.checkout, M.trap, M.orchestrator], [M.ledger, M.policy], "Directory scope genuinely includes the audit trap here."),
  routing("directory_scope", "directory-03", "Review durable version, gateway uncertainty, and outbox replay adapters.",
    ["src/infra/"], [M.repo, M.stripe, M.outbox], [M.idempotency, M.clock], "All infrastructure owners are required independently of lexical scoring."),
  routing("directory_scope", "directory-04", "Document deterministic amounts, replay keys, and epoch timestamps together.",
    ["src/shared/"], [M.money, M.idempotency, M.clock], [], "Shared directory ownership spans three dependency-free utilities."),
  routing("disjoint_scopes", "disjoint-01", "Coordinate checkout HTTP totals with domain quote rounding.",
    [file(M.orders), file(M.pricing)], [M.orders, M.pricing, M.money], [M.checkout], "Disjoint owners both require the shared money contract."),
  routing("disjoint_scopes", "disjoint-02", "Align payment HTTP replay behavior with gateway key serialization.",
    [file(M.payments), file(M.stripe)], [M.payments, M.stripe, M.idempotency], [M.orchestrator], "Neither directory adjacency nor a single owner covers both changes."),
  routing("disjoint_scopes", "disjoint-03", "Preserve checkout event payloads and webhook outbox replay keys.",
    [file(M.checkout), file(M.webhooks)], [M.checkout, M.webhooks, M.outbox, M.idempotency], [M.orchestrator],
    "The outbox and replay contracts are shared direct dependencies of both owners.", [M.outbox]),
  routing("disjoint_scopes", "disjoint-04", "Align ledger effective time with payment policy expiry boundaries.",
    [file(M.ledger), file(M.policy)], [M.ledger, M.policy, M.clock], [M.money, M.repo], "Both domain owners need the clock contract, whose spec is stale.", [M.clock]),
];

interface BoundaryRow {
  readonly description: string;
  readonly declared: readonly string[];
  readonly source: string;
  readonly exportDrift?: boolean;
  readonly forbiddenImport?: boolean;
  readonly allowed?: readonly string[];
}
function cases(category: BoundaryEvalCase["category"], rows: readonly BoundaryRow[]): BoundaryEvalCase[] {
  return rows.map((row, index) => ({caseId: `${category}-${String(index + 1).padStart(2, "0")}`, category,
    modulePath: M.checkout, declaredInterfaces: row.declared, allowedDependencies: row.allowed ?? [M.ledger, M.money],
    files: {[file(M.checkout)]: row.source},
    expectedExportDrift: row.exportDrift ?? ["missing_export", "undeclared_export", "signature_only_limitation"].includes(category),
    expectedForbiddenImport: row.forbiddenImport ?? category === "forbidden_import",
    isSignatureOnlyLimitation: category === "signature_only_limitation", description: row.description}));
}
const row = (description: string, declared: readonly string[], source: string,
  options: Omit<BoundaryRow, "description" | "declared" | "source"> = {}): BoundaryRow => ({description, declared, source, ...options});

export const BOUNDARY_CASES: readonly BoundaryEvalCase[] = [
  ...cases("compliant", [
    row("Standard function export", ["submit"], "export function submit(): void {}"),
    row("Typed constant export", ["retryLimit"], "export const retryLimit: number = 3;"),
    row("Class export", ["Checkout"], "export class Checkout { run(): void {} }"),
    row("Interface export", ["Order"], "export interface Order { id: string }"),
    row("Type alias export", ["OrderId"], "export type OrderId = string;"),
    row("Async function export", ["submit"], "export async function submit(): Promise<void> {}"),
    row("Allowed relative ledger import", ["submit"], 'import {appendOrder} from "../../domain/order_ledger/index.ts"; export const submit = appendOrder;'),
    row("Allowed repository-style money import", ["submit"], 'import {roundMinor} from "src/shared/money/index.ts"; export const submit = roundMinor;'),
    row("Allowed type import", ["Order"], 'import type {LedgerOrder} from "../../domain/order_ledger/types.ts"; export type Order = LedgerOrder;'),
    row("Local import within owning module", ["submit"], 'import {validate} from "./validate.ts"; export const submit = validate;'),
  ]),
  ...cases("missing_export", [
    row("Omitted function", ["submit"], "function submit(): void {}"),
    row("Renamed exported function", ["submit"], "export function submitNew(): void {}"),
    row("Omitted class", ["Checkout"], "class Checkout {}"),
    row("Omitted interface", ["Order"], "interface Order { id: string }"),
    row("Omitted type alias", ["OrderId"], "type OrderId = string;"),
    row("One of two declared symbols removed", ["submit", "cancel"], "export function submit(): void {}"),
    row("Empty implementation", ["submit"], "// Implementation intentionally absent.\n"),
    row("Async function made private", ["submit"], "async function submit(): Promise<void> {}"),
    row("Named export replaced by default", ["submit"], "export default function submit(): void {}"),
    row("Required alias not re-exported", ["publicSubmit"], "const internalSubmit = () => {}; export {internalSubmit};"),
  ]),
  ...cases("undeclared_export", [
    row("Extra function", ["submit"], "export function submit() {} export function debug() {}"),
    row("Extra constant", ["submit"], "export function submit() {} export const debug = true;"),
    row("Extra class", ["submit"], "export function submit() {} export class DebugSession {}"),
    row("Extra interface", ["submit"], "export function submit() {} export interface DebugInfo { value: string }"),
    row("Extra type alias", ["submit"], "export function submit() {} export type DebugId = string;"),
    row("Extra named alias", ["submit"], "export function submit() {} const hidden = 1; export {hidden as debug};"),
    row("Extra async function", ["submit"], "export function submit() {} export async function inspect() {}"),
    row("Extra mutable binding", ["submit"], "export function submit() {} export let debugCount = 0;"),
    row("Extra default export", ["submit"], "export function submit() {} export default 1;"),
    row("Extra allowed re-export", ["submit"], 'export function submit() {} export {roundMinor as debugRound} from "src/shared/money/index.ts";'),
  ]),
  ...cases("syntax_trap_comment_or_string", [
    row("Block comment fake function", ["submit"], "/* export function fakeTrap() {} */\nexport function submit() {}"),
    row("Line comment fake constant", ["submit"], "// export const bad = 1;\nexport function submit() {}"),
    row("Double-quoted fake declarations", ["submit"], 'const text = "export function notAnExport() {}\\nimport {x} from \'src/infra/stripe_gateway\'"; export function submit() {}'),
    row("Template fake function", ["submit"], 'const text = `export function fakeTrap() {}\nimport {x} from "src/infra/stripe_gateway"`; export function submit() {}'),
    row("Commented forbidden import", ["submit"], '/* import {chargeCard} from "src/infra/stripe_gateway"; */ export function submit() {}'),
    row("Line-commented re-export", ["submit"], '// export {chargeCard} from "src/infra/stripe_gateway";\nexport function submit() {}'),
    row("Single-quoted fake class", ["submit"], "const text = 'export class Secret {}'; export function submit() {}"),
    row("Documentation fake interface", ["submit"], "/** Example:\n * export interface Ghost { id: string }\n */\nexport function submit() {}"),
    row("Template fake type export", ["submit"], "const text = `export type Ghost = string;`; export function submit() {}"),
    row("Multiline block trap", ["submit"], '/*\nexport async function charge() {}\nimport type {Card} from "src/infra/stripe_gateway";\n*/\nexport function submit() {}'),
  ]),
  ...cases("complex_ts_syntax_export", [
    row("Object destructuring aliases", ["a", "renamedB"], "const obj = {a: 1, b: 2}; export const {a, b: renamedB} = obj;"),
    row("Nested object destructuring", ["inner"], "const obj = {nested: {inner: 1}}; export const {nested: {inner}} = obj;"),
    row("Array destructuring with hole", ["first", "third"], "export const [first, , third] = [1, 2, 3];"),
    row("Aliased local export", ["publicFn"], "function internalFn() {} export {internalFn as publicFn};"),
    row("Multiline async declaration", ["compute"], "export\n  async function\n  compute(): Promise<number> { return 1; }"),
    row("Undeclared destructured alias", ["a"], "const obj = {a: 1, b: 2}; export const {a, b: surprise} = obj;", {exportDrift: true}),
    row("Undeclared multiline function", ["compute"], "export\nasync function\ncompute() {}\nexport\nfunction surprise() {}", {exportDrift: true}),
    row("Missing original alias name", ["internalFn"], "function internalFn() {} export {internalFn as publicFn};", {exportDrift: true}),
    row("Allowed multiline type re-export", ["PublicOrder"], 'export type {\nOrder as PublicOrder\n} from "src/domain/order_ledger/types.ts";'),
    row("Rest binding adds undeclared export", ["first"], "export const [first, ...remaining] = [1, 2, 3];", {exportDrift: true}),
  ]),
  ...cases("forbidden_import", [
    row("Unallowed absolute module import", ["submit"], 'import {chargeCard} from "src/infra/stripe_gateway/index.ts"; export function submit() {}'),
    row("Unallowed relative module import", ["submit"], 'import {chargeCard} from "../../infra/stripe_gateway/index.ts"; export function submit() {}'),
    row("Multiline forbidden import", ["submit"], 'import {\nchargeCard\n} from "src/infra/stripe_gateway/index.ts"; export function submit() {}'),
    row("Forbidden type import", ["submit"], 'import type {Charge} from "src/infra/stripe_gateway/types.ts"; export function submit() {}'),
    row("Forbidden named re-export", ["chargeCard"], 'export {chargeCard} from "src/infra/stripe_gateway/index.ts";'),
    row("Forbidden namespace import", ["submit"], 'import * as gateway from "src/infra/stripe_gateway/index.ts"; export function submit() {}'),
    row("Forbidden side-effect import", ["submit"], 'import "src/infra/stripe_gateway/register.ts"; export function submit() {}'),
    row("Forbidden default import", ["submit"], 'import gateway from "src/infra/stripe_gateway/index.ts"; export function submit() {}'),
    row("Forbidden type re-export", ["Charge"], 'export type {Charge} from "src/infra/stripe_gateway/types.ts";'),
    row("Forbidden import-equals declaration", ["submit"], 'import gateway = require("src/infra/stripe_gateway/index.ts"); export function submit() {}'),
  ]),
  ...cases("prefix_trap_import", [
    row("Ledger underscore sibling", ["submit"], 'import {secret} from "src/domain/order_ledger_internal/secret.ts"; export function submit() {}', {forbiddenImport: true, allowed: [M.ledger]}),
    row("Ledger suffix sibling", ["submit"], 'import {secret} from "src/domain/order_ledger_v2/index.ts"; export function submit() {}', {forbiddenImport: true, allowed: [M.ledger]}),
    row("Money underscore sibling", ["submit"], 'import {secret} from "src/shared/money_private/index.ts"; export function submit() {}', {forbiddenImport: true, allowed: [M.money]}),
    row("Relative ledger sibling", ["submit"], 'import {secret} from "../../domain/order_ledger_internal/secret.ts"; export function submit() {}', {forbiddenImport: true, allowed: [M.ledger]}),
    row("Relative escape from allowed ledger", ["submit"], 'import {secret} from "../../domain/order_ledger/../order_ledger_internal/secret.ts"; export function submit() {}', {forbiddenImport: true, allowed: [M.ledger]}),
    row("Allowed money nested currency", ["submit"], 'import {currency} from "src/shared/money/currency.ts"; export function submit() {}', {allowed: [M.money]}),
    row("Allowed ledger nested type", ["submit"], 'import type {Order} from "src/domain/order_ledger/types/order.ts"; export function submit() {}', {allowed: [M.ledger]}),
    row("Allowed relative money nested helper", ["submit"], 'import {roundMinor} from "../../shared/money/rounding.ts"; export function submit() {}', {allowed: [M.money]}),
    row("Allowed exact ledger module", ["submit"], 'import {appendOrder} from "src/domain/order_ledger"; export function submit() {}', {allowed: [M.ledger]}),
    row("Allowed ledger nested re-export", ["Order"], 'export type {Order} from "src/domain/order_ledger/types.ts";', {allowed: [M.ledger]}),
  ]),
  ...cases("signature_only_limitation", [
    row("submit parameter changed from number to string", ["submit"], "export function submit(amount: string): boolean { return true; }"),
    row("submit return changed from boolean to string", ["submit"], "export function submit(amount: number): string { return String(amount); }"),
    row("submit gained required currency parameter", ["submit"], "export function submit(amount: number, currency: string): boolean { return true; }"),
    row("load changed from Promise<Order> to synchronous Order", ["load"], "export function load(id: string): Order { return {id}; }"),
    row("cancel parameter narrowed from string to literal", ["cancel"], 'export function cancel(id: "fixed"): void {}'),
    row("Quote total changed from number to string", ["Quote"], "export interface Quote { total: string }"),
    row("OrderId changed from string to number", ["OrderId"], "export type OrderId = number;"),
    row("Checkout constructor changed from string key to numeric key", ["Checkout"], "export class Checkout { constructor(key: number) { void key; } }"),
    row("submit callback changed from void result to mandatory boolean result", ["submit"], "export function submit(callback: () => boolean): void { callback(); }"),
    row("quote generic removed from formerly generic identity function", ["quote"], "export function quote(input: string): string { return input; }"),
  ]),
];
