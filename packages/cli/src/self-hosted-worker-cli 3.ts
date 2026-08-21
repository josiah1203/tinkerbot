import fs from "node:fs";
import { factoryDefinitionDigest, loadFactoryDefinition } from "../../factory/src";
import { resolveCredentialRef, runSelfHostedDispatch, selectLocalSandbox } from "../../local-runtime/src";

export const SELF_HOSTED_WORKER_HELP = `Tinkerbot self-hosted worker

Consumes one credential-free signed dispatch envelope, runs the configured
customer harness in the repository's sandbox, and posts a signed completion.

Usage:
  tinkerbot-factory worker --root /repo --completion-url https://control.example/self-hosted/complete \\
    --secret-ref env:TINKERBOT_SELF_HOSTED_SECRET [--input dispatch.json]

Options:
  --root <path>                 repository containing .tinkerbot/factory.yaml
  --completion-url <url>        control-plane completion endpoint (HTTPS)
  --secret-ref <reference>      env:VAR or keychain://service/account; raw keys are rejected
  --input <path>                dispatch JSON file (defaults to stdin)
  --allow-process-runner        explicit, non-isolated host-process fallback
`;

async function readStdin(maxBytes = 1_500_000): Promise<string> {
  const chunks: Buffer[] = [];
  let total = 0;
  for await (const chunk of process.stdin) {
    const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    total += value.byteLength;
    if (total > maxBytes) throw new Error("dispatch input exceeds the 1.5 MB limit");
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export async function mainSelfHostedWorker(argv: string[] = process.argv.slice(2)): Promise<number> {
  let root = process.cwd();
  let completionUrl: string | undefined;
  let secretRef: string | undefined;
  let inputPath: string | undefined;
  let allowProcessRunner = false;
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(SELF_HOSTED_WORKER_HELP);
      return 0;
    }
    if (arg === "--allow-process-runner") { allowProcessRunner = true; continue; }
    const [flag, inline] = arg.includes("=") ? arg.split(/=(.*)/s, 2) as [string, string] : [arg, undefined];
    if (!["--root", "--completion-url", "--secret-ref", "--input"].includes(flag)) {
      process.stderr.write(`Unknown argument: ${arg}\n`);
      return 3;
    }
    const value = inline ?? argv[++index];
    if (!value || value.startsWith("--")) {
      process.stderr.write(`${flag} requires a value\n`);
      return 3;
    }
    if (flag === "--root") root = value;
    else if (flag === "--completion-url") completionUrl = value;
    else if (flag === "--secret-ref") secretRef = value;
    else inputPath = value;
  }
  if (!completionUrl || !secretRef) {
    process.stderr.write("worker requires --completion-url and --secret-ref\n");
    return 3;
  }
  try {
    const secret = resolveCredentialRef(secretRef);
    if (!secret) throw new Error("the self-hosted signing secret reference did not resolve");
    const dispatchText = inputPath ? fs.readFileSync(inputPath, "utf8") : await readStdin();
    if (Buffer.byteLength(dispatchText, "utf8") > 1_500_000) throw new Error("dispatch input exceeds the 1.5 MB limit");
    const dispatch = JSON.parse(dispatchText) as unknown;
    const loaded = loadFactoryDefinition(root);
    const selected = selectLocalSandbox({ allowProcessRunner, env: process.env });
    const result = await runSelfHostedDispatch({
      dispatch,
      secret,
      repositoryRoot: root,
      harnesses: loaded.definition.harnesses,
      workerHost: loaded.definition.runtime.workerHost,
      definitionDigest: factoryDefinitionDigest(loaded.definition),
      sandbox: selected.sandbox,
      completionUrl,
      env: process.env,
    });
    process.stdout.write(`${JSON.stringify({ ...result, warning: selected.warning }, null, 2)}\n`);
    return result.accepted && result.status === "completed" ? 0 : 1;
  } catch (error) {
    process.stderr.write(`self-hosted worker failed: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}
