import { renderStatusBar, renderTabBody, renderTabStrip, type MasterState } from "./tabs";

/** OpenTUI-style frame: tab strip, body, status. No kanban. */
export function renderMasterChrome(state: MasterState, body?: string): string {
  const text = (body ?? renderTabBody(state)).trimEnd();
  const width = Math.max(40, Math.min(120, (text.split("\n")[0]?.length ?? 72) || 72));
  const bar = "─".repeat(width);
  return [
    ` Tinkerbot  ${renderTabStrip(state)}`,
    bar,
    text,
    bar,
    ` ${renderStatusBar(state)}`,
    " ctrl-g n/p/w · /check /claude · @tinker is Slack/GitHub, not this prompt",
    "",
  ].join("\n");
}
