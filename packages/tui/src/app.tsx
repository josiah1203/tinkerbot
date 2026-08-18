import { createMemo, createSignal, For, onCleanup, onMount, Show } from "solid-js";
import { useBindings } from "@opentui/keymap/solid";
import { useTerminalDimensions } from "@opentui/solid";
import type { TuiAdapter, VerificationRunHandle } from "./adapter";
import { filterWorkItems, evidenceTrace, groupWorkItems, reportStatusLabel, summaryMetrics, type TuiSnapshot, type WorkItem } from "./model";
import { colorForStatus, theme } from "./theme";

export type DetailView = "overview" | "diff" | "evidence" | "policy" | "run" | "help" | "repositories" | "runs" | "releases";

export interface TuiAppProps {
  adapter: TuiAdapter;
  dimensions?: () => { width: number; height: number };
  /** Optional initial panel for embedders and deterministic startup flows. */
  initialView?: DetailView;
  onQuit: () => void;
}

function safeText(value: unknown, fallback = "—"): string {
  if (value === undefined || value === null || value === "") return fallback;
  return String(value).replace(/[\u0000-\u001f\u007f]/g, " ");
}

function short(value: string | undefined, size = 12): string {
  return value ? value.slice(0, size) : "—";
}

function detailTitle(view: DetailView): string {
  return ({ overview: "Overview", diff: "Diff", evidence: "Evidence trace", policy: "Policy", run: "Verification run", help: "Help", repositories: "Repositories", runs: "Runs", releases: "Releases" } as Record<DetailView, string>)[view];
}

function diffColor(line: string): string {
  if (line.startsWith("+") && !line.startsWith("+++")) return theme.pass;
  if (line.startsWith("-") && !line.startsWith("---")) return theme.danger;
  if (line.startsWith("@@")) return theme.accent;
  return theme.text;
}

function filetypeForPath(file: string | undefined): string | undefined {
  const extension = file?.split(".").pop()?.toLowerCase();
  return ({
    ts: "typescript",
    tsx: "tsx",
    js: "javascript",
    jsx: "jsx",
    mjs: "javascript",
    cjs: "javascript",
    py: "python",
    go: "go",
    rs: "rust",
    c: "c",
    h: "c",
    cc: "cpp",
    cpp: "cpp",
    hpp: "cpp",
    java: "java",
    rb: "ruby",
    json: "json",
    yaml: "yaml",
    yml: "yaml",
    md: "markdown",
  } as Record<string, string | undefined>)[extension ?? ""];
}

function itemSummary(item: WorkItem | undefined): string {
  if (!item) return "Select a work item to inspect its local evidence.";
  return `${item.glyph} ${item.title}${item.file ? ` · ${item.file}${item.line ? `:${item.line}` : ""}` : ""}`;
}

export function TuiApp(props: TuiAppProps) {
  const [snapshot, setSnapshot] = createSignal<TuiSnapshot>();
  const [filter, setFilter] = createSignal("");
  const [commandText, setCommandText] = createSignal("");
  const [selected, setSelected] = createSignal(0);
  const [view, setView] = createSignal<DetailView>(props.initialView ?? "overview");
  const [diffMode, setDiffMode] = createSignal<"unified" | "split">("unified");
  const [status, setStatus] = createSignal("Connecting to the Tinkerbot control plane…");
  const [logs, setLogs] = createSignal<string[]>([]);
  const [running, setRunning] = createSignal(false);
  const [inputRef, setInputRef] = createSignal<any>();
  let runHandle: VerificationRunHandle | undefined;
  const terminalDimensions = useTerminalDimensions();

  const items = createMemo(() => filterWorkItems(snapshot()?.workItems ?? [], filter()));
  const selectedItem = createMemo(() => items()[selected()] ?? items()[0]);
  const narrow = createMemo(() => (props.dimensions?.() ?? terminalDimensions()).width < 100);
  const statusLabel = createMemo(() => reportStatusLabel(snapshot()?.report, snapshot()?.state ?? "loading"));

  function log(line: string): void {
    setLogs((current) => [...current.slice(-8), line]);
    setStatus(line);
  }

  async function refresh(): Promise<void> {
    setStatus("Refreshing server-authoritative organization and evidence state…");
    try {
      const next = await props.adapter.loadSnapshot();
      setSnapshot(next);
      setSelected(0);
      if (next.state === "error" || next.state === "permission-denied") setStatus(next.warnings[0] ?? "Hosted session unavailable");
      else if (next.state === "stale") setStatus("Evidence is stale · press r to rerun");
      else setStatus(next.report ? `Loaded ${next.report.verdict} from the control plane` : "No hosted assurance record is available");
    } catch (error) {
      setSnapshot({ state: "error", history: [], diff: "", changedFiles: [], workItems: [], warnings: [error instanceof Error ? error.message : String(error)], loadedAt: new Date().toISOString() });
      setStatus("Recoverable adapter error · press r to retry");
    }
  }

  async function runVerification(): Promise<void> {
    if (running()) return;
    setRunning(true);
    setView("run");
    setLogs([]);
    runHandle = props.adapter.startVerification(log);
    try {
      const result = await runHandle.promise;
      if (result.cancelled) setStatus("Verification cancelled");
      else if (result.snapshot) {
        setSnapshot(result.snapshot);
        const receipt = await props.adapter.exportReceipt();
        const evidence = await props.adapter.exportEvidence();
        const refreshed = await props.adapter.loadSnapshot();
        setSnapshot(refreshed);
        log(receipt.ok && evidence.ok ? "Verification finished; receipt and canonical evidence contract generated." : "Verification finished; receipt or evidence generation is UNKNOWN.");
      }
      else setStatus(result.stderr || `Verification exited with status ${result.status}`);
    } finally {
      runHandle = undefined;
      setRunning(false);
    }
  }

  async function exportReceipt(): Promise<void> {
    setStatus("Writing source-minimized verification receipt…");
    const result = await props.adapter.exportReceipt();
    setStatus(result.ok ? "Receipt exported to .tinkerbot/receipts/" : `Receipt export unavailable: ${result.stderr || "unknown error"}`);
  }

  async function exportEvidence(): Promise<void> {
    setStatus("Writing structured evidence export…");
    const result = await props.adapter.exportEvidence();
    if (result.ok) {
      const refreshed = await props.adapter.loadSnapshot();
      setSnapshot(refreshed);
      setStatus("Evidence exported to .tinkerbot/evidence.json");
    } else setStatus(`Evidence export unavailable: ${result.stderr || "unknown error"}`);
  }

  function openGitHub(): void {
    const url = props.adapter.openGitHub();
    setStatus(url ? `GitHub: ${url} · source remains local` : "No GitHub remote is configured");
  }

  function submitCommand(value = commandText()): void {
    const command = value.trim();
    setCommandText("");
    if (!command) return;
    if (command.startsWith("/")) {
      setFilter(command.slice(1));
      setSelected(0);
      setStatus(command.slice(1) ? `Filtering: ${command.slice(1)}` : "Filter cleared");
      return;
    }
    const normalized = command.startsWith(":") ? command.slice(1).trim().toLowerCase() : command.toLowerCase();
    if (["r", "rerun", "run", "verify"].includes(normalized)) void runVerification();
    else if (["d", "diff"].includes(normalized)) setView("diff");
    else if (["e", "evidence"].includes(normalized)) setView("evidence");
    else if (["p", "policy", "config"].includes(normalized)) setView("policy");
    else if (normalized === "export-evidence") void exportEvidence();
    else if (normalized === "export markdown") void props.adapter.exportReport("markdown").then((result) => setStatus(result.ok ? "Markdown summary exported to .tinkerbot/exports/" : `Markdown export unavailable: ${result.stderr}`));
    else if (normalized === "export sarif") void props.adapter.exportReport("sarif").then((result) => setStatus(result.ok ? "SARIF exported to .tinkerbot/exports/" : `SARIF export unavailable: ${result.stderr}`));
    else if (normalized === "export json") void props.adapter.exportReport("json").then((result) => setStatus(result.ok ? "JSON exported to .tinkerbot/exports/" : `JSON export unavailable: ${result.stderr}`));
    else if (["x", "export", "receipt"].includes(normalized)) void exportReceipt();
    else if (normalized.startsWith("repo ") || normalized.startsWith("repository ")) {
      const root = command.replace(/^:?\s*(repo|repository)\s+/i, "").trim();
      if (root && props.adapter.selectRepository) { props.adapter.selectRepository(root); void refresh(); }
      else setStatus("Repository selection requires a local path and a repository adapter");
    }
    else if (["github", "open", "o"].includes(normalized)) openGitHub();
    else if (["help", "?"].includes(normalized)) setView("help");
    else if (normalized === "clear") { setFilter(""); setStatus("Filter cleared"); }
    else { setFilter(command); setSelected(0); setStatus(`Filtering: ${command}`); }
  }

  function move(delta: number): void {
    const size = items().length;
    if (!size) return;
    setSelected((current) => (current + delta + size) % size);
  }

  useBindings(() => ({
    commands: [
      { name: "quit", run: props.onQuit },
      { name: "move-down", run: () => move(1) },
      { name: "move-up", run: () => move(-1) },
      { name: "open", run: () => setView("overview") },
      { name: "overview", run: () => setView("overview") },
      { name: "work", run: () => { setView("overview"); setStatus("Grouped Work view"); } },
      { name: "repositories", run: () => setView("repositories") },
      { name: "runs", run: () => setView("runs") },
      { name: "releases", run: () => setView("releases") },
      { name: "focus-filter", run: () => { setCommandText("/"); inputRef()?.focus?.(); } },
      { name: "command-mode", run: () => { setCommandText(":"); inputRef()?.focus?.(); } },
      { name: "clear-filter", run: () => { setFilter(""); setCommandText(""); setStatus("Filter cleared"); } },
      { name: "help", run: () => setView("help") },
      { name: "diff", run: () => setView("diff") },
      { name: "toggle-diff", run: () => { setDiffMode((current) => current === "unified" ? "split" : "unified"); setView("diff"); } },
      { name: "evidence", run: () => setView("evidence") },
      { name: "policy", run: () => setView("policy") },
      { name: "rerun", run: () => void runVerification() },
      { name: "cancel", run: () => runHandle?.cancel() },
      { name: "open-github", run: openGitHub },
      { name: "export", run: () => void exportReceipt() },
      { name: "escape", run: () => { setView("overview"); setCommandText(""); } },
    ],
    bindings: [
      { key: "q", cmd: "quit" },
      { key: "j", cmd: "move-down" },
      { key: "down", cmd: "move-down" },
      { key: "k", cmd: "move-up" },
      { key: "up", cmd: "move-up" },
      { key: "enter", cmd: "open" },
      { key: "g o", cmd: "overview" },
      { key: "g w", cmd: "work" },
      { key: "g r", cmd: "repositories" },
      { key: "g u", cmd: "runs" },
      { key: "g l", cmd: "releases" },
      { key: "/", cmd: "focus-filter" },
      { key: ":", cmd: "command-mode" },
      { key: "?", cmd: "help" },
      { key: "d", cmd: "diff" },
      { key: "s", cmd: "toggle-diff" },
      { key: "e", cmd: "evidence" },
      { key: "p", cmd: "policy" },
      { key: "r", cmd: "rerun" },
      { key: "c", cmd: "cancel" },
      { key: "o", cmd: "open-github" },
      { key: "x", cmd: "export" },
      { key: "escape", cmd: "escape" },
    ],
  }));

  // The command line gets a higher-priority focus layer so Enter submits the
  // real input instead of opening the selected work item. Global navigation
  // remains available as soon as focus leaves the input.
  useBindings(() => ({
    target: () => inputRef(),
    targetMode: "focus",
    priority: 100,
    commands: [
      { name: "submit-filter-command", run: () => submitCommand() },
      { name: "clear-filter-input", run: () => { setCommandText(""); setFilter(""); } },
    ],
    bindings: [
      { key: "enter", cmd: "submit-filter-command" },
      { key: "escape", cmd: "clear-filter-input" },
    ],
  }));

  onMount(() => { void refresh(); });
  onCleanup(() => { runHandle?.cancel(); });

  function renderWorkList() {
    return (
      <scrollbox flexGrow={1} focused={view() === "overview"}>
        <For each={groupWorkItems(items())}>
          {(section) => (
            <box flexDirection="column">
              <text fg={theme.muted}>{section.group}</text>
              <For each={section.items}>
                {(item) => {
                  const index = () => items().findIndex((candidate) => candidate.id === item.id);
                  const focused = () => index() === selected();
                  return (
                    <box height={1} backgroundColor={focused() ? theme.selection : theme.panel}>
                      <text fg={colorForStatus(item.status)}>{`${focused() ? "›" : " "} ${item.glyph} `}</text>
                      <text fg={focused() ? theme.text : theme.muted}>{`${item.repository.padEnd(18).slice(0, 18)} `}</text>
                      <text fg={focused() ? theme.accent : theme.text}>{`${item.change.padEnd(14).slice(0, 14)} `}</text>
                      <text fg={colorForStatus(item.status)}>{`${item.severity.padEnd(8).slice(0, 8)} `}</text>
                      <text fg={theme.muted}>{item.timestamp}</text>
                    </box>
                  );
                }}
              </For>
            </box>
          )}
        </For>
      </scrollbox>
    );
  }

  function renderOverview() {
    const item = selectedItem();
    const report = snapshot()?.report;
    return (
      <box flexDirection="column" flexGrow={1} padding={1}>
        <box height={2} flexDirection="row" justifyContent="space-between">
          <text fg={colorForStatus(report?.verdict === "PASS" ? "pass" : report?.verdict === "FAIL" ? "fail" : report?.verdict === "UNKNOWN" ? "unknown" : "warning")}>{`[${statusLabel()}]`}</text>
          <text fg={theme.muted}>{report?.generatedAt ? safeText(report.generatedAt) : "not yet run"}</text>
        </box>
        <text fg={theme.muted}>{itemSummary(item)}</text>
        <box height={3} flexDirection="row" borderStyle="single" borderColor={theme.border} marginTop={1}>
          <For each={summaryMetrics(report)}>
            {([label, value]) => <box flexGrow={1} paddingLeft={1} paddingRight={1}><text fg={theme.muted}>{`${label}\n`}</text><text fg={theme.text}>{value}</text></box>}
          </For>
        </box>
        <box flexGrow={1} marginTop={1} borderStyle="single" borderColor={theme.border} padding={1}>
          <text fg={theme.muted}>{`diff ${item?.file ? `· ${item.file}` : "· local source view"} · ${diffMode()} · line numbers`}</text>
          <Show when={snapshot()?.diff} fallback={<text fg={theme.dim}>No local diff is available.</text>}>
            <diff
              flexGrow={1}
              diff={snapshot()?.diff ?? ""}
              view={diffMode()}
              showLineNumbers={true}
              wrapMode="none"
              filetype={filetypeForPath(item?.file)}
              lineNumberFg={theme.dim}
              addedSignColor={theme.pass}
              removedSignColor={theme.danger}
              addedLineNumberBg={theme.panelRaised}
              removedLineNumberBg={theme.panelRaised}
            />
          </Show>
        </box>
        <box minHeight={6} marginTop={1} borderStyle="single" borderColor={theme.border} padding={1}>
          <text fg={theme.accent}>EVIDENCE TRACE</text>
          <For each={evidenceTrace(report, item).slice(0, narrow() ? 7 : 12)}>{(line) => <text fg={line.includes("unknown") ? theme.unknown : theme.text}>{line}</text>}</For>
        </box>
      </box>
    );
  }

  function renderDiff() {
    const report = snapshot()?.report;
    const selectedFile = selectedItem()?.file ?? snapshot()?.changedFiles[0];
    const findings = (report?.findings ?? []).filter((finding) => !selectedFile || finding.file === selectedFile);
    return (
      <box flexDirection="column" flexGrow={1} padding={1}>
        <text fg={theme.muted}>{`${snapshot()?.changedFiles.length ?? 0} changed file(s) · ${diffMode()} local diff · source is not uploaded`}</text>
        <text fg={theme.accent}>CHANGED FILES</text>
        <For each={snapshot()?.changedFiles.slice(0, 12) ?? []}>
          {(file) => <text fg={file === selectedFile ? theme.text : theme.muted}>{`${file === selectedFile ? "›" : " "} ${file}`}</text>}
        </For>
        <Show when={findings.length > 0}>
          <text fg={theme.accent}>FINDING MARKERS</text>
          <For each={findings.slice(0, 12)}>{(finding) => <text fg={colorForStatus(finding.resolution === "unknown" ? "unknown" : finding.severity === "high" || finding.severity === "critical" ? "fail" : "warning")}>{`! ${finding.file ?? "repository"}:${finding.line ?? 1} ${finding.title ?? finding.message}`}</text>}</For>
        </Show>
        <box flexGrow={1} marginTop={1} borderStyle="single" borderColor={theme.border}>
          <Show when={snapshot()?.diff} fallback={<text fg={theme.dim}>No local diff available.</text>}>
            <diff
              flexGrow={1}
              diff={snapshot()?.diff ?? ""}
              view={diffMode()}
              showLineNumbers={true}
              wrapMode="none"
              filetype={filetypeForPath(selectedFile)}
              lineNumberFg={theme.dim}
              addedSignColor={theme.pass}
              removedSignColor={theme.danger}
              addedLineNumberBg={theme.panelRaised}
              removedLineNumberBg={theme.panelRaised}
            />
          </Show>
        </box>
        <text fg={theme.muted}>{`Open GitHub: ${props.adapter.openGitHub() ?? "not configured"} · s toggles ${diffMode() === "unified" ? "split" : "unified"}`}</text>
      </box>
    );
  }

  function renderEvidence() {
    const report = snapshot()?.report;
    const receipt = report?.assurance?.receipts?.[0];
    const envelope = report?.evidence;
    return (
      <scrollbox flexGrow={1} padding={1}>
        <text fg={theme.accent}>EVIDENCE TRACE</text>
        <For each={evidenceTrace(report, selectedItem())}>{(line) => <text fg={theme.text}>{line}</text>}</For>
        <text fg={theme.accent}>{"\nRECEIPT"}</text>
        <text fg={theme.text}>{`ID       ${safeText(receipt?.id, "not generated")}`}</text>
        <text fg={theme.text}>{`Digest   ${safeText(receipt?.integrity?.digest, "not generated")}`}</text>
        <text fg={theme.text}>{`Verdict  ${safeText(receipt?.verdict ?? report?.verdict)}`}</text>
        <text fg={theme.text}>{`State    ${receipt?.states?.partial ? "PARTIAL" : receipt ? "COMPLETE" : "UNKNOWN"}`}</text>
        <text fg={theme.accent}>{"\nPROVENANCE"}</text>
        <text fg={theme.text}>{`Tool     ${safeText(report?.toolVersion, "tinkerbot")}`}</text>
        <text fg={theme.text}>{`Schema   ${safeText(report?.schemaVersion)}`}</text>
        <text fg={theme.text}>{`Policy   ${safeText(report?.policy?.pack)}`}</text>
        <text fg={theme.text}>{`Unknowns ${(report?.limitations ?? []).length}`}</text>
        <text fg={theme.accent}>{"\nCANONICAL EVIDENCE CONTRACT"}</text>
        <text fg={theme.text}>{`Schema   ${safeText(envelope?.schemaId, "not generated")}`}</text>
        <text fg={theme.text}>{`Run      ${safeText(envelope?.runId, "not generated")}`}</text>
        <text fg={theme.text}>{`Receipt  ${safeText(envelope?.receiptId, "not generated")}`}</text>
        <text fg={theme.text}>{`State    ${safeText(envelope?.verdict, "UNKNOWN")} · unknown ${envelope?.unknownStates?.length ?? 0} · stale ${envelope?.staleStates?.length ?? 0}`}</text>
        <text fg={theme.text}>{`Upload   source ${safeText(envelope?.sourceUpload, "not uploaded")} · diff ${safeText(envelope?.diffUpload, "not uploaded")}`}</text>
        <text fg={theme.text}>{`Digest   ${safeText(envelope?.integrity?.digest, "not generated")}`}</text>
        <text fg={theme.muted}>{"\nPress x to export a receipt, or :export-evidence for the structured assurance bundle."}</text>
      </scrollbox>
    );
  }

  function renderPolicy() {
    const report = snapshot()?.report;
    const config = snapshot()?.config;
    const baseline = report?.baseline;
    const waiverConfig = config?.baseline as { waivers?: unknown[] } | undefined;
    return (
      <scrollbox flexGrow={1} padding={1}>
        <text fg={theme.accent}>EFFECTIVE POLICY</text>
        <text fg={theme.text}>{`Pack        ${safeText(report?.policy?.pack, "default")}`}</text>
        <text fg={theme.text}>{`Unknowns    ${safeText(report?.policy?.unknownHandling, "advisory")}`}</text>
        <text fg={theme.text}>{`Baseline    ${baseline?.stale ? "STALE" : baseline ? `${baseline.existingCount ?? 0} existing · ${baseline.newCount ?? 0} new` : "not initialized"}`}</text>
        <text fg={theme.text}>{`Waivers     ${waiverConfig?.waivers?.length ?? 0}`}</text>
        <text fg={theme.text}>{`Expired     ${baseline?.expiredWaiverCount ?? 0}`}</text>
        <text fg={theme.accent}>{"\nCONFIGURATION"}</text>
        <For each={Object.entries(config ?? {}).slice(0, 20)}>{([key, value]) => <text fg={theme.muted}>{`${key}: ${typeof value === "object" ? "configured" : safeText(value)}`}</text>}</For>
        <Show when={!config}><text fg={theme.unknown}>Effective configuration is unavailable; this is an explicit UNKNOWN state.</text></Show>
        <text fg={theme.muted}>{"\nUse :export json to export the local report, and :export-evidence for the structured assurance bundle. Policy simulation remains non-mutating."}</text>
      </scrollbox>
    );
  }

  function renderRun() {
    return (
      <box flexDirection="column" flexGrow={1} padding={1}>
        <text fg={running() ? theme.accent : theme.text}>{running() ? "RUNNING · deterministic verification" : "RUN COMPLETE"}</text>
        <text fg={theme.muted}>{running() ? "c cancels · the current report remains untouched until the child exits" : "r reruns · e opens evidence · x exports receipt"}</text>
        <scrollbox flexGrow={1} marginTop={1} borderStyle="single" borderColor={theme.border} padding={1}>
          <For each={logs()}>{(line) => <text fg={line.toLowerCase().includes("unknown") ? theme.unknown : theme.text}>{line}</text>}</For>
        </scrollbox>
      </box>
    );
  }

  function renderHelp() {
    return (
      <scrollbox flexGrow={1} padding={1}>
        <text fg={theme.accent}>TINKERBOT LOCAL WORKSPACE</text>
        <text fg={theme.text}>{"\nNavigation"}</text>
        <text fg={theme.muted}>j/k or arrows  move through grouped work</text>
        <text fg={theme.muted}>enter          open selected object</text>
        <text fg={theme.muted}>g o / g w      overview / work</text>
        <text fg={theme.muted}>g r / g u / g l repositories / runs / releases</text>
        <text fg={theme.text}>{"\nCommands"}</text>
        <text fg={theme.muted}>/              filter current list</text>
        <text fg={theme.muted}>:              command mode</text>
        <text fg={theme.muted}>d / s / e / p  diff / split toggle / evidence trace / policy</text>
        <text fg={theme.muted}>r / c          rerun / cancel</text>
        <text fg={theme.muted}>o / x          GitHub link / export receipt</text>
        <text fg={theme.muted}>? / q          help / quit</text>
        <text fg={theme.text}>{"\nEvidence states"}</text>
        <text fg={theme.unknown}>? UNKNOWN is not PASS</text>
        <text fg={theme.stale}>◌ STALE evidence must be rerun</text>
        <text fg={theme.muted}>Optional explanations are advisory and cannot change deterministic results.</text>
      </scrollbox>
    );
  }

  function renderSecondary() {
    const current = snapshot();
    if (view() === "repositories") return <scrollbox flexGrow={1} padding={1}><text fg={theme.accent}>LOCAL REPOSITORIES / WORKTREES</text><For each={current?.repositories ?? []}>{(repo) => <text fg={repo.current ? theme.accent : theme.text}>{`${repo.current ? "›" : " "} ${repo.name}  ${repo.branch ?? "detached"}  ${repo.source}  ${repo.path}`}</text>}</For><Show when={!current?.repositories?.length}><text fg={theme.muted}>No additional worktrees or configured repositories were found.</text></Show><text fg={theme.muted}>{"\nEnter :repo /path/to/repository to switch locally. GitHub-linked state is metadata only."}</text></scrollbox>;
    if (view() === "runs") return <scrollbox flexGrow={1} padding={1}><text fg={theme.accent}>RUN HISTORY</text><For each={current?.history ?? []}>{(record) => <text fg={theme.text}>{`${safeText(record.recordedAt)}  ${safeText(record.verdict)}  ${safeText(record.head)}`}</text>}</For><Show when={!current?.history.length}><text fg={theme.muted}>No local verification history exists yet.</text></Show></scrollbox>;
    return <box flexDirection="column" flexGrow={1} padding={1}><text fg={theme.accent}>RELEASE ASSESSMENT</text><text fg={theme.muted}>Release safety remains an existing local CLI contract. Use :release or the command input with a manifest when one is present.</text></box>;
  }

  function renderDetail() {
    if (view() === "overview") return renderOverview();
    if (view() === "diff") return renderDiff();
    if (view() === "evidence") return renderEvidence();
    if (view() === "policy") return renderPolicy();
    if (view() === "run") return renderRun();
    if (view() === "help") return renderHelp();
    return renderSecondary();
  }

  return (
    <box flexDirection="column" width="100%" height="100%" backgroundColor={theme.background}>
      <box height={2} flexDirection="row" justifyContent="space-between" paddingLeft={1} paddingRight={1}>
        <text fg={theme.text}>{`tb / ${safeText(snapshot()?.repository?.name, "repository")}`}</text>
        <text fg={theme.muted}>{`${safeText(snapshot()?.repository?.branch, "no branch")} · ${snapshot()?.repository?.dirty ? "dirty" : "clean"} · local ●`}</text>
      </box>
      <box flexGrow={1} flexDirection={narrow() ? "column" : "row"}>
        <box width={narrow() ? "100%" : "44%"} minWidth={narrow() ? undefined : 42} borderStyle="single" borderColor={theme.border} padding={1}>
          <box height={2} flexDirection="row" justifyContent="space-between"><text fg={theme.accent}>WORK</text><text fg={theme.muted}>{`${items().length} items`}</text></box>
          <Show when={snapshot()?.state === "loading"}><text fg={theme.muted}>Loading repository context…</text></Show>
          <Show when={snapshot()?.state === "error" || snapshot()?.state === "permission-denied"}><text fg={theme.danger}>{snapshot()?.warnings[0] ?? "Repository unavailable"}</text></Show>
          <Show when={snapshot()?.state !== "loading" && snapshot()?.state !== "error" && snapshot()?.state !== "permission-denied"}>{renderWorkList()}</Show>
        </box>
        <box flexGrow={1} borderStyle="single" borderColor={theme.border} paddingLeft={1} paddingRight={1}>
          <box height={2} flexDirection="row" justifyContent="space-between"><text fg={theme.accent}>{detailTitle(view())}</text><text fg={theme.muted}>{`${statusLabel()} · ${short(snapshot()?.repository?.commit)}`}</text></box>
          {renderDetail()}
        </box>
      </box>
      <box height={3} borderStyle="single" borderColor={theme.borderActive} paddingLeft={1} paddingRight={1}>
        <input
          ref={setInputRef}
          placeholder="Filter work items or run a command..."
          value={commandText()}
          keyBindings={[{ name: "return", action: "submit" }, { name: "kpenter", action: "submit" }]}
          onInput={(value: any) => setCommandText(typeof value === "string" ? value : String(value?.value ?? value?.target?.value ?? ""))}
          onSubmit={(value: any) => submitCommand(typeof value === "string" ? value : commandText())}
        />
      </box>
      <box height={1} paddingLeft={1} paddingRight={1}>
        <text fg={theme.muted}>{`${status()}   j/k move  enter open  / search  r rerun  d diff  s split  e evidence  o GitHub  x export  ? help  q quit`}</text>
      </box>
    </box>
  );
}
