import {posix} from "node:path";
import ts from "typescript";
import type {ModuleKnowledge} from "./module_graph.ts";

export interface ModuleSourceFile {
  readonly filePath: string;
  readonly content: string;
}
export interface InterfaceBoundaryDelta {
  readonly modulePath: string;
  readonly declaredExports: readonly string[];
  readonly observedExports: readonly string[];
  readonly undeclaredExports: readonly string[];
  readonly missingExports: readonly string[];
  readonly forbiddenImports: readonly string[];
  readonly hasDrift: boolean;
  readonly requiresGateReview: boolean;
}

function bindingNames(name: ts.BindingName): string[] {
  if (ts.isIdentifier(name)) return [name.text];
  return name.elements.flatMap(element => ts.isOmittedExpression(element) ? [] : bindingNames(element.name));
}

/** Syntax-only extraction: comments and strings cannot masquerade as declarations.
 * Wildcard re-exports require a resolver; refuse them rather than certify an
 * incomplete public interface. Named re-exports are supported without IO.
 */
export function extractTypeScriptExportsAndImports(sourceCode: string): {exports: string[]; imports: string[]} {
  const source = ts.createSourceFile("module.tsx", sourceCode, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const exports = new Set<string>();
  const imports = new Set<string>();
  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      imports.add(statement.moduleSpecifier.text);
    }
    if (ts.isImportEqualsDeclaration(statement) && ts.isExternalModuleReference(statement.moduleReference)) {
      const expression = statement.moduleReference.expression;
      if (expression && ts.isStringLiteral(expression)) imports.add(expression.text);
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) imports.add(statement.moduleSpecifier.text);
      if (!statement.exportClause) throw new Error("Wildcard re-exports require resolved public interface evidence");
      if (ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) exports.add(element.name.text);
      } else exports.add(statement.exportClause.name.text);
      continue;
    }
    if (ts.isExportAssignment(statement)) { exports.add("default"); continue; }
    const modifiers = ts.canHaveModifiers(statement) ? ts.getModifiers(statement) : undefined;
    if (!modifiers?.some(modifier => modifier.kind === ts.SyntaxKind.ExportKeyword)) continue;
    if (modifiers.some(modifier => modifier.kind === ts.SyntaxKind.DefaultKeyword)) {
      exports.add("default"); continue;
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) for (const name of bindingNames(declaration.name)) exports.add(name);
    } else if ((ts.isFunctionDeclaration(statement) || ts.isClassDeclaration(statement)
      || ts.isInterfaceDeclaration(statement) || ts.isTypeAliasDeclaration(statement)
      || ts.isEnumDeclaration(statement) || ts.isModuleDeclaration(statement)) && statement.name) {
      exports.add(statement.name.text);
    }
  }
  return {exports: [...exports].sort(), imports: [...imports].sort()};
}

function isWithin(path: string, module: string): boolean {
  return module === "." ? path !== ".." && !path.startsWith("../") && !posix.isAbsolute(path)
    : path === module || path.startsWith(`${module}/`);
}

export function comparePublicInterfaces(moduleKnowledge: ModuleKnowledge, sourceFiles: readonly ModuleSourceFile[]): InterfaceBoundaryDelta {
  const declaredExports = [...new Set(moduleKnowledge.publicInterfaces.map(item => item.name))].sort();
  const observed = new Set<string>();
  const forbidden = new Set<string>();
  for (const file of sourceFiles) {
    const filePath = posix.normalize(file.filePath.replaceAll("\\", "/"));
    if (!isWithin(filePath, moduleKnowledge.modulePath)) throw new Error(`Source outside module ${moduleKnowledge.modulePath}: ${file.filePath}`);
    const extracted = extractTypeScriptExportsAndImports(file.content);
    for (const name of extracted.exports) observed.add(name);
    for (const specifier of extracted.imports) {
      const relative = specifier.startsWith("./") || specifier.startsWith("../");
      const target = relative ? posix.normalize(posix.join(posix.dirname(filePath), specifier)) : specifier;
      const internal = relative && isWithin(target, moduleKnowledge.modulePath);
      const allowed = internal || moduleKnowledge.allowedDependencies.some(dependency => isWithin(target, dependency));
      if (!allowed) forbidden.add(specifier);
    }
  }
  const observedExports = [...observed].sort();
  const declared = new Set(declaredExports);
  const undeclaredExports = observedExports.filter(name => !declared.has(name));
  const missingExports = declaredExports.filter(name => !observed.has(name));
  const forbiddenImports = [...forbidden].sort();
  const hasDrift = undeclaredExports.length > 0 || missingExports.length > 0 || forbiddenImports.length > 0;
  return {modulePath: moduleKnowledge.modulePath, declaredExports, observedExports,
    undeclaredExports, missingExports, forbiddenImports, hasDrift, requiresGateReview: hasDrift};
}
