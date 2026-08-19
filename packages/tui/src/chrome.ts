import { renderStatusBar, renderTabStrip, type MasterState } from "./tabs";

/** OpenTUI-style frame: tab strip, body, status. No kanban. */
export function renderMasterChrome(state: MasterState, body: string): string {
  const width = Math.max(40, Math.min(120, (body.split("\n")[0]?.length ?? 72) || 72));
  const bar = "─".repeat(width);
  return [
    ` Tinkerbot  ${renderTabStrip(state)}`,
    bar,
    body.trimEnd(),
    bar,
    ` ${renderStatusBar(state)}`,
    " ctrl-g leader · /help · nested CLIs use their own OAuth",
    "",
  ].join("\n");
}
