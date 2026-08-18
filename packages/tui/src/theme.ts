export const theme = {
  background: "#05070b",
  panel: "#0b1018",
  panelRaised: "#111a25",
  border: "#344255",
  borderActive: "#5b9cff",
  text: "#e6edf5",
  muted: "#8a99aa",
  dim: "#536172",
  accent: "#6ea8fe",
  pass: "#58d68d",
  warning: "#f4c95d",
  danger: "#ff6b6b",
  unknown: "#c39bff",
  stale: "#f29d49",
  selection: "#152944",
};

export function colorForStatus(status: string): string {
  if (status === "pass") return theme.pass;
  if (status === "fail") return theme.danger;
  if (status === "warning") return theme.warning;
  if (status === "stale") return theme.stale;
  if (status === "unknown") return theme.unknown;
  return theme.text;
}
