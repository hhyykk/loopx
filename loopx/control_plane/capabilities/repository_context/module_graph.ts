import {posix} from "node:path";
import {canonicalAuthoritySha256} from "../../coordination/authority_store_codec.ts";

export interface SpecDocumentInput {
  readonly modulePath: string;
  readonly specPath: string;
  readonly content: string;
  readonly observedLastModifiedRevision?: string;
}

export interface ModuleDependency {
  readonly from: string;
  readonly to: string;
}

export interface ModuleKnowledge {
  readonly modulePath: string;
  readonly specPath: string;
  readonly specDigest: string;
  readonly observedLastModifiedRevision?: string;
  readonly responsibilities: readonly string[];
  readonly publicInterfaces: readonly {readonly name: string; readonly declaration: string}[];
  readonly allowedDependencies: readonly string[];
  readonly invariants: readonly string[];
}

export interface ModuleKnowledgeGraph {
  readonly modules: readonly ModuleKnowledge[];
  readonly edges: readonly ModuleDependency[];
}

function repositoryPath(value: string): string {
  const path = posix.normalize(value.replaceAll("\\", "/")).replace(/\/$/, "");
  if (!value.trim() || posix.isAbsolute(path) || path === ".." || path.startsWith("../")) {
    throw new Error(`Expected a repository-relative path: ${value}`);
  }
  return path;
}

function unquote(value: string): string {
  return value.replace(/^`([^`]+)`/, "$1").trim();
}

/** Parse only actual level-two sections and bullets outside fenced examples. */
export function parseModuleSpec(input: SpecDocumentInput): ModuleKnowledge {
  const sections = new Map<string, string[]>();
  let section: string | undefined;
  let fence: string | undefined;
  for (const line of input.content.split(/\r?\n/)) {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker) {
      if (!fence) fence = marker;
      else if (marker[0] === fence[0] && marker.length >= fence.length) fence = undefined;
      continue;
    }
    if (fence) continue;
    const heading = /^ {0,3}(#{1,6})\s+(.+?)\s*#*\s*$/.exec(line);
    if (heading) {
      section = heading[1].length === 2 ? heading[2].trim() : undefined;
      if (section && !sections.has(section)) sections.set(section, []);
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.+?)\s*$/.exec(line);
    if (section && bullet) sections.get(section)!.push(bullet[1]);
  }
  const publicInterfaces = (sections.get("Public Interfaces") ?? []).map(declaration => {
    const name = /^(?:export\s+)?(?:(?:async\s+)?function\s+|class\s+|interface\s+|type\s+|const\s+|let\s+|var\s+)?([$\p{ID_Start}][$\p{ID_Continue}]*)/u.exec(unquote(declaration))?.[1];
    if (!name) throw new Error(`Invalid public interface in ${input.specPath}: ${declaration}`);
    return {name, declaration};
  });
  return {
    modulePath: repositoryPath(input.modulePath), specPath: repositoryPath(input.specPath),
    specDigest: canonicalAuthoritySha256({specPath: input.specPath, content: input.content}),
    ...(input.observedLastModifiedRevision === undefined ? {} : {
      observedLastModifiedRevision: input.observedLastModifiedRevision,
    }),
    responsibilities: sections.get("Responsibilities") ?? [], publicInterfaces,
    allowedDependencies: [...new Set((sections.get("Allowed Dependencies") ?? []).map(value => repositoryPath(unquote(value))))].sort(),
    invariants: sections.get("Invariants") ?? [],
  };
}

/** Invalid graphs fail explicitly; routing must never silently use partial knowledge. */
export function buildModuleKnowledgeGraph(specs: readonly SpecDocumentInput[]): ModuleKnowledgeGraph {
  const modules = specs.map(parseModuleSpec).sort((a, b) => a.modulePath < b.modulePath ? -1 : a.modulePath > b.modulePath ? 1 : 0);
  const byPath = new Map<string, ModuleKnowledge>();
  for (const module of modules) {
    if (byPath.has(module.modulePath)) throw new Error(`Duplicate module: ${module.modulePath}`);
    byPath.set(module.modulePath, module);
  }
  const edges: ModuleDependency[] = [];
  for (const module of modules) for (const target of module.allowedDependencies) {
    if (!byPath.has(target)) throw new Error(`Missing dependency module: ${module.modulePath} -> ${target}`);
    edges.push({from: module.modulePath, to: target});
  }
  const visited = new Set<string>();
  const active = new Set<string>();
  const trail: string[] = [];
  function visit(path: string): void {
    if (active.has(path)) throw new Error(`Module dependency cycle: ${[...trail, path].join(" -> ")}`);
    if (visited.has(path)) return;
    active.add(path); trail.push(path);
    for (const target of byPath.get(path)!.allowedDependencies) visit(target);
    trail.pop(); active.delete(path); visited.add(path);
  }
  for (const module of modules) visit(module.modulePath);
  return {modules, edges};
}
