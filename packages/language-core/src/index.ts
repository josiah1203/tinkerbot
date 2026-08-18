import path from "node:path";
import type { LanguageCapabilities, LanguageConfig, LanguageId, LanguageSupportSummary } from "../../core/src/types";

export const LANGUAGE_IDS: readonly LanguageId[] = ["typescript", "javascript", "python", "go", "rust", "c", "cpp"];

const EXTENSIONS: Readonly<Record<string, LanguageId>> = {
  ".ts": "typescript",
  ".tsx": "typescript",
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hh": "cpp",
  ".hpp": "cpp",
  ".hxx": "cpp",
};

const EXCLUDED_DIRECTORY = /(^|\/)(node_modules|vendor|third_party|dist|build|coverage|target|\.git)(\/|$)/;

const CAPABILITIES: Readonly<Record<LanguageId, LanguageCapabilities>> = {
  typescript: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["lcov", "istanbul"], mutation: ["stryker"] },
  javascript: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["lcov", "istanbul"], mutation: ["stryker"] },
  python: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["coverage.py", "lcov"], mutation: ["mutmut", "cosmic-ray"] },
  go: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["go-coverprofile", "lcov"], mutation: ["gremlins"] },
  rust: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["llvm-cov", "lcov"], mutation: ["cargo-mutants"] },
  c: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["gcov", "llvm-cov", "lcov"], mutation: ["mull"] },
  cpp: { syntax: true, imports: true, symbols: true, tests: true, coverage: ["gcov", "llvm-cov", "lcov"], mutation: ["mull"] },
};

function normalizedFile(file: string): string {
  return file.replaceAll("\\", "/").replace(/^\.\//, "");
}

export function languageForFile(file: string): LanguageId | undefined {
  const normalized = normalizedFile(file);
  if (EXCLUDED_DIRECTORY.test(normalized)) return undefined;
  return EXTENSIONS[path.extname(normalized).toLowerCase()];
}

export function isSupportedSourceFile(file: string): boolean {
  return languageForFile(file) !== undefined;
}

export function capabilitiesForLanguage(language: LanguageId): LanguageCapabilities {
  const capabilities = CAPABILITIES[language];
  return {
    syntax: capabilities.syntax,
    imports: capabilities.imports,
    symbols: capabilities.symbols,
    tests: capabilities.tests,
    coverage: [...capabilities.coverage],
    mutation: [...capabilities.mutation],
  };
}

export function languageEnabled(file: string, config: LanguageConfig): boolean {
  const language = languageForFile(file);
  if (!language || config.exclude.includes(language)) return false;
  return config.mode === "auto" ? true : config.include.includes(language);
}

export function isTestFileForLanguage(file: string): boolean {
  const normalized = normalizedFile(file);
  const language = languageForFile(normalized);
  if (!language) return false;
  if (/(^|\/)(__tests__|test|tests)(\/|$)/.test(normalized)) return true;
  const base = path.basename(normalized).toLowerCase();
  if ((language === "typescript" || language === "javascript") && /\.(test|spec)\.[cm]?[jt]sx?$/.test(base)) return true;
  if (language === "python" && (/^test_.*\.py$/.test(base) || /_test\.py$/.test(base))) return true;
  if (language === "go" && base.endsWith("_test.go")) return true;
  if (language === "rust" && (base.endsWith("_test.rs") || normalized.startsWith("tests/"))) return true;
  if ((language === "c" || language === "cpp") && /(?:^|[._-])test(?:[._-]|$)/i.test(base)) return true;
  return false;
}

export function summarizeLanguageFiles(files: Iterable<string>, extraUnknowns: string[] = []): LanguageSupportSummary[] {
  const counts = new Map<LanguageId, number>();
  for (const file of files) {
    const language = languageForFile(file);
    if (language) counts.set(language, (counts.get(language) ?? 0) + 1);
  }
  return [...counts.keys()].sort().map((language) => ({
    language,
    files: counts.get(language) ?? 0,
    capabilities: capabilitiesForLanguage(language),
    unknowns: extraUnknowns.filter((unknown) => unknown.toLowerCase().includes(language)),
  }));
}

export function supportedLanguageIds(): LanguageId[] {
  return [...LANGUAGE_IDS];
}
