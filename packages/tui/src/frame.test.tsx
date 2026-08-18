import { testRender } from "@opentui/solid";

test("OpenTUI test rendering keeps the narrow workspace frame legible", async () => {
  const setup = await testRender(() => (
    <box flexDirection="column" width="100%" height="100%">
      <box height={2} flexDirection="row" justifyContent="space-between"><text>tb / payments-api</text><text>main · dirty · local ●</text></box>
      <box flexGrow={1} flexDirection="row">
        <box width={34} borderStyle="single"><text>NEEDS ATTENTION</text><text>› ! payments-api  HIGH</text><text>  ? payments-api  UNKNOWN</text></box>
        <box flexGrow={1} borderStyle="single"><text>[UNKNOWN]  Evidence</text><text>Change / File / Symbol / Test / Receipt</text></box>
      </box>
      <box height={3} borderStyle="single"><input placeholder="Filter work items or run a command..." /></box>
      <text>j/k move  enter open  / search  r rerun  ? help  q quit</text>
    </box>
  ), { width: 72, height: 12, screenMode: "main-screen" });
  try {
    await setup.waitForVisualIdle();
    const frame = setup.captureCharFrame();
    expect(frame).toContain("tb / payments-api");
    expect(frame).toContain("NEEDS ATTENTION");
    expect(frame).toContain("Filter work items or run a command...");
    expect(frame).toContain("UNKNOWN");
  } finally {
    setup.renderer.destroy();
  }
});
