import fs from "node:fs";
import path from "node:path";
import * as ts from "typescript";
import { resolveRepositoryPath, tokenizeCommand } from "../../core/src/safety";
import type { LanguageId } from "../../core/src/types";
import { isSupportedSourceFile, languageForFile } from "../../language-core/src";
import { validateLanguageSource, type SyntaxValidationResult } from "../../language-validation/src";

export interface ImportReference {
  specifier: string;
  names: string[];
  resolvedFile?: string;
  line: number;
  dynamic: boolean;
}

export interface SymbolNode {
  id: string;
  name: string;
  kind: string;
  file: string;
  line: number;
  endLine: number;
  start: number;
  end: number;
  exported: boolean;
  parent?: string;
}

export interface SymbolReference {
  name: string;
  fromFile: string;
  line: number;
  kind: "call" | "reference" | "import";
}

export interface RouteReference {
  method: string;
  path?: string;
  file: string;
  line: number;
  symbol?: string;
}

export interface ModuleNode {
  file: string;
  language: LanguageId;
  imports: ImportReference[];
  exports: string[];
  symbols: SymbolNode[];
  references: SymbolReference[];
  routes: RouteReference[];
  dynamicReferences: string[];
  unknowns: string[];
  packageName?: string;
  syntaxValidation?: SyntaxValidationResult;
}

export interface SymbolGraph {
  root: string;
  modules: Map<string, ModuleNode>;
  symbols: Map<string, SymbolNode>;
  byName: Map<string, SymbolNode[]>;
  unknowns: string[];
}

const SCRIPT_EXTENSIONS = new Set([".ts", ".tsx", ".js", ".jsx", ".mjs", ".cjs"]);
const MODULE_EXTENSIONS = [...SCRIPT_EXTENSIONS, ".d.ts"];

interface TypeScriptPathConfig {
  baseDirectory: string;
  paths: Array<[string, string[]]>;
}

interface GoModuleInfo {
  modulePath: string;
  directory: string;
}

const typeScriptPathConfigCache = new Map<string, TypeScriptPathConfig | null>();
const goModuleCache = new Map<string, GoModuleInfo[]>();

function lineAt(source: ts.SourceFile, position: number): number {
  return source.getLineAndCharacterOfPosition(position).line + 1;
}

function fileKind(file: string): ts.ScriptKind {
  const extension = path.extname(file).toLowerCase();
  if (extension === ".tsx") return ts.ScriptKind.TSX;
  if (extension === ".jsx") return ts.ScriptKind.JSX;
  if (extension === ".js" || extension === ".mjs" || extension === ".cjs") return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

function hasExportModifier(node: ts.Node): boolean {
  return (ts.getCombinedModifierFlags(node as ts.Declaration) & ts.ModifierFlags.Export) !== 0;
}

function symbolName(node: ts.NamedDeclaration): string | undefined {
  if (!node.name) return undefined;
  return ts.isIdentifier(node.name) || ts.isStringLiteral(node.name) ? node.name.text : node.name.getText();
}

function moduleCandidates(base: string): string[] {
  return [base, ...MODULE_EXTENSIONS.map((extension) => `${base}${extension}`), ...MODULE_EXTENSIONS.map((extension) => path.join(base, `index${extension}`))];
}

function nearestFile(root: string, fromFile: string, fileName: string): string | undefined {
  const rootAbsolute = path.resolve(root);
  let directory = path.dirname(path.resolve(rootAbsolute, fromFile));
  while (directory === rootAbsolute || directory.startsWith(`${rootAbsolute}${path.sep}`)) {
    const candidate = path.join(directory, fileName);
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return candidate;
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function typeScriptPathConfig(root: string, fromFile: string): TypeScriptPathConfig | undefined {
  const configFile = nearestFile(root, fromFile, "tsconfig.json");
  if (!configFile) return undefined;
  const cacheKey = `${path.resolve(root)}:${configFile}`;
  if (typeScriptPathConfigCache.has(cacheKey)) return typeScriptPathConfigCache.get(cacheKey) ?? undefined;
  try {
    const parsed = ts.readConfigFile(configFile, ts.sys.readFile);
    const compilerOptions = parsed.config?.compilerOptions;
    const rawPaths = compilerOptions?.paths;
    if (parsed.error || !rawPaths || typeof rawPaths !== "object") {
      typeScriptPathConfigCache.set(cacheKey, null);
      return undefined;
    }
    const baseUrl = typeof compilerOptions.baseUrl === "string" ? path.resolve(path.dirname(configFile), compilerOptions.baseUrl) : path.dirname(configFile);
    const paths = Object.entries(rawPaths as Record<string, unknown>)
      .filter((entry): entry is [string, string[]] => Array.isArray(entry[1]) && entry[1].every((value) => typeof value === "string"))
      .map(([pattern, targets]) => [pattern, targets as string[]] as [string, string[]]);
    const result = { baseDirectory: baseUrl, paths };
    typeScriptPathConfigCache.set(cacheKey, result);
    return result;
  } catch {
    typeScriptPathConfigCache.set(cacheKey, null);
    return undefined;
  }
}

function typeScriptPathAliasCandidates(root: string, fromFile: string, specifier: string): { candidates: string[]; matched: boolean } {
  const config = typeScriptPathConfig(root, fromFile);
  if (!config) return { candidates: [], matched: false };
  const candidates: string[] = [];
  let matched = false;
  for (const [pattern, targets] of config.paths) {
    let wildcard: string | undefined;
    if (pattern.includes("*")) {
      const [prefix, suffix = ""] = pattern.split("*", 2);
      if (!specifier.startsWith(prefix) || !specifier.endsWith(suffix) || specifier.length < prefix.length + suffix.length) continue;
      wildcard = specifier.slice(prefix.length, specifier.length - suffix.length || undefined);
    } else if (specifier !== pattern) continue;
    matched = true;
    for (const target of targets) {
      const substituted = wildcard === undefined ? target : target.replaceAll("*", wildcard);
      candidates.push(...moduleCandidates(path.resolve(config.baseDirectory, substituted)));
    }
  }
  return { candidates, matched };
}

function isTypeScriptPathAlias(root: string, fromFile: string, specifier: string): boolean {
  return typeScriptPathAliasCandidates(root, fromFile, specifier).matched;
}

function resolveModule(root: string, fromFile: string, specifier: string): string | undefined {
  const base = specifier.startsWith(".") ? path.resolve(path.dirname(path.join(root, fromFile)), specifier) : undefined;
  const candidates = base ? moduleCandidates(base) : typeScriptPathAliasCandidates(root, fromFile, specifier).candidates;
  for (const candidate of candidates) {
    try {
      const safeCandidate = resolveRepositoryPath(root, candidate);
      if (fs.existsSync(safeCandidate) && fs.statSync(safeCandidate).isFile()) return path.relative(root, safeCandidate).split(path.sep).join("/");
    } catch {
      // A traversal or symlink escape is intentionally left unresolved and recorded by the caller.
    }
  }
  return undefined;
}

function getPackageName(root: string, file: string): string | undefined {
  let directory = path.dirname(path.join(root, file));
  while (directory === root || directory.startsWith(`${root}${path.sep}`)) {
    const packageFile = path.join(directory, "package.json");
    if (fs.existsSync(packageFile)) {
      try {
        return JSON.parse(fs.readFileSync(packageFile, "utf8")).name as string | undefined;
      } catch {
        return undefined;
      }
    }
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return undefined;
}

function parseTypeScriptSource(file: string, text: string, root: string): ModuleNode {
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, fileKind(file));
  const module: ModuleNode = {
    file,
    language: languageForFile(file) ?? "typescript",
    imports: [],
    exports: [],
    symbols: [],
    references: [],
    routes: [],
    dynamicReferences: [],
    unknowns: [],
    packageName: getPackageName(root, file),
  };
  const parseDiagnostics = (source as ts.SourceFile & { parseDiagnostics?: ts.Diagnostic[] }).parseDiagnostics ?? [];
  if (parseDiagnostics.length) module.unknowns.push(...parseDiagnostics.slice(0, 10).map((diagnostic: ts.Diagnostic) => `Parser syntax uncertainty at ${file}:${lineAt(source, diagnostic.start ?? 0)}.`));

  const addSymbol = (node: ts.NamedDeclaration, kind: string, parent?: string) => {
    const name = symbolName(node);
    if (!name) return;
    const start = node.getStart(source);
    const end = node.getEnd();
    const symbol: SymbolNode = {
      id: `${file}:${name}:${start}`,
      name,
      kind,
      file,
      line: lineAt(source, start),
      endLine: lineAt(source, end),
      start,
      end,
      exported: hasExportModifier(node) || module.exports.includes(name),
      parent,
    };
    module.symbols.push(symbol);
    if (symbol.exported && !module.exports.includes(name)) module.exports.push(name);
  };

  for (const statement of source.statements) {
    if (ts.isImportDeclaration(statement)) {
      const specifier = ts.isStringLiteral(statement.moduleSpecifier) ? statement.moduleSpecifier.text : "";
      const names: string[] = [];
      if (statement.importClause) {
        if (statement.importClause.name) names.push("default");
        const bindings = statement.importClause.namedBindings;
        if (bindings && ts.isNamespaceImport(bindings)) names.push("*");
        if (bindings && ts.isNamedImports(bindings)) for (const element of bindings.elements) names.push(element.propertyName?.text ?? element.name.text);
      }
      const resolvedFile = resolveModule(root, file, specifier);
      module.imports.push({ specifier, names, resolvedFile, line: lineAt(source, statement.getStart(source)), dynamic: false });
      if ((specifier.startsWith(".") || isTypeScriptPathAlias(root, file, specifier)) && !resolvedFile) module.unknowns.push(`Unresolved local import at ${file}:${lineAt(source, statement.getStart(source))}: ${specifier}`);
    }
    if (ts.isExportDeclaration(statement)) {
      if (statement.exportClause && ts.isNamedExports(statement.exportClause)) {
        for (const element of statement.exportClause.elements) module.exports.push(element.name.text);
      }
      if (statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
        const specifier = statement.moduleSpecifier.text;
        const resolvedFile = resolveModule(root, file, specifier);
        module.imports.push({ specifier, names: ["*"], resolvedFile, line: lineAt(source, statement.getStart(source)), dynamic: false });
        if ((specifier.startsWith(".") || isTypeScriptPathAlias(root, file, specifier)) && !resolvedFile) module.unknowns.push(`Unresolved local re-export at ${file}:${lineAt(source, statement.getStart(source))}: ${specifier}`);
      }
    }
    if (ts.isExportAssignment(statement)) module.exports.push("default");
  }

  const visit = (node: ts.Node, parent?: string) => {
    if (ts.isFunctionDeclaration(node)) addSymbol(node, "function", parent);
    else if (ts.isClassDeclaration(node)) addSymbol(node, "class", parent);
    else if (ts.isMethodDeclaration(node)) addSymbol(node, "method", parent);
    else if (ts.isConstructorDeclaration(node)) addSymbol(node, "constructor", parent);
    else if (ts.isInterfaceDeclaration(node)) addSymbol(node, "interface", parent);
    else if (ts.isTypeAliasDeclaration(node)) addSymbol(node, "type", parent);
    else if (ts.isEnumDeclaration(node)) addSymbol(node, "enum", parent);
    else if (ts.isModuleDeclaration(node)) addSymbol(node, "namespace", parent);
    else if (ts.isVariableDeclaration(node) && node.initializer && (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) addSymbol(node, "function", parent);

    let nextParent = parent;
    const maybeName = "name" in node ? symbolName(node as ts.NamedDeclaration) : undefined;
    if (ts.isClassDeclaration(node) && maybeName) nextParent = maybeName;

    if (ts.isCallExpression(node)) {
      const expression = node.expression.getText(source);
      const name = ts.isIdentifier(node.expression) ? node.expression.text : expression.split(".").at(-1);
      if (name) module.references.push({ name, fromFile: file, line: lineAt(source, node.getStart(source)), kind: "call" });
      const routeMethod = expression.match(/(?:^|\.)(get|post|put|patch|delete|head|options|all|route|use)$/i)?.[1];
      if (routeMethod) {
        const first = node.arguments[0];
        const routePath = first && ts.isStringLiteral(first) ? first.text : undefined;
        module.routes.push({ method: routeMethod.toUpperCase(), path: routePath, file, line: lineAt(source, node.getStart(source)), symbol: nextParent });
      }
      if (node.expression.kind === ts.SyntaxKind.ImportKeyword) {
        const argument = node.arguments[0];
        const specifier = argument && ts.isStringLiteral(argument) ? argument.text : undefined;
        if (specifier) {
          const resolvedFile = resolveModule(root, file, specifier);
          module.imports.push({ specifier, names: ["*"], resolvedFile, line: lineAt(source, node.getStart(source)), dynamic: true });
          if ((specifier.startsWith(".") || isTypeScriptPathAlias(root, file, specifier)) && !resolvedFile) module.unknowns.push(`Unresolved local dynamic import at ${file}:${lineAt(source, node.getStart(source))}: ${specifier}`);
        } else {
          module.dynamicReferences.push(`dynamic import at ${file}:${lineAt(source, node.getStart(source))}`);
          module.unknowns.push(`Dynamic import target is not statically known at ${file}:${lineAt(source, node.getStart(source))}.`);
        }
      }
    }
    const parentNode = node.parent;
    const declarationName = Boolean(parentNode && (ts.isVariableDeclaration(parentNode) && parentNode.name === node || ts.isFunctionDeclaration(parentNode) && parentNode.name === node || ts.isClassDeclaration(parentNode) && parentNode.name === node || ts.isParameter(parentNode) && parentNode.name === node || ts.isPropertyDeclaration(parentNode) && parentNode.name === node || ts.isMethodDeclaration(parentNode) && parentNode.name === node || ts.isInterfaceDeclaration(parentNode) && parentNode.name === node || ts.isTypeAliasDeclaration(parentNode) && parentNode.name === node || ts.isEnumDeclaration(parentNode) && parentNode.name === node));
    const importName = Boolean(parentNode && (ts.isImportClause(parentNode) || ts.isImportSpecifier(parentNode) || ts.isNamespaceImport(parentNode) || ts.isExportSpecifier(parentNode)));
    if (ts.isIdentifier(node) && !declarationName && !importName) {
      module.references.push({ name: node.text, fromFile: file, line: lineAt(source, node.getStart(source)), kind: "reference" });
    }
    ts.forEachChild(node, (child) => visit(child, nextParent));
  };
  visit(source);

  for (const symbol of module.symbols) symbol.exported = symbol.exported || module.exports.includes(symbol.name);
  return module;
}

interface GenericLine {
  number: number;
  text: string;
  start: number;
  end: number;
}

interface GenericParserContext {
  root: string;
  file: string;
  language: LanguageId;
  module: ModuleNode;
  lines: GenericLine[];
}

function genericLines(text: string): GenericLine[] {
  const lines: GenericLine[] = [];
  let offset = 0;
  for (const [index, textLine] of text.split(/\r?\n/).entries()) {
    lines.push({ number: index + 1, text: textLine, start: offset, end: offset + textLine.length });
    offset += textLine.length + 1;
  }
  return lines;
}

function safeExistingFile(root: string, candidate: string): string | undefined {
  try {
    const absolute = resolveRepositoryPath(root, candidate);
    if (!fs.existsSync(absolute) || !fs.statSync(absolute).isFile()) return undefined;
    return path.relative(root, absolute).split(path.sep).join("/");
  } catch {
    return undefined;
  }
}

function firstExistingFile(root: string, candidates: string[]): string | undefined {
  for (const candidate of candidates) {
    const found = safeExistingFile(root, candidate);
    if (found) return found;
  }
  return undefined;
}

function addGenericSymbol(context: GenericParserContext, name: string, kind: string, line: GenericLine, exported: boolean, parent?: string): void {
  const trimmed = name.trim();
  if (!trimmed) return;
  const symbol: SymbolNode = {
    id: `${context.file}:${trimmed}:${line.start}`,
    name: trimmed,
    kind,
    file: context.file,
    line: line.number,
    endLine: line.number,
    start: line.start,
    end: line.end,
    exported,
    parent,
  };
  context.module.symbols.push(symbol);
  if (exported && !context.module.exports.includes(trimmed)) context.module.exports.push(trimmed);
}

function addGenericImport(context: GenericParserContext, line: GenericLine, specifier: string, names: string[], resolvedFile?: string, dynamic = false): void {
  const cleaned = specifier.trim();
  if (!cleaned) return;
  context.module.imports.push({ specifier: cleaned, names, resolvedFile, line: line.number, dynamic });
  if ((cleaned.startsWith(".") || resolvedFile === undefined) && !resolvedFile && (cleaned.startsWith(".") || context.language !== "python")) {
    context.module.unknowns.push(`Unresolved ${context.language} import at ${context.file}:${line.number}: ${cleaned}`);
  }
}

function pythonModuleCandidates(root: string, fromFile: string, specifier: string): string[] {
  const normalized = specifier.trim();
  let directory = path.dirname(path.join(root, fromFile));
  let remainder = normalized;
  if (remainder.startsWith(".")) {
    let dots = 0;
    while (remainder[dots] === ".") dots += 1;
    for (let index = 1; index < dots; index += 1) directory = path.dirname(directory);
    remainder = remainder.slice(dots);
    if (remainder.startsWith(".")) remainder = remainder.slice(1);
    const base = path.join(directory, ...remainder.split(".").filter(Boolean));
    return [base, `${base}.py`, path.join(base, "__init__.py")];
  }
  const roots = new Set<string>();
  const rootAbsolute = path.resolve(root);
  let searchDirectory = path.resolve(directory);
  while (searchDirectory === rootAbsolute || searchDirectory.startsWith(`${rootAbsolute}${path.sep}`)) {
    for (const candidate of [searchDirectory, path.join(searchDirectory, "src"), path.join(searchDirectory, "lib"), path.join(searchDirectory, "python")]) roots.add(candidate);
    const parent = path.dirname(searchDirectory);
    if (parent === searchDirectory) break;
    searchDirectory = parent;
  }
  const segments = remainder.split(".").filter(Boolean);
  return [...roots].flatMap((searchRoot) => {
    const base = path.join(searchRoot, ...segments);
    return [base, `${base}.py`, path.join(base, "__init__.py")];
  });
}

function resolvePythonModule(root: string, fromFile: string, specifier: string): string | undefined {
  return firstExistingFile(root, pythonModuleCandidates(root, fromFile, specifier));
}

function parsePython(context: GenericParserContext): void {
  for (const line of context.lines) {
    const importMatch = line.text.match(/^\s*import\s+(.+?)(?:\s+#.*)?$/);
    const fromMatch = line.text.match(/^\s*from\s+([.\w]+)\s+import\s+(.+?)(?:\s+#.*)?$/);
    if (importMatch) {
      for (const item of importMatch[1]!.split(",")) {
        const specifier = item.trim().split(/\s+as\s+/i)[0] ?? "";
        addGenericImport(context, line, specifier, [item.trim().split(/\s+as\s+/i)[1] ?? specifier.split(".").at(-1) ?? specifier], resolvePythonModule(context.root, context.file, specifier));
      }
    } else if (fromMatch) {
      const specifier = fromMatch[1]!;
      const names = fromMatch[2]!.split(",").map((item) => item.trim().split(/\s+as\s+/i)[0] ?? "").filter(Boolean);
      addGenericImport(context, line, specifier, names, resolvePythonModule(context.root, context.file, specifier));
    }
    const functionMatch = line.text.match(/^\s*(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
    const classMatch = line.text.match(/^\s*class\s+([A-Za-z_]\w*)\b/);
    if (functionMatch) addGenericSymbol(context, functionMatch[1]!, "function", line, !functionMatch[1]!.startsWith("_"));
    if (classMatch) addGenericSymbol(context, classMatch[1]!, "class", line, !classMatch[1]!.startsWith("_"));
    const routeMatch = line.text.match(/@\s*\w+\.(get|post|put|patch|delete|route)\s*\(\s*["']([^"']+)["']/i);
    if (routeMatch) context.module.routes.push({ method: routeMatch[1]!.toUpperCase(), path: routeMatch[2], file: context.file, line: line.number });
    if (/\b(?:importlib\.import_module|__import__|eval|exec)\s*\(/.test(line.text)) {
      context.module.dynamicReferences.push(`dynamic Python reference at ${context.file}:${line.number}`);
      context.module.unknowns.push(`Dynamic Python import or evaluation is not statically known at ${context.file}:${line.number}.`);
    }
  }
}

function goModuleFromDirectory(directory: string): GoModuleInfo | undefined {
  const file = path.join(directory, "go.mod");
  if (!fs.existsSync(file)) return undefined;
  try {
    const match = fs.readFileSync(file, "utf8").match(/^\s*module\s+([^\s]+)\s*$/m);
    return match?.[1] ? { modulePath: match[1], directory } : undefined;
  } catch {
    return undefined;
  }
}

function goModules(root: string): GoModuleInfo[] {
  const rootAbsolute = path.resolve(root);
  const cached = goModuleCache.get(rootAbsolute);
  if (cached) return cached;
  const modules: GoModuleInfo[] = [];
  const skipped = new Set([".git", "node_modules", "vendor", "dist", "build", "coverage", "target"]);
  let visited = 0;
  const visit = (directory: string) => {
    if (visited >= 2_000) return;
    visited += 1;
    const module = goModuleFromDirectory(directory);
    if (module) modules.push(module);
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (!entry.isDirectory() || entry.isSymbolicLink() || skipped.has(entry.name) || entry.name.startsWith(".")) continue;
      visit(path.join(directory, entry.name));
    }
  };
  visit(rootAbsolute);
  const result = [...new Map(modules.map((module) => [module.directory, module])).values()].sort((left, right) => right.modulePath.length - left.modulePath.length || left.directory.localeCompare(right.directory));
  goModuleCache.set(rootAbsolute, result);
  return result;
}

function resolveGoPackage(root: string, fromFile: string, specifier: string): string | undefined {
  let directory: string | undefined;
  if (specifier.startsWith(".")) directory = path.resolve(path.dirname(path.join(root, fromFile)), specifier);
  else {
    const module = goModules(root).find((candidate) => specifier === candidate.modulePath || specifier.startsWith(`${candidate.modulePath}/`));
    if (module) directory = path.join(module.directory, specifier.slice(module.modulePath.length).replace(/^\//, ""));
  }
  if (!directory) return undefined;
  const direct = safeExistingFile(root, directory);
  if (direct) return direct;
  try {
    const entries = fs.readdirSync(directory, { withFileTypes: true }).filter((entry) => entry.isFile() && entry.name.endsWith(".go") && !entry.name.endsWith("_test.go")).sort((left, right) => left.name.localeCompare(right.name));
    return entries[0] ? safeExistingFile(root, path.join(directory, entries[0].name)) : undefined;
  } catch {
    return undefined;
  }
}

function parseGo(context: GenericParserContext): void {
  let inImportBlock = false;
  for (const line of context.lines) {
    const trimmed = line.text.trim();
    if (/^import\s*\($/.test(trimmed)) {
      inImportBlock = true;
      continue;
    }
    if (inImportBlock && trimmed === ")") {
      inImportBlock = false;
      continue;
    }
    const importMatch = line.text.match(/^\s*import\s+(?:(\w+)\s+)?"([^"]+)"/);
    const blockImportMatch = inImportBlock ? line.text.match(/^\s*(?:(\w+)\s+)?"([^"]+)"/) : undefined;
    const matchedImport = importMatch ?? blockImportMatch;
    if (matchedImport) {
      const alias = matchedImport[1];
      const specifier = matchedImport[2]!;
      addGenericImport(context, line, specifier, [alias ?? specifier.split("/").at(-1) ?? specifier], resolveGoPackage(context.root, context.file, specifier));
    }
    const functionMatch = line.text.match(/^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)\s*\(/);
    const typeMatch = line.text.match(/^\s*type\s+([A-Za-z_]\w*)\b/);
    const constMatch = line.text.match(/^\s*(?:const|var)\s+([A-Za-z_]\w*)\b/);
    if (functionMatch) addGenericSymbol(context, functionMatch[1]!, "function", line, /^[A-Z]/.test(functionMatch[1]!));
    if (typeMatch) addGenericSymbol(context, typeMatch[1]!, "type", line, /^[A-Z]/.test(typeMatch[1]!));
    if (constMatch) addGenericSymbol(context, constMatch[1]!, "variable", line, /^[A-Z]/.test(constMatch[1]!));
    if (/^\s*\/\/\s*go:(?:build|generate|linkname)\b/.test(line.text)) context.module.unknowns.push(`Go directive may change the reachable graph at ${context.file}:${line.number}.`);
  }
}

function rustModuleCandidates(root: string, fromFile: string, specifier: string): string[] {
  const segments = specifier.replace(/;.*$/, "").replace(/\{.*$/, "").split("::").map((segment) => segment.trim()).filter(Boolean);
  const fileDirectory = path.dirname(path.join(root, fromFile));
  const fileBase = path.basename(fromFile, path.extname(fromFile));
  let directory = fileBase && !["mod", "lib", "main"].includes(fileBase) ? path.join(fileDirectory, fileBase) : fileDirectory;
  while (segments[0] === "super") {
    directory = path.dirname(directory);
    segments.shift();
  }
  if (segments[0] === "self") segments.shift();
  if (segments[0] === "crate") {
    const cargoFile = nearestFile(root, fromFile, "Cargo.toml");
    directory = path.join(cargoFile ? path.dirname(cargoFile) : root, "src");
    segments.shift();
  }
  const base = path.join(directory, ...segments);
  return [base, `${base}.rs`, path.join(base, "mod.rs")];
}

function resolveRustModule(root: string, fromFile: string, specifier: string): string | undefined {
  const segments = specifier.replace(/;.*$/, "").replace(/\{.*$/, "").split("::").filter(Boolean);
  for (let length = segments.length; length >= 1; length -= 1) {
    const candidate = firstExistingFile(root, rustModuleCandidates(root, fromFile, segments.slice(0, length).join("::")));
    if (candidate) return candidate;
  }
  return undefined;
}

function parseRust(context: GenericParserContext): void {
  for (const line of context.lines) {
    const useMatch = line.text.match(/^\s*(?:pub\s+)?use\s+([^;]+);/);
    const modMatch = line.text.match(/^\s*(?:pub\s+)?mod\s+([A-Za-z_]\w*)\s*;/);
    if (useMatch) {
      const specifier = useMatch[1]!.trim();
      addGenericImport(context, line, specifier, [specifier.split("::").at(-1) ?? specifier], resolveRustModule(context.root, context.file, specifier));
    }
    if (modMatch) {
      const specifier = modMatch[1]!;
      addGenericImport(context, line, specifier, [specifier], resolveRustModule(context.root, context.file, specifier));
      addGenericSymbol(context, specifier, "module", line, /^\s*pub\b/.test(line.text));
    }
    const declarationMatch = line.text.match(/^\s*((?:pub(?:\([^)]*\))?\s+)?(?:(?:async)\s+)?(?:fn|struct|enum|trait|impl|type|const|static))\s+([A-Za-z_]\w*)\b/);
    if (declarationMatch) {
      const kind = declarationMatch[1]!.replace(/^pub(?:\([^)]*\))?\s+/, "").replace(/^async\s+/, "");
      addGenericSymbol(context, declarationMatch[2]!, kind, line, /^\s*pub(?:\b|\()/ .test(line.text));
    }
    const macroMatch = line.text.match(/\bmacro_rules!\s*([A-Za-z_]\w*)/);
    if (macroMatch) {
      addGenericSymbol(context, macroMatch[1]!, "macro", line, /^\s*pub\b/.test(line.text));
      context.module.dynamicReferences.push(`Rust macro at ${context.file}:${line.number}`);
      context.module.unknowns.push(`Rust macro expansion is not statically evaluated at ${context.file}:${line.number}.`);
    }
    if (/\b(?:include|include_bytes|env|cfg)!\s*\(/.test(line.text) || /#\s*\[\s*derive\s*\(/.test(line.text)) {
      context.module.dynamicReferences.push(`Rust compile-time expression at ${context.file}:${line.number}`);
      context.module.unknowns.push(`Rust compile-time macro or derive may change behavior at ${context.file}:${line.number}.`);
    }
    const routeMatch = line.text.match(/#\s*\[\s*(get|post|put|patch|delete|route)\s*(?:\(\s*["']([^"']+)["'])?/i);
    if (routeMatch) context.module.routes.push({ method: routeMatch[1]!.toUpperCase(), path: routeMatch[2], file: context.file, line: line.number });
  }
}

interface CompileCommandEntry {
  directory?: string;
  file?: string;
  arguments?: unknown;
  command?: unknown;
}

const compileDatabaseCache = new Map<string, CompileCommandEntry[] | null>();

function compileCommandsFile(root: string, fromFile: string): string | undefined {
  const rootAbsolute = path.resolve(root);
  const candidates: string[] = [path.join(rootAbsolute, "compile_commands.json"), path.join(rootAbsolute, "build", "compile_commands.json")];
  let directory = path.dirname(path.join(rootAbsolute, fromFile));
  while (directory === rootAbsolute || directory.startsWith(`${rootAbsolute}${path.sep}`)) {
    candidates.push(path.join(directory, "compile_commands.json"), path.join(directory, "build", "compile_commands.json"));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...new Set(candidates)].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function readCompileCommands(file: string): CompileCommandEntry[] | undefined {
  if (compileDatabaseCache.has(file)) return compileDatabaseCache.get(file) ?? undefined;
  try {
    if (fs.statSync(file).size > 4 * 1024 * 1024) {
      compileDatabaseCache.set(file, null);
      return undefined;
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed) ? parsed.filter((entry): entry is CompileCommandEntry => Boolean(entry) && typeof entry === "object") : [];
    compileDatabaseCache.set(file, entries);
    return entries;
  } catch {
    compileDatabaseCache.set(file, null);
    return undefined;
  }
}

function compileCommandArguments(entry: CompileCommandEntry): string[] {
  if (Array.isArray(entry.arguments) && entry.arguments.every((argument) => typeof argument === "string")) return entry.arguments as string[];
  if (typeof entry.command === "string") {
    try { return tokenizeCommand(entry.command); } catch { return []; }
  }
  return [];
}

function compileIncludeDirectories(root: string, fromFile: string): string[] {
  const database = compileCommandsFile(root, fromFile);
  if (!database) return [];
  const entries = readCompileCommands(database) ?? [];
  const target = path.resolve(root, fromFile);
  const directories: string[] = [];
  for (const entry of entries) {
    if (typeof entry.file !== "string") continue;
    const entryDirectory = typeof entry.directory === "string" ? path.resolve(path.dirname(database), entry.directory) : path.resolve(root);
    const entryFile = path.resolve(entryDirectory, entry.file);
    if (path.normalize(entryFile) !== path.normalize(target)) continue;
    const args = compileCommandArguments(entry);
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      let value: string | undefined;
      if (["-I", "-isystem", "-iquote"].includes(argument)) value = args[index + 1];
      else if (argument.startsWith("-I") || argument.startsWith("-isystem") || argument.startsWith("-iquote")) value = argument.replace(/^-(?:isystem|iquote|I)/, "");
      if (!value) continue;
      const candidate = path.resolve(entryDirectory, value);
      try { directories.push(resolveRepositoryPath(root, candidate)); } catch { /* external include roots remain outside this graph */ }
    }
  }
  return [...new Set(directories)];
}

function resolveCInclude(root: string, fromFile: string, specifier: string): string | undefined {
  const directory = path.dirname(path.join(root, fromFile));
  const includeDirectories = compileIncludeDirectories(root, fromFile);
  return firstExistingFile(root, [path.join(directory, specifier), ...includeDirectories.map((includeDirectory) => path.join(includeDirectory, specifier)), path.join(root, specifier)]);
}

function parseC(context: GenericParserContext): void {
  for (const line of context.lines) {
    const includeMatch = line.text.match(/^\s*#\s*include\s*([<"])([^>"]+)[>"]/);
    if (includeMatch) {
      const specifier = includeMatch[2]!;
      const resolvedFile = resolveCInclude(context.root, context.file, specifier);
      addGenericImport(context, line, specifier, ["*"], resolvedFile);
      if (includeMatch[1] === "<" && !resolvedFile) context.module.unknowns.push(`System C/C++ include is outside the repository graph at ${context.file}:${line.number}: ${specifier}`);
    }
    const typeMatch = line.text.match(/^\s*(?:typedef\s+)?(struct|class|enum|namespace)\s+([A-Za-z_]\w*)\b/);
    const defineMatch = line.text.match(/^\s*#\s*define\s+([A-Za-z_]\w*)\b/);
    if (typeMatch) addGenericSymbol(context, typeMatch[2]!, typeMatch[1]!, line, !/^\s*static\b/.test(line.text));
    if (defineMatch) {
      addGenericSymbol(context, defineMatch[1]!, "macro", line, true);
      context.module.unknowns.push(`C/C++ preprocessor macro may alter control flow at ${context.file}:${line.number}.`);
    }
    const functionMatch = line.text.match(/\b([A-Za-z_]\w*)\s*\([^;{}]*\)\s*(?:const\s*)?(?:\{|;)/);
    if (functionMatch && !/^(if|for|while|switch|catch)$/.test(functionMatch[1]!)) {
      addGenericSymbol(context, functionMatch[1]!, "function", line, !/^\s*static\b/.test(line.text));
    }
    if (/^\s*#\s*(?:if|ifdef|ifndef|elif|else|endif)\b/.test(line.text)) context.module.unknowns.push(`C/C++ conditional compilation is not evaluated at ${context.file}:${line.number}.`);
  }
}

function addGenericReferences(context: GenericParserContext): void {
  const declarationNames = new Set(context.module.symbols.map((symbol) => symbol.name));
  const keywords = new Set(["if", "for", "while", "switch", "catch", "def", "class", "func", "fn", "match", "sizeof"]);
  for (const line of context.lines) {
    const callPattern = /\b([A-Za-z_]\w*)\s*\(/g;
    for (const match of line.text.matchAll(callPattern)) {
      const name = match[1]!;
      if (keywords.has(name)) continue;
      const prefix = line.text.slice(0, match.index ?? 0);
      if (/\b(?:def|func|fn)\s*$/.test(prefix)) continue;
      context.module.references.push({ name, fromFile: context.file, line: line.number, kind: "call" });
    }
    const identifierPattern = /\b([A-Za-z_]\w*)\b/g;
    for (const match of line.text.matchAll(identifierPattern)) {
      const name = match[1]!;
      if (keywords.has(name) || !declarationNames.has(name)) continue;
      context.module.references.push({ name, fromFile: context.file, line: line.number, kind: "reference" });
    }
  }
}

function parseGenericSource(file: string, text: string, root: string, language: LanguageId): ModuleNode {
  const module: ModuleNode = { file, language, imports: [], exports: [], symbols: [], references: [], routes: [], dynamicReferences: [], unknowns: [], packageName: getPackageName(root, file) };
  const context: GenericParserContext = { root, file, language, module, lines: genericLines(text) };
  if (language === "python") parsePython(context);
  else if (language === "go") parseGo(context);
  else if (language === "rust") parseRust(context);
  else parseC(context);
  addGenericReferences(context);
  module.unknowns = [...new Set(module.unknowns)].sort();
  return module;
}

export function parseSource(file: string, text: string, root: string): ModuleNode {
  const language = languageForFile(file);
  if (!language || language === "typescript" || language === "javascript") return parseTypeScriptSource(file, text, root);
  return parseGenericSource(file, text, root, language);
}

export function listSourceFiles(root: string): string[] {
  const files: string[] = [];
  const visit = (directory: string) => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); } catch { return; }
    for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
      if (entry.name.startsWith(".") || ["node_modules", "dist", "build", "coverage", ".git"].includes(entry.name)) continue;
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory() && !entry.isSymbolicLink()) visit(absolute);
      else if (entry.isFile() && isSupportedSourceFile(path.relative(root, absolute))) files.push(path.relative(root, absolute).split(path.sep).join("/"));
    }
  };
  visit(root);
  return files.sort();
}

export interface GraphBuildOptions {
  /** Run bounded, read-only front-end checks for non-TypeScript source files. */
  validateSyntax?: boolean;
  /** Maximum time spent validating one source file. */
  validationTimeoutMs?: number;
  /** Hard cap that prevents a large repository from spawning unbounded validators. */
  maxValidatedFiles?: number;
}

function recordSyntaxValidation(module: ModuleNode, validation: SyntaxValidationResult): void {
  module.syntaxValidation = validation;
  if (validation.status === "valid") return;
  const detail = validation.diagnostics.length ? ` ${validation.diagnostics.join(" ")}` : "";
  const message = validation.status === "invalid"
    ? `Syntax validation failed for ${module.file}.${detail}`
    : validation.status === "unavailable"
      ? `Syntax validation toolchain unavailable for ${module.file} (${validation.tool}).${detail}`
      : `Syntax validation could not establish validity for ${module.file} (${validation.tool}).${detail}`;
  module.unknowns.push(message.trim());
}

export function buildGraph(root: string, files = listSourceFiles(root), contents?: Map<string, string>, options: GraphBuildOptions = {}): SymbolGraph {
  const modules = new Map<string, ModuleNode>();
  const symbols = new Map<string, SymbolNode>();
  const byName = new Map<string, SymbolNode[]>();
  const unknowns: string[] = [];
  const maxValidatedFiles = Math.max(0, Math.min(options.maxValidatedFiles ?? 250, 1000));
  let validatedFiles = 0;
  let validationSkipped = false;
  for (const file of [...files].sort()) {
    let text: string;
    try {
      resolveRepositoryPath(root, file);
      text = contents?.get(file) ?? fs.readFileSync(path.join(root, file), "utf8");
    } catch (error) {
      const module = parseSource(file, "", root);
      module.unknowns.push(`Source file could not be read: ${file}.`);
      modules.set(file, module);
      unknowns.push(...module.unknowns);
      continue;
    }
    const module = parseSource(file, text, root);
    if (options.validateSyntax && module.language !== "typescript" && module.language !== "javascript") {
      if (validatedFiles < maxValidatedFiles) {
        recordSyntaxValidation(module, validateLanguageSource(root, file, text, module.language, options.validationTimeoutMs));
        validatedFiles += 1;
      } else if (!validationSkipped) {
        unknowns.push(`Syntax validation was capped at ${maxValidatedFiles} source file(s).`);
        validationSkipped = true;
      }
    }
    modules.set(file, module);
    unknowns.push(...module.unknowns);
    for (const symbol of module.symbols) {
      symbols.set(symbol.id, symbol);
      const list = byName.get(symbol.name) ?? [];
      list.push(symbol);
      byName.set(symbol.name, list);
    }
  }
  return { root, modules, symbols, byName, unknowns: [...new Set(unknowns)].sort() };
}

export function graphForRevision(root: string, revision: string, files: string[], read: (revision: string, file: string) => string | undefined, options: GraphBuildOptions = {}): SymbolGraph {
  const contents = new Map<string, string>();
  const missing: string[] = [];
  for (const file of files) {
    const content = read(revision, file);
    if (content !== undefined) contents.set(file, content);
    else missing.push(file);
  }
  const graph = buildGraph(root, [...contents.keys()], contents, options);
  if (missing.length) graph.unknowns = [...new Set([...graph.unknowns, ...missing.map((file) => `Source file could not be read at ${revision}: ${file}.`)])].sort();
  return graph;
}

export function symbolAtLine(module: ModuleNode, line: number): SymbolNode | undefined {
  return module.symbols.filter((symbol) => symbol.line <= line && symbol.endLine >= line).sort((a, b) => (a.end - a.start) - (b.end - b.start))[0];
}
