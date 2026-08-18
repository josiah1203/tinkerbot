import { createCliRenderer } from "@opentui/core";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/solid";
import { render } from "@opentui/solid";
import { ErrorBoundary } from "solid-js";
import { TuiApp } from "./app";
import { createLocalAdapter, type TuiAdapterOptions } from "./adapter";

function parseOptions(argv: string[]): TuiAdapterOptions {
  const options: TuiAdapterOptions = { cwd: process.cwd(), head: "HEAD" };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    const value = argv[index + 1];
    if (token === "--base" && value) { options.base = value; index += 1; }
    else if (token === "--head" && value) { options.head = value; index += 1; }
    else if (token === "--config" && value) { options.config = value; index += 1; }
    else if (token === "--cwd" && value) { options.cwd = value; index += 1; }
    else if (token === "--repository" && value) { options.cwd = value; index += 1; }
  }
  return options;
}

export async function startTui(options: TuiAdapterOptions = {}): Promise<void> {
  const renderer = await createCliRenderer();
  const keymap = createDefaultOpenTuiKeymap(renderer);
  let closed = false;
  const close = () => {
    if (closed) return;
    closed = true;
    try { renderer.destroy(); } catch { /* cleanup is best effort after terminal teardown */ }
  };
  const onSignal = () => close();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    await render(() => (
      <KeymapProvider keymap={keymap}>
        <ErrorBoundary fallback={(error) => <box padding={1}><text fg="#ff6b6b">{`Tinkerbot TUI recovered from a render error: ${String(error)}`}</text><text>Press q to exit or r to retry the local adapter.</text></box>}>
          <TuiApp adapter={createLocalAdapter(options)} onQuit={close} />
        </ErrorBoundary>
      </KeymapProvider>
    ), renderer);
    // Keep the interactive render loop alive. OpenTUI can auto-start when a
    // renderable requests a live frame, but a static first frame may otherwise
    // let the Bun process exit before keyboard input is handled.
    const stopped = new Promise<void>((resolve) => renderer.once("destroy", resolve));
    renderer.start();
    await stopped;
  } finally {
    process.removeListener("SIGINT", onSignal);
    process.removeListener("SIGTERM", onSignal);
    close();
  }
}

if (import.meta.main) await startTui(parseOptions(process.argv.slice(2)));
