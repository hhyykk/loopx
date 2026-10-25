/** Local synthetic evaluation, deliberately outside active CI. No model jobs or production writes. */
import assert from "node:assert/strict";
import {readFileSync} from "node:fs";
import {posix} from "node:path";
import {canonicalAuthoritySha256} from "../loopx/control_plane/coordination/authority_store_codec.ts";
import {buildModuleKnowledgeGraph, comparePublicInterfaces, extractTypeScriptExportsAndImports,
  parseModuleSpec, routeRepositoryContext, type ModuleKnowledge, type RoutedModuleSummary,
} from "../loopx/control_plane/capabilities/repository_context/index.ts";
import {BENCHMARK_MODULES, BOUNDARY_CASES, ROUTING_TASKS, buildBenchmarkSpecs,
  type BoundaryEvalCase, type RoutingTaskOracle} from "./living_specs_benchmark_corpus.ts";

const budgets = [2048, 4096, 8192, 16384];
const arms = ["R0", "R1", "R2", "R3-no-deps", "R3", "R3-2hop"];
const comparePath = (a: string, b: string): number => a < b ? -1 : a > b ? 1 : 0;
const bytes = (value: unknown): number => Buffer.byteLength(JSON.stringify(value), "utf8");
const mean = (values: readonly number[]): number => values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
const percent = (n: number, d: number): number | null => d ? 100 * n / d : null;
const display = (value: number | null): string => value === null ? "n/a" : value.toFixed(2);

// Explicit fixture-to-production adapter: the corpus predates the plural headings.
// Preserve Summary text as responsibilities instead of benchmarking empty summaries.
function benchmarkSpecs(task: RoutingTaskOracle) {
  return buildBenchmarkSpecs({staleModulePaths: task.staleModulePaths}).map(spec => ({...spec,
    content: spec.content.replace("## Public Interface\n", "## Public Interfaces\n")
      .replace(/## Summary\n([^]*?)(?=\n## )/, (_, summary: string) => `## Responsibilities\n- ${summary.trim()}\n`),
  }));
}
function within(path: string, parent: string): boolean {
  return parent === "." || path === parent || path.startsWith(`${parent}/`);
}
function ownersFor(modules: readonly ModuleKnowledge[], scope: readonly string[]): Set<string> {
  const owners = new Set<string>();
  for (const entry of scope) {
    const path = posix.normalize(entry).replace(/\/$/, "");
    const longest = modules.filter(module => within(path, module.modulePath))
      .sort((a, b) => b.modulePath.length - a.modulePath.length)[0];
    if (longest) owners.add(longest.modulePath);
    for (const module of modules) if (within(module.modulePath, path)) owners.add(module.modulePath);
  }
  return owners;
}
type ContextBlock = Omit<RoutedModuleSummary, "selectionReason"> & {readonly selectionReason: string};
/** Same field ordering and schema as context_route.ts. Non-owner baseline reason
 * labels have the same UTF-8 length as direct_dependency, avoiding metadata tax. */
function formatContextBlock(spec: ModuleKnowledge, owners: ReadonlySet<string>, stale: ReadonlySet<string>,
  nonOwnerReason = "direct_dependency"): ContextBlock {
  if (nonOwnerReason !== "transitive_dependency") assert.equal(Buffer.byteLength(nonOwnerReason), Buffer.byteLength("direct_dependency"));
  return {modulePath: spec.modulePath, specPath: spec.specPath, specDigest: spec.specDigest,
    responsibilities: spec.responsibilities, publicInterfaces: spec.publicInterfaces,
    allowedDependencies: spec.allowedDependencies, invariants: spec.invariants,
    selectionReason: owners.has(spec.modulePath) ? "owning_write_scope" : nonOwnerReason,
    stale: stale.has(spec.modulePath)};
}
function pack(candidates: readonly ContextBlock[], maxBytes: number): ContextBlock[] {
  const selected: ContextBlock[] = [];
  for (const candidate of candidates) if (bytes([...selected, candidate]) <= maxBytes) selected.push(candidate);
  return selected;
}
function proximity(module: string, scope: readonly string[]): {depth: number; distance: number} {
  const a = module.split("/");
  const scores = scope.map(entry => {
    const path = entry.endsWith("/") || !posix.extname(entry) ? entry : posix.dirname(entry);
    const b = posix.normalize(path).replace(/\/$/, "").split("/");
    let depth = 0;
    while (depth < Math.min(a.length, b.length) && a[depth] === b[depth]) depth++;
    return {depth, distance: a.length + b.length - 2 * depth};
  });
  return scores.sort((x, y) => y.depth - x.depth || x.distance - y.distance)[0] ?? {depth: 0, distance: Infinity};
}
function tokens(value: string): string[] {
  return value.replace(/([a-z])([A-Z])/g, "$1 $2").toLowerCase().match(/[a-z0-9]+/g) ?? [];
}
function lexicalScores(specs: readonly {modulePath: string; content: string}[], query: string): Map<string, number> {
  const documents = specs.map(spec => tokens(spec.content));
  const averageLength = mean(documents.map(document => document.length));
  const queryTerms = new Set(tokens(query));
  const frequencies = new Map<string, number>();
  for (const document of documents) for (const term of new Set(document)) frequencies.set(term, (frequencies.get(term) ?? 0) + 1);
  return new Map(specs.map((spec, index) => {
    const document = documents[index];
    const counts = new Map<string, number>();
    for (const term of document) counts.set(term, (counts.get(term) ?? 0) + 1);
    let score = 0;
    for (const term of queryTerms) {
      const tf = counts.get(term) ?? 0;
      const df = frequencies.get(term) ?? 0;
      const idf = Math.log(1 + (documents.length - df + 0.5) / (df + 0.5));
      score += idf * tf * 2.2 / (tf + 1.2 * (0.25 + 0.75 * document.length / averageLength));
    }
    return [spec.modulePath, score];
  }));
}
interface RoutingObservation {
  taskId: string; category: RoutingTaskOracle["category"]; arm: string; budget: number;
  recallPercent: number; complete: boolean; irrelevantNoisePercent: number; serializedBytes: number;
  budgetViolation: boolean; selectedModulePaths: string[]; staleSpecs: string[];
  staleRequiredCount: number; staleRequiredSurfacedCount: number; allRequiredStaleSurfaced: boolean | null;
}

assert.equal(BENCHMARK_MODULES.length, 15);
assert.equal(ROUTING_TASKS.length, 36);
assert.equal(ROUTING_TASKS.filter(task => task.category === "transitive_dep").length, 4);
assert.equal(BOUNDARY_CASES.length, 80);
assert.equal(new Set(ROUTING_TASKS.map(task => task.taskId)).size, 36);
assert.equal(new Set(BOUNDARY_CASES.map(test => test.caseId)).size, 80);
const paths = new Set(BENCHMARK_MODULES.map(module => module.modulePath));
const routingObservations: RoutingObservation[] = [];
const references: {taskId: string; fullSpecSummaryBytes: number; rawFullSpecBytes: number; fullSourceBytes: number}[] = [];
for (const task of ROUTING_TASKS) {
  for (const path of [...task.requiredModulePaths, ...task.usefulModulePaths, ...(task.staleModulePaths ?? [])]) assert.ok(paths.has(path), path);
  assert.ok(task.requiredModulePaths.length > 0);
  const specs = benchmarkSpecs(task);
  const graph = buildModuleKnowledgeGraph(specs);
  for (const module of graph.modules) {
    const fixture = BENCHMARK_MODULES.find(item => item.modulePath === module.modulePath)!;
    assert.deepEqual(module.responsibilities, [fixture.summary]);
    assert.equal(module.publicInterfaces.length, fixture.publicInterfaces.length);
  }
  const owners = ownersFor(graph.modules, task.writeScope);
  const stale = new Set(task.staleModulePaths ?? []);
  const summaries = graph.modules.map(module => formatContextBlock(module, owners, stale));
  references.push({taskId: task.taskId, fullSpecSummaryBytes: bytes(summaries),
    rawFullSpecBytes: bytes(buildBenchmarkSpecs({staleModulePaths: task.staleModulePaths})),
    fullSourceBytes: bytes(Object.fromEntries(BENCHMARK_MODULES.flatMap(module => Object.entries(module.files))))});
  const scores = lexicalScores(specs, `${task.taskPrompt} ${task.writeScope.join(" ")}`);
  for (const budget of budgets) for (const arm of arms) {
    let selected: readonly ContextBlock[];
    if (arm.startsWith("R3")) {
      const plan = routeRepositoryContext(graph, {writeScope: task.writeScope, maxBytes: budget,
        maxDependencyDepth: arm === "R3-no-deps" ? 0 : arm === "R3-2hop" ? 2 : 1, staleModulePaths: task.staleModulePaths});
      selected = plan.selectedModules;
      assert.equal(plan.totalBytes, selected.length ? bytes(selected) : 0);
      for (const block of selected) assert.deepEqual(block, formatContextBlock(graph.modules.find(module => module.modulePath === block.modulePath)!, owners, stale, block.selectionReason === "owning_write_scope" ? "direct_dependency" : block.selectionReason));
    } else {
      const ordered = [...graph.modules].sort((a, b) => {
        const ownerPriority = Number(owners.has(b.modulePath)) - Number(owners.has(a.modulePath));
        if (arm !== "R0" && ownerPriority) return ownerPriority;
        if (arm === "R1") {
          const x = proximity(a.modulePath, task.writeScope), y = proximity(b.modulePath, task.writeScope);
          if (x.depth !== y.depth || x.distance !== y.distance) return y.depth - x.depth || x.distance - y.distance;
        }
        if (arm === "R2" && scores.get(a.modulePath) !== scores.get(b.modulePath)) return scores.get(b.modulePath)! - scores.get(a.modulePath)!;
        return comparePath(a.modulePath, b.modulePath);
      });
      const reason = arm === "R0" ? "repository_order_" : arm === "R1" ? "path_proximity___" : "lexical_relevance";
      selected = pack(ordered.map(module => formatContextBlock(module, owners, stale, reason)), budget);
    }
    const selectedPaths = new Set(selected.map(module => module.modulePath));
    const required = new Set(task.requiredModulePaths);
    const relevant = new Set([...required, ...task.usefulModulePaths]);
    const staleRequired = [...required].filter(path => stale.has(path));
    const staleSpecs = selected.filter(module => module.stale).map(module => module.modulePath);
    const staleFound = staleRequired.filter(path => staleSpecs.includes(path)).length;
    const serializedBytes = selected.length ? bytes(selected) : 0;
    // Attribute each object's bytes plus one array separator; the final closing
    // bracket is shared overhead. Thus irrelevant bytes + relevant bytes + 1 = total.
    const irrelevantBytes = selected.filter(module => !relevant.has(module.modulePath)).reduce((sum, module) => sum + bytes(module) + 1, 0);
    const found = [...required].filter(path => selectedPaths.has(path)).length;
    routingObservations.push({taskId: task.taskId, category: task.category, arm, budget,
      recallPercent: 100 * found / required.size, complete: found === required.size,
      irrelevantNoisePercent: serializedBytes ? 100 * irrelevantBytes / serializedBytes : 0,
      serializedBytes, budgetViolation: serializedBytes > budget, selectedModulePaths: [...selectedPaths], staleSpecs,
      staleRequiredCount: staleRequired.length, staleRequiredSurfacedCount: staleFound,
      allRequiredStaleSurfaced: staleRequired.length ? staleFound === staleRequired.length : null});
  }
}
assert.equal(routingObservations.length, ROUTING_TASKS.length * budgets.length * arms.length);
// Increasing depth must retain every selected owner/direct dependency as a prefix.
for (const task of ROUTING_TASKS) for (const budget of budgets) {
  const rows = routingObservations.filter(row => row.taskId === task.taskId && row.budget === budget);
  const oneHop = rows.find(row => row.arm === "R3")!.selectedModulePaths;
  const twoHop = rows.find(row => row.arm === "R3-2hop")!.selectedModulePaths;
  assert.deepEqual(twoHop.slice(0, oneHop.length), oneHop);
}
assert.ok(routingObservations.every(observation => !observation.budgetViolation));
const routingSummary = budgets.flatMap(budget => arms.map(arm => {
  const observations = routingObservations.filter(row => row.arm === arm && row.budget === budget);
  const coverage = (rows: typeof observations) => percent(rows.filter(row => row.complete).length, rows.length);
  const staleRows = observations.filter(row => row.allRequiredStaleSurfaced !== null);
  return {arm, budget, observations: observations.length,
    meanRequiredRecallPercent: mean(observations.map(row => row.recallPercent)),
    completeTaskCoveragePercent: coverage(observations),
    directContractCoveragePercent: coverage(observations.filter(row => row.category !== "transitive_dep")),
    transitiveCoveragePercent: coverage(observations.filter(row => row.category === "transitive_dep")),
    meanIrrelevantNoisePercent: mean(observations.map(row => row.irrelevantNoisePercent)),
    meanSerializedBytes: mean(observations.map(row => row.serializedBytes)),
    budgetViolations: observations.filter(row => row.budgetViolation).length,
    staleRequiredTasks: staleRows.length,
    staleTaskSurfacedPercent: percent(staleRows.filter(row => row.allRequiredStaleSurfaced).length, staleRows.length),
    staleSpecSurfacedPercent: percent(staleRows.reduce((sum, row) => sum + row.staleRequiredSurfacedCount, 0),
      staleRows.reduce((sum, row) => sum + row.staleRequiredCount, 0)),
    meanByteReductionVsFullSpecPercent: mean(observations.map(row => 100 * (1 - row.serializedBytes / references.find(ref => ref.taskId === row.taskId)!.fullSpecSummaryBytes))),
  };
}));

// Fixed-seed paired bootstrap, clustered by task; budgets are not independent samples.
function pairedCoverage(budget: number, treatment: string, baseline: string, stratum: string) {
  const paired = ROUTING_TASKS.filter(task => stratum === "all" ||
    (stratum === "transitive" ? task.category === "transitive_dep" : task.category !== "transitive_dep")).map(task => {
    const rows = routingObservations.filter(row => row.taskId === task.taskId && row.budget === budget);
    return Number(rows.find(row => row.arm === treatment)!.complete) - Number(rows.find(row => row.arm === baseline)!.complete);
  });
  let seed = 7321;
  const replicates = Array.from({length: 2000}, () => {
    let sum = 0;
    for (let i = 0; i < paired.length; i++) {
      seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5;
      sum += paired[(seed >>> 0) % paired.length];
    }
    return 100 * sum / paired.length;
  }).sort((a, b) => a - b);
  return {budget, treatment, baseline, stratum, tasks: paired.length, coverageDeltaPoints: 100 * mean(paired),
    bootstrap95PercentInterval: [replicates[49], replicates[1949]],
    exploratoryTenPointCriterionMet: 100 * mean(paired) >= 10 && replicates[49] > 0};
}
const pairedComparisons = budgets.flatMap(budget => ["R3", "R3-2hop"].flatMap(treatment =>
  arms.filter(arm => arm !== treatment).flatMap(baseline =>
    ["all", "direct", "transitive"].map(stratum => pairedCoverage(budget, treatment, baseline, stratum)))));

function regexExtract(source: string): {exports: string[]; imports: string[]} {
  const exports = [...source.matchAll(/\bexport\s+(?:async\s+)?(?:function|const|let|var|class|interface|type)\s+([A-Za-z_$][\w$]*)/g)].map(match => match[1]);
  const imports = [...source.matchAll(/\bfrom\s+["']([^"']+)["']/g)].map(match => match[1]);
  return {exports: [...new Set(exports)].sort(), imports: [...new Set(imports)].sort()};
}
// Same set and path-boundary policy for both extractors. For every AST case,
// assert this evaluator's complete result equals the actual production comparator.
function evaluateExtraction(spec: ModuleKnowledge, files: readonly {filePath: string; content: string}[],
  extract: typeof regexExtract) {
  const declaredExports = [...new Set(spec.publicInterfaces.map(item => item.name))].sort();
  const observed = new Set<string>(), forbidden = new Set<string>();
  for (const file of files) {
    const extracted = extract(file.content);
    for (const name of extracted.exports) observed.add(name);
    for (const imported of extracted.imports) {
      const relative = imported.startsWith("./") || imported.startsWith("../");
      const target = relative ? posix.normalize(posix.join(posix.dirname(file.filePath), imported)) : imported;
      if (!(relative && within(target, spec.modulePath)) && !spec.allowedDependencies.some(dependency => within(target, dependency))) forbidden.add(imported);
    }
  }
  const observedExports = [...observed].sort();
  const undeclaredExports = observedExports.filter(name => !declaredExports.includes(name));
  const missingExports = declaredExports.filter(name => !observed.has(name));
  const forbiddenImports = [...forbidden].sort();
  const hasDrift = undeclaredExports.length > 0 || missingExports.length > 0 || forbiddenImports.length > 0;
  return {modulePath: spec.modulePath, declaredExports, observedExports, undeclaredExports, missingExports,
    forbiddenImports, hasDrift, requiresGateReview: hasDrift};
}
function boundarySpec(test: BoundaryEvalCase): ModuleKnowledge {
  return parseModuleSpec({modulePath: test.modulePath, specPath: `${test.modulePath}/SPEC.md`, content:
    `## Public Interfaces\n${test.declaredInterfaces.map(name => `- ${name}`).join("\n")}\n## Allowed Dependencies\n${test.allowedDependencies.map(path => `- ${path}`).join("\n")}`});
}
interface BoundaryObservation {
  arm: string; caseId: string; category: BoundaryEvalCase["category"]; signatureOnly: boolean;
  expectedExportDrift: boolean; expectedForbiddenImport: boolean;
  predictedExportDrift: boolean | null; predictedForbiddenImport: boolean | null;
  error: string | null;
}
const boundaryObservations: BoundaryObservation[] = [];
for (const test of BOUNDARY_CASES) for (const arm of ["B0", "B1"]) {
  const spec = boundarySpec(test);
  const files = Object.entries(test.files).map(([filePath, content]) => ({filePath, content}));
  let prediction: ReturnType<typeof comparePublicInterfaces> | undefined;
  let error: string | null = null;
  try {
    prediction = arm === "B1" ? comparePublicInterfaces(spec, files) : evaluateExtraction(spec, files, regexExtract);
  } catch (caught) { error = caught instanceof Error ? caught.message : String(caught); }
  if (arm === "B1" && prediction) assert.deepEqual(prediction, evaluateExtraction(spec, files, extractTypeScriptExportsAndImports));
  boundaryObservations.push({arm, caseId: test.caseId, category: test.category,
    signatureOnly: test.isSignatureOnlyLimitation, expectedExportDrift: test.expectedExportDrift,
    expectedForbiddenImport: test.expectedForbiddenImport,
    predictedExportDrift: prediction ? prediction.missingExports.length > 0 || prediction.undeclaredExports.length > 0 : null,
    predictedForbiddenImport: prediction ? prediction.forbiddenImports.length > 0 : null, error});
}
function confusion(rows: readonly BoundaryObservation[], signal: "exports" | "imports" | "combined") {
  let tp = 0, fp = 0, tn = 0, fn = 0, errors = 0;
  for (const row of rows) {
    const expected = signal === "exports" ? row.expectedExportDrift : signal === "imports" ? row.expectedForbiddenImport : row.expectedExportDrift || row.expectedForbiddenImport;
    const predicted = signal === "exports" ? row.predictedExportDrift : signal === "imports" ? row.predictedForbiddenImport : row.predictedExportDrift === null ? null : row.predictedExportDrift || row.predictedForbiddenImport;
    if (predicted === null) { errors++; if (expected) fn++; continue; }
    if (expected && predicted) tp++; else if (predicted) fp++; else if (expected) fn++; else tn++;
  }
  const negatives = rows.filter(row => signal === "exports" ? !row.expectedExportDrift : signal === "imports" ? !row.expectedForbiddenImport : !row.expectedExportDrift && !row.expectedForbiddenImport).length;
  return {cases: rows.length, tp, fp, tn, fn, errors, precisionPercent: percent(tp, tp + fp),
    recallPercent: percent(tp, tp + fn), falsePositivePercent: percent(fp, negatives)};
}
const boundarySummary = ["B0", "B1"].map(arm => {
  const all = boundaryObservations.filter(row => row.arm === arm);
  const supported = all.filter(row => !row.signatureOnly);
  assert.equal(supported.length, 70);
  const signatures = all.filter(row => row.signatureOnly);
  assert.equal(signatures.length, 10);
  return {arm, supportedExports: confusion(supported, "exports"), supportedImports: confusion(supported, "imports"),
    supportedCombined: confusion(supported, "combined"),
    syntaxTraps: confusion(supported.filter(row => row.category === "syntax_trap_comment_or_string"), "combined"),
    complexExports: confusion(supported.filter(row => row.category === "complex_ts_syntax_export"), "exports"),
    prefixImports: confusion(supported.filter(row => row.category === "prefix_trap_import"), "imports"),
    signatureOnly: {cases: signatures.length, detected: signatures.filter(row => row.predictedExportDrift === true).length,
      errors: signatures.filter(row => row.error !== null).length},
  };
});

const sourceFiles = ["./repository-context-living-specs-comparison.ts", "./living_specs_benchmark_corpus.ts",
  "../loopx/control_plane/capabilities/repository_context/module_graph.ts",
  "../loopx/control_plane/capabilities/repository_context/context_route.ts",
  "../loopx/control_plane/capabilities/repository_context/interface_boundary.ts"];
const summary = {
  metadata: {nodeVersion: process.version, corpusModules: 15, routingTasks: 36, routingObservations: routingObservations.length,
    boundaryCases: 80, boundaryObservations: 160,
    sourceDigest: canonicalAuthoritySha256(sourceFiles.map(path => ({path, content: readFileSync(new URL(path, import.meta.url), "utf8")}))),
    inputDigest: canonicalAuthoritySha256({modules: BENCHMARK_MODULES, routing: ROUTING_TASKS, boundary: BOUNDARY_CASES}),
    fixtureAdapter: "Summary -> Responsibilities bullet; Public Interface -> Public Interfaces; no corpus edits",
    freshness: "Caller-provided stale paths, identical across arms. No source-digest freshness detection claim.",
    budgetScope: "Selected JSON array, including punctuation; empty contribution costs zero. Omission/readback envelopes are outside this budget.",
    noiseAttribution: "Object bytes plus one separator per object; final array bracket is shared overhead. Empty selection has zero noise and zero recall.",
    limits: "Synthetic retrieval and extraction only; no agent outcomes, signature checking, provider tokens, latency or total-cost qualification. Corpus is not a held-out study; thresholds and bootstrap intervals are exploratory.",
  },
  references: {meanFullSpecSummaryBytes: mean(references.map(row => row.fullSpecSummaryBytes)),
    meanRawFullSpecBytes: mean(references.map(row => row.rawFullSpecBytes)),
    fullSourceBytes: references[0].fullSourceBytes, fullSpecRequiredRecallPercent: 100, fullSpecCompleteCoveragePercent: 100},
  routingSummary, pairedComparisons, boundarySummary, routingObservations, boundaryObservations,
};
console.log("# Living-spec multi-arm evaluation\n");
console.log("Synthetic corpus: 15 modules, 36 tasks, 4 budgets, 6 routing arms = 864 observations; 80 boundary cases × 2 extractors.\n");
console.log("R0 = repository order; R1 = owner + path proximity; R2 = owner + BM25 (k1=1.2, b=0.75); R3-no-deps = owner-only ablation; R3 = one hop; R3-2hop = two hops. All ties use repository path. Oversized candidates are skipped; later candidates may fit.\n");
console.log("Identical block fields and UTF-8 JSON-array accounting; baseline non-owner reason labels match the direct_dependency byte length. Actual transitive_dependency labels cost four additional bytes per block, included in the budget. Corpus headings are explicitly adapted to the production parser. Stale annotations are supplied equally to every arm; graph-unaware selectors can surface them too.\n");
console.log(`Unbounded references: normalized full-spec summaries ${display(summary.references.meanFullSpecSummaryBytes)} mean bytes; raw full specs ${display(summary.references.meanRawFullSpecBytes)} mean bytes; full-source path/content map ${summary.references.fullSourceBytes} bytes. Source and spec representations differ: these are cost references, not interchangeable task inputs.\n`);
console.log("## A. Context routing\n");
console.log("Direct coverage excludes the four transitive tasks. Stale task rate requires every stale required spec to be selected and flagged; JSON also reports per-spec rate.\n");
console.log("| Arm | Budget | Recall % | Complete % | Direct % | Transitive % | Noise % | Mean bytes | Violations | Stale tasks % (n) | Byte reduction vs full specs % |\n|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of routingSummary) console.log(`| ${row.arm} | ${row.budget} | ${display(row.meanRequiredRecallPercent)} | ${display(row.completeTaskCoveragePercent)} | ${display(row.directContractCoveragePercent)} | ${display(row.transitiveCoveragePercent)} | ${display(row.meanIrrelevantNoisePercent)} | ${display(row.meanSerializedBytes)} | ${row.budgetViolations} | ${display(row.staleTaskSurfacedPercent)} (${row.staleRequiredTasks}) | ${display(row.meanByteReductionVsFullSpecPercent)} |`);
console.log("\n### Paired task coverage differences (overall, direct-contract and transitive strata)\n\nFixed-seed 2,000-resample task bootstrap, pointwise descriptive 95% intervals; no multiplicity correction or population-generalization claim.\n");
console.log("| Budget | Treatment | Versus | Stratum | Difference (pp) | 95% interval | ≥10 pp and lower bound >0 |\n|---|---|---|---|---:|---|---|");
for (const row of pairedComparisons) console.log(`| ${row.budget} | ${row.treatment} | ${row.baseline} | ${row.stratum} | ${display(row.coverageDeltaPoints)} | [${row.bootstrap95PercentInterval.map(display).join(", ")}] | ${row.exploratoryTenPointCriterionMet} |`);
console.log("\n## B. Boundary detection\n\nMetrics classify cases, not individual symbols. Export and import labels are evaluated separately; combined drift is their union. Exceptions remain errors and count as misses on positive cases. n/a means a zero denominator. Both extractors use the same set/path policy, checked against the production AST comparator on every successful case.\n");
console.log("| Arm | Signal (70 supported cases) | TP | FP | TN | FN | Errors | Precision % | Recall % | FPR % |\n|---|---|---:|---:|---:|---:|---:|---:|---:|---:|");
for (const row of boundarySummary) for (const [signal, metric] of [["Exports", row.supportedExports], ["Imports", row.supportedImports], ["Combined", row.supportedCombined]] as const) {
  console.log(`| ${row.arm} | ${signal} | ${metric.tp} | ${metric.fp} | ${metric.tn} | ${metric.fn} | ${metric.errors} | ${display(metric.precisionPercent)} | ${display(metric.recallPercent)} | ${display(metric.falsePositivePercent)} |`);
}
console.log("\n| Arm | Syntax-trap combined FPR % (10 cases) | Complex-export recall % (positives / 10 cases) | Complex-export FPR % | Prefix-import recall % (positives / 10 cases) | Signature-only detected / 10 |\n|---|---:|---:|---:|---:|---:|");
for (const row of boundarySummary) console.log(`| ${row.arm} | ${display(row.syntaxTraps.falsePositivePercent)} | ${display(row.complexExports.recallPercent)} (${row.complexExports.tp + row.complexExports.fn}/10) | ${display(row.complexExports.falsePositivePercent)} | ${display(row.prefixImports.recallPercent)} (${row.prefixImports.tp + row.prefixImports.fn}/10) | ${row.signatureOnly.detected}/10 |`);
console.log("\nB0 is a conventional raw-text declaration/from regex: it does not strip comments/strings or resolve destructured bindings. Prefix checking is shared with B1, so prefix-policy successes are not AST-specific gains. Signature-only cases are excluded from supported-case metrics and remain a known detection gap.\n");
console.log(`Limits: ${summary.metadata.limits}\n`);
console.log("## JSON summary\n\n```json");
console.log(JSON.stringify(summary, null, 2));
console.log("```");
