import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createReport } from "../packages/cli/src";
import { renderReport } from "../packages/reporters/src";
import { buildGraph } from "../packages/parser/src";
import { validateLanguageSource } from "../packages/language-validation/src";
import { isSourceFile, isTestFile } from "../packages/git/src";
import { languageEnabled, languageForFile, isSupportedSourceFile, isTestFileForLanguage, summarizeLanguageFiles } from "../packages/language-core/src";
import { parseCoveragePyJson, parseGoCoverprofile, parseLlvmCovJson } from "../packages/coverage/src";
import { analyzeTestDiffs } from "../packages/test-integrity/src";

function write(root: string, file: string, text: string): void {
  const target = path.join(root, file);
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.writeFileSync(target, text);
}

function git(root: string, args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

test("detects source and test conventions across supported languages", () => {
  expect(languageForFile("src/main.py")).toBe("python");
  expect(languageForFile("internal/math/math.go")).toBe("go");
  expect(languageForFile("src/lib.rs")).toBe("rust");
  expect(languageForFile("src/math.c")).toBe("c");
  expect(languageForFile("src/widget.cpp")).toBe("cpp");
  expect(isSourceFile("vendor/ignored.py")).toBe(false);
  expect(isTestFile("tests/test_app.py")).toBe(true);
  expect(isTestFile("internal/math/math_test.go")).toBe(true);
  expect(isTestFile("tests/calc_test.rs")).toBe(true);
  expect(isTestFile("tests/widget_test.cpp")).toBe(true);
  expect(summarizeLanguageFiles(["src/main.py", "internal/math/math.go", "src/lib.rs", "src/math.c", "src/widget.cpp"]).map((item) => item.language)).toEqual(["c", "cpp", "go", "python", "rust"]);
  expect(languageForFile("notes.txt")).toBeUndefined();
  expect(languageForFile("node_modules/pkg/index.ts")).toBeUndefined();
  expect(languageForFile("vendor/lib.go")).toBeUndefined();
  expect(isSupportedSourceFile("src/app.ts")).toBe(true);
  expect(isSupportedSourceFile("README.md")).toBe(false);
  expect(isTestFileForLanguage("src/app.ts")).toBe(false);
  expect(languageEnabled("src/app.ts", { mode: "auto", include: [], exclude: ["typescript"] })).toBe(false);
  expect(languageEnabled("src/app.ts", { mode: "explicit", include: ["python"], exclude: [] })).toBe(false);
});

test("missing syntax tools stay unavailable instead of passing", () => {
  const previous = process.env.PATH;
  process.env.PATH = "/this-path-does-not-exist";
  try {
    const result = validateLanguageSource(process.cwd(), "pkg.go", "package p\n", "go");
    expect(result.status).not.toBe("valid");
    expect(["unavailable", "unknown"]).toContain(result.status);
  } finally {
    if (previous === undefined) delete process.env.PATH; else process.env.PATH = previous;
  }
  const oversized = validateLanguageSource(process.cwd(), "x.py", "x".repeat(3_000_000), "python");
  expect(oversized.status).toBe("unknown");
});

test("builds deterministic Python, Go, Rust, C, and C++ graph adapters", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-language-"));
  write(root, "src/__init__.py", "");
  write(root, "src/util.py", "def calculate(value):\n    return value + 1\n");
  write(root, "src/app.py", "from .util import calculate\nimport importlib\n@app.get('/value')\ndef value():\n    return calculate(1)\n\ndef dynamic(name):\n    return importlib.import_module(name)\n");
  write(root, "tests/test_app.py", "from src.app import value\ndef test_value():\n    assert value() == 2\n");
  write(root, "go.mod", "module example.com/demo\n\ngo 1.22\n");
  write(root, "internal/math/math.go", "package math\n\nfunc Add(left int, right int) int {\n    return left + right\n}\n");
  write(root, "internal/math/math_test.go", "package math\n\nimport \"testing\"\nfunc TestAdd(t *testing.T) { t.Error(\"expected\") }\n");
  write(root, "cmd/demo/main.go", "package main\n\nimport \"example.com/demo/internal/math\"\nfunc main() { math.Add(1, 2) }\n");
  write(root, "src/lib.rs", "pub mod calc;\nuse crate::calc::add;\npub fn run() -> i32 { add(1, 2) }\ninclude!(\"generated.rs\");\n");
  write(root, "src/calc.rs", "pub fn add(left: i32, right: i32) -> i32 { left + right }\n");
  write(root, "tests/calc_test.rs", "#[test]\nfn test_add() { assert_eq!(2, 2); }\n");
  write(root, "src/math.h", "int add(int left, int right);\n");
  write(root, "src/math.c", "#include \"math.h\"\n#include <stdio.h>\nint add(int left, int right) { return left + right; }\n");
  write(root, "tests/math_test.c", "#include \"../src/math.h\"\nvoid test_add(void) { ASSERT_EQ(2, add(1, 1)); }\n");
  write(root, "src/widget.cpp", "#include \"math.h\"\nclass Widget {};\nint widget_value() { return 1; }\n");
  write(root, "tests/widget_test.cpp", "TEST(Widget, Value) { EXPECT_EQ(1, widget_value()); }\n");

  const graph = buildGraph(root);
  expect(graph.modules.get("src/app.py")?.language).toBe("python");
  expect(graph.modules.get("src/app.py")?.imports[0]?.resolvedFile).toBe("src/util.py");
  expect(graph.modules.get("src/app.py")?.routes[0]?.path).toBe("/value");
  expect(graph.modules.get("src/app.py")?.dynamicReferences.length).toBe(1);
  expect(graph.modules.get("cmd/demo/main.go")?.imports[0]?.resolvedFile).toBe("internal/math/math.go");
  expect(graph.modules.get("internal/math/math.go")?.exports).toContain("Add");
  expect(graph.modules.get("src/lib.rs")?.imports.some((item) => item.resolvedFile === "src/calc.rs")).toBe(true);
  expect(graph.modules.get("src/lib.rs")?.unknowns.some((item) => item.includes("compile-time macro"))).toBe(true);
  expect(graph.modules.get("src/math.c")?.imports[0]?.resolvedFile).toBe("src/math.h");
  expect(graph.modules.get("src/math.c")?.unknowns.some((item) => item.includes("System C/C++ include"))).toBe(true);
  expect(graph.modules.get("src/widget.cpp")?.symbols.some((symbol) => symbol.name === "Widget" && symbol.kind === "class")).toBe(true);
});

test("resolves common monorepo layouts and build metadata", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-language-resolution-"));
  write(root, "tsconfig.json", JSON.stringify({ compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } } }));
  write(root, "src/shared.ts", "export const shared = 1;\n");
  write(root, "src/entry.ts", "import { shared } from '@/shared';\nexport const entry = shared;\n");
  write(root, "services/api/src/pkg/util.py", "def value():\n    return 1\n");
  write(root, "services/api/src/app.py", "from pkg.util import value\n");
  write(root, "services/math/go.mod", "module example.com/math\n\ngo 1.22\n");
  write(root, "services/math/internal/add/add.go", "package add\n\nfunc Value() int { return 1 }\n");
  write(root, "services/math/cmd/main.go", "package main\n\nimport \"example.com/math/internal/add\"\nfunc main() { add.Value() }\n");
  write(root, "Cargo.toml", "[workspace]\nmembers = [\"crates/demo\"]\n");
  write(root, "crates/demo/Cargo.toml", "[package]\nname = \"demo\"\nversion = \"0.1.0\"\n");
  write(root, "crates/demo/src/lib.rs", "pub mod calc;\nuse crate::calc::add;\npub fn run() -> i32 { add() }\n");
  write(root, "crates/demo/src/calc.rs", "pub fn add() -> i32 { 1 }\n");
  write(root, "include/project.h", "#define PROJECT_VALUE 1\n");
  write(root, "native/main.c", "#include <project.h>\nint main(void) { return PROJECT_VALUE; }\n");
  write(root, "compile_commands.json", JSON.stringify([{ directory: root, file: "native/main.c", arguments: ["clang", "-I", "include", "-c", "native/main.c"] }]));

  const graph = buildGraph(root);
  expect(graph.modules.get("src/entry.ts")?.imports[0]?.resolvedFile).toBe("src/shared.ts");
  expect(graph.modules.get("services/api/src/app.py")?.imports[0]?.resolvedFile).toBe("services/api/src/pkg/util.py");
  expect(graph.modules.get("services/math/cmd/main.go")?.imports[0]?.resolvedFile).toBe("services/math/internal/add/add.go");
  expect(graph.modules.get("crates/demo/src/lib.rs")?.imports.some((item) => item.resolvedFile === "crates/demo/src/calc.rs")).toBe(true);
  expect(graph.modules.get("native/main.c")?.imports[0]?.resolvedFile).toBe("include/project.h");
  const validated = buildGraph(root, ["native/main.c"], undefined, { validateSyntax: true });
  expect(["valid", "unknown", "unavailable"]).toContain(validated.modules.get("native/main.c")?.syntaxValidation?.status);
});

test("uses installed language front ends without executing repository code", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-language-validation-"));
  const validSources = [
    ["app.py", "def value():\n    return 1\n", "python"],
    ["main.go", "package main\nfunc main() {}\n", "go"],
    ["lib.rs", "pub fn value() -> i32 { 1 }\n", "rust"],
    ["main.c", "int main(void) { return 0; }\n", "c"],
    ["main.cpp", "int main() { return 0; }\n", "cpp"],
  ] as const;
  for (const [file, source, language] of validSources) {
    const result = validateLanguageSource(root, file, source, language);
    expect(result.status).not.toBe("invalid");
  }
  const invalidPython = validateLanguageSource(root, "broken.py", "def value(:\n", "python");
  expect(invalidPython.status).not.toBe("valid");
  if (invalidPython.status === "invalid") expect(invalidPython.diagnostics.length).toBeGreaterThan(0);

  write(root, "main.c", "int main(void) { return 0; }\n");
  const graph = buildGraph(root, ["main.c"], undefined, { validateSyntax: true });
  expect(graph.modules.get("main.c")?.syntaxValidation?.status).toBeDefined();
});

test("reads Go, coverage.py, and LLVM coverage artifacts", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-coverage-"));
  const go = parseGoCoverprofile("mode: set\nsrc/main.go:1.1,3.2 1 1\nsrc/main.go:5.1,5.2 1 0\n", root);
  expect(go.format).toBe("go-coverprofile");
  expect(go.files["src/main.go"]?.lines[2]).toBe(1);
  expect(go.files["src/main.go"]?.lines[5]).toBe(0);
  const python = parseCoveragePyJson(JSON.stringify({ files: { "src/main.py": { executed_lines: [1, 2], missing_lines: [3] } } }), root);
  expect(python.format).toBe("coverage.py");
  expect(python.files["src/main.py"]?.lines[1]).toBe(1);
  expect(python.files["src/main.py"]?.lines[3]).toBe(0);
  const llvm = parseLlvmCovJson(JSON.stringify({ data: [{ files: [{ filename: "src/main.c", segments: [[4, 1, 2, true, true]] }] }] }), root);
  expect(llvm.format).toBe("llvm-cov");
  expect(llvm.files["src/main.c"]?.lines[4]).toBe(2);
});

test("detects native assertion weakening in non-JavaScript tests", () => {
  const python = analyzeTestDiffs([{
    path: "tests/test_app.py",
    status: "modified",
    additions: 1,
    deletions: 1,
    changedLines: [2],
    deletedLines: [2],
    hunks: [{ oldStart: 2, oldCount: 1, newStart: 2, newCount: 1, header: "@@", lines: ["-    assert value() == 2", "+    assert value()"] }],
    patch: "",
  }], os.tmpdir());
  expect(python.findings.some((finding) => finding.ruleId === "assertion.weakened")).toBe(true);
  const go = analyzeTestDiffs([{
    path: "math_test.go",
    status: "modified",
    additions: 1,
    deletions: 1,
    changedLines: [3],
    deletedLines: [3],
    hunks: [{ oldStart: 3, oldCount: 1, newStart: 3, newCount: 1, header: "@@", lines: ["-    t.Fatal(\"bad\")", "+    t.Log(\"bad\")"] }],
    patch: "",
  }], os.tmpdir());
  expect(go.findings.some((finding) => finding.ruleId === "assertion.weakened")).toBe(true);
});

test("surfaces detected language support in the unified CLI report", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "pr-proof-language-report-"));
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "test@example.com"]);
  git(root, ["config", "user.name", "PR Proof Test"]);
  write(root, "pr-proof.yml", "version: 1\nlanguages:\n  mode: explicit\n  include: [python, go]\n  exclude: []\ntest_integrity:\n  run_base_tests: false\n  mutation_testing:\n    enabled: false\n");
  write(root, "app.py", "def value():\n    return 1\n");
  write(root, "go.mod", "module example.com/report\n");
  write(root, "math.go", "package report\n\nfunc Add(left int, right int) int { return left + right }\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "base"]);
  write(root, "app.py", "def value():\n    return 2\n");
  git(root, ["add", "."]);
  git(root, ["commit", "-q", "-m", "head"]);
  const report = createReport({ cwd: root, base: "HEAD~1", head: "HEAD", runMutation: false, runBaseTests: false });
  expect(report.languages?.map((language) => language.language)).toEqual(["go", "python"]);
  expect(report.languages?.find((language) => language.language === "python")?.capabilities.coverage).toContain("coverage.py");
  expect(renderReport(report, "terminal")).toContain("Languages");
  expect(renderReport(report, "markdown")).toContain("Coverage adapters");
});
