import { createKitWorkstationState, handleKitWorkstationKey, processKitWorkstationLine, renderKitWorkstationFrame, suggestKitCommands } from "../packages/tui/src/workstation";

function kitState() {
  return createKitWorkstationState({
    repo: "acme/api",
    base: "origin/main",
    head: "HEAD",
    kit: {
      root: "/tmp/claude-code-kit",
      packages: ["@claude-code-kit/ui", "@claude-code-kit/ink-renderer"],
      rendererEntry: "/tmp/renderer.js",
      uiEntry: "/tmp/ui.js",
      ready: false,
      reason: "fallback",
    },
  });
}

const deps = {
  stdout: { write: () => true, columns: 100 },
  stderr: { write: () => true },
  cwd: "/tmp",
  env: {},
  header: () => ({ repo: "acme/api", base: "origin/main", head: "HEAD" }),
};

test("kit workstation matches the reference startup shell", () => {
  const output = renderKitWorkstationFrame(kitState(), undefined, { columns: 100, color: false });
  expect(output).toContain("claude-code-kit");
  expect(output).toContain("Terminal UI toolkit extracted from Claude Code");
  expect(output).toContain("Type / to browse components and commands");
  expect(output).toContain("Type a message to chat");
  expect(output).toContain("❯ ▌Type a message or / for commands");
  expect(output).toContain("Default (recommended) 0 tokens $0.00");
  expect(output).toContain("Type / for commands");
  expect(output.split("\n").filter((line) => line.includes("─")).length).toBe(2);
});

test("slash browsing and editing work without a line-buffered terminal", () => {
  let state = kitState();
  state = handleKitWorkstationKey(state, "/").state;
  state = handleKitWorkstationKey(state, "c").state;
  expect(state.input).toBe("/c");
  expect(suggestKitCommands(state.input).map((item) => item.name)).toContain("/check");
  state = handleKitWorkstationKey(state, "\t").state;
  expect(state.input).toBe("/check");
  expect(handleKitWorkstationKey(state, "\r").submit).toBe("/check");
  expect(handleKitWorkstationKey({ ...state, input: "hello", cursor: 5 }, "\u007f").state.input).toBe("hell");
});

test("plain text is accepted by the chat edge while slash safety stays intact", () => {
  const chatted = processKitWorkstationLine(kitState(), "hello there", { ...deps, onMessage: (text: string) => `echo: ${text}` });
  expect(chatted.messages).toEqual([
    { role: "user", text: "hello there" },
    { role: "assistant", text: "echo: hello there" },
  ]);
  const rejected = processKitWorkstationLine(kitState(), "/merge", deps);
  expect(rejected.messages.at(-1)?.text).toMatch(/cannot merge/);
});
