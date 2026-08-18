import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import type { LanguageId } from "../../core/src/types";
import { redactSecrets, resolveRepositoryPath, safeChildEnvironment, tokenizeCommand } from "../../core/src/safety";

export type SyntaxValidationStatus = "valid" | "invalid" | "unknown" | "unavailable";

export interface SyntaxValidationResult {
  language: LanguageId;
  status: SyntaxValidationStatus;
  tool: string;
  diagnostics: string[];
}

const MAX_SOURCE_BYTES = 2 * 1024 * 1024;
const MAX_DIAGNOSTICS = 8;
const MAX_COMPILE_DATABASE_BYTES = 4 * 1024 * 1024;

interface CompileCommandEntry {
  directory?: unknown;
  file?: unknown;
  arguments?: unknown;
  command?: unknown;
}

const compileDatabaseCache = new Map<string, CompileCommandEntry[] | null>();

function diagnostics(result: ReturnType<typeof spawnSync>): string[] {
  const output = redactSecrets(`${typeof result.stderr === "string" ? result.stderr : ""}\n${typeof result.stdout === "string" ? result.stdout : ""}`)
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
  return [...new Set(output)].slice(0, MAX_DIAGNOSTICS);
}

function unavailable(language: LanguageId, tool: string, reason: string): SyntaxValidationResult {
  return { language, status: "unavailable", tool, diagnostics: [reason] };
}

function runValidator(language: LanguageId, tool: string, args: string[], source: string, root: string, timeoutMs: number, extraEnvironment: NodeJS.ProcessEnv = {}): SyntaxValidationResult {
  if (Buffer.byteLength(source, "utf8") > MAX_SOURCE_BYTES) return { language, status: "unknown", tool, diagnostics: [`Source exceeds the ${MAX_SOURCE_BYTES}-byte validation limit.`] };
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(tool, args, {
      cwd: root,
      input: source,
      encoding: "utf8",
      timeout: timeoutMs,
      killSignal: "SIGTERM",
      maxBuffer: 2 * 1024 * 1024,
      env: safeChildEnvironment(extraEnvironment),
      shell: false,
      stdio: ["pipe", "pipe", "pipe"],
    });
  } catch (error) {
    return unavailable(language, tool, `Toolchain validator could not start: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  const detail = diagnostics(result);
  const errorCode = (result.error as NodeJS.ErrnoException | undefined)?.code;
  if (errorCode === "ENOENT") return unavailable(language, tool, `${tool} was not found on PATH.`);
  if (errorCode === "EACCES") return unavailable(language, tool, `${tool} could not be executed due to insufficient permission.`);
  if (errorCode === "ETIMEDOUT" || result.signal === "SIGTERM") return { language, status: "unknown", tool, diagnostics: [`${tool} exceeded the ${timeoutMs}ms validation limit.`, ...detail] };
  if (result.status === 0) return { language, status: "valid", tool, diagnostics: detail };
  const contextDependent = detail.some((line) => /file not found|no such file|unresolved import|can't find crate|file for module|could not find/i.test(line));
  return { language, status: contextDependent ? "unknown" : "invalid", tool, diagnostics: detail.length ? detail : [`${tool} exited with status ${String(result.status)}.`] };
}

function findCompileDatabase(root: string, file: string): string | undefined {
  const rootAbsolute = path.resolve(root);
  const candidates = [path.join(rootAbsolute, "compile_commands.json"), path.join(rootAbsolute, "build", "compile_commands.json")];
  let directory = path.dirname(path.resolve(rootAbsolute, file));
  while (directory === rootAbsolute || directory.startsWith(`${rootAbsolute}${path.sep}`)) {
    candidates.push(path.join(directory, "compile_commands.json"), path.join(directory, "build", "compile_commands.json"));
    const parent = path.dirname(directory);
    if (parent === directory) break;
    directory = parent;
  }
  return [...new Set(candidates)].find((candidate) => fs.existsSync(candidate) && fs.statSync(candidate).isFile());
}

function readCompileDatabase(file: string): CompileCommandEntry[] {
  if (compileDatabaseCache.has(file)) return compileDatabaseCache.get(file) ?? [];
  try {
    if (fs.statSync(file).size > MAX_COMPILE_DATABASE_BYTES) {
      compileDatabaseCache.set(file, null);
      return [];
    }
    const parsed = JSON.parse(fs.readFileSync(file, "utf8"));
    const entries = Array.isArray(parsed) ? parsed.filter((entry): entry is CompileCommandEntry => Boolean(entry) && typeof entry === "object") : [];
    compileDatabaseCache.set(file, entries);
    return entries;
  } catch {
    compileDatabaseCache.set(file, null);
    return [];
  }
}

function commandArguments(entry: CompileCommandEntry): string[] {
  if (Array.isArray(entry.arguments) && entry.arguments.every((argument) => typeof argument === "string")) return entry.arguments as string[];
  if (typeof entry.command === "string") {
    try { return tokenizeCommand(entry.command); } catch { return []; }
  }
  return [];
}

function compileDatabaseIncludeDirectories(root: string, file: string): string[] {
  const database = findCompileDatabase(root, file);
  if (!database) return [];
  const target = path.resolve(root, file);
  for (const entry of readCompileDatabase(database)) {
    if (typeof entry.file !== "string") continue;
    const baseDirectory = typeof entry.directory === "string" ? path.resolve(path.dirname(database), entry.directory) : path.resolve(root);
    if (path.normalize(path.resolve(baseDirectory, entry.file)) !== path.normalize(target)) continue;
    const args = commandArguments(entry);
    const directories: string[] = [];
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index]!;
      let value: string | undefined;
      if (["-I", "-isystem", "-iquote"].includes(argument)) value = args[index + 1];
      else if (argument.startsWith("-I") || argument.startsWith("-isystem") || argument.startsWith("-iquote")) value = argument.replace(/^-(?:isystem|iquote|I)/, "");
      if (!value) continue;
      try { directories.push(resolveRepositoryPath(root, path.resolve(baseDirectory, value))); } catch { /* external include roots stay outside the repository graph */ }
    }
    return [...new Set(directories)].slice(0, 64);
  }
  return [];
}

function rustValidator(language: LanguageId, source: string, root: string, timeoutMs: number): SyntaxValidationResult {
  let temporaryDirectory: string;
  try {
    temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-rust-"));
  } catch (error) {
    return unavailable(language, "rustc", `Rust validation temporary storage is unavailable: ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  }
  try {
    return runValidator(language, "rustc", ["--edition=2021", "--crate-type=lib", "--emit=metadata", "-o", path.join(temporaryDirectory, "metadata.rmeta"), "-"], source, root, timeoutMs, { TMPDIR: temporaryDirectory });
  } finally {
    try { fs.rmSync(temporaryDirectory, { recursive: true, force: true }); } catch { /* best-effort cleanup of an isolated temporary directory */ }
  }
}

export function validateLanguageSource(root: string, file: string, source: string, language: LanguageId, timeoutMs = 5_000): SyntaxValidationResult {
  if (language === "typescript" || language === "javascript") return { language, status: "valid", tool: "typescript", diagnostics: [] };
  if (language === "python") return runValidator(language, "python3", ["-c", "import ast,sys; ast.parse(sys.stdin.read(), filename='<pr-proof-source>')"], source, root, timeoutMs);
  if (language === "go") return runValidator(language, "gofmt", ["-e", "-l"], source, root, timeoutMs);
  if (language === "rust") return rustValidator(language, source, root, timeoutMs);
  const compiler = language === "cpp" ? "clang++" : "clang";
  const standard = language === "cpp" ? "c++20" : "c17";
  const sourceKind = language === "cpp" ? "c++" : "c";
  const inputKind = path.extname(file).toLowerCase() === ".h" || path.extname(file).toLowerCase() === ".hh" || path.extname(file).toLowerCase() === ".hpp" || path.extname(file).toLowerCase() === ".hxx" ? `${sourceKind}-header` : sourceKind;
  const includeDirectories = [root, path.dirname(path.join(root, file)), ...compileDatabaseIncludeDirectories(root, file)];
  const includeArguments = [...new Set(includeDirectories)].flatMap((directory) => ["-I", directory]);
  return runValidator(language, compiler, ["-fsyntax-only", `-std=${standard}`, "-Wno-everything", ...includeArguments, "-x", inputKind, "-"], source, root, timeoutMs);
}
