import fs from "node:fs";
import path from "node:path";

const SHELL_CONTROL = /[;&|<>`\n\r]/;

function isWithin(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
}

function existingRealPath(target: string): string {
  let current = target;
  while (!fs.existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) return path.resolve(target);
    current = parent;
  }
  try {
    return fs.realpathSync.native(current);
  } catch {
    return path.resolve(current);
  }
}

/** Resolve a user/configuration path and reject traversal or symlink escapes. */
export function resolveRepositoryPath(root: string, input: string): string {
  if (!input || input.includes("\0")) throw new Error("Repository path must be a non-empty string without NUL bytes.");
  const rootAbsolute = path.resolve(root);
  const target = path.resolve(rootAbsolute, input);
  if (!isWithin(rootAbsolute, target)) throw new Error(`Path escapes the repository root: ${input}`);
  const rootReal = existingRealPath(rootAbsolute);
  const targetReal = existingRealPath(target);
  if (!isWithin(rootReal, targetReal)) throw new Error(`Path resolves outside the repository root: ${input}`);
  return target;
}

export function repositoryRelativePath(root: string, input: string): string {
  const target = resolveRepositoryPath(root, input);
  return path.relative(path.resolve(root), target).split(path.sep).join("/") || ".";
}

export function hasShellControl(command: string): boolean {
  return SHELL_CONTROL.test(command) || /\$\(|\$\{|\$[A-Za-z_][A-Za-z0-9_]*/.test(command);
}

/** Tokenize a simple executable-plus-arguments command without invoking a shell. */
export function tokenizeCommand(command: string): string[] {
  if (!command.trim()) throw new Error("Command must not be empty.");
  if (command.includes("\0")) throw new Error("Command contains a NUL byte.");
  if (hasShellControl(command)) throw new Error("Command contains shell control syntax; use an executable and explicit arguments.");
  const tokens: string[] = [];
  let token = "";
  let started = false;
  let quote: "single" | "double" | undefined;
  let escaping = false;
  for (const character of command) {
    if (escaping) {
      token += character;
      started = true;
      escaping = false;
      continue;
    }
    if (quote === "single") {
      if (character === "'") quote = undefined;
      else token += character;
      started = true;
      continue;
    }
    if (quote === "double") {
      if (character === '"') quote = undefined;
      else if (character === "\\") escaping = true;
      else token += character;
      started = true;
      continue;
    }
    if (character === "\\") {
      escaping = true;
      started = true;
    } else if (character === "'") {
      quote = "single";
      started = true;
    } else if (character === '"') {
      quote = "double";
      started = true;
    } else if (/\s/.test(character)) {
      if (started) {
        tokens.push(token);
        token = "";
        started = false;
      }
    } else {
      token += character;
      started = true;
    }
  }
  if (escaping || quote) throw new Error("Command contains an unterminated quote or escape.");
  if (started) tokens.push(token);
  if (!tokens.length) throw new Error("Command must contain an executable.");
  return tokens;
}

/** Redact common secret-bearing environment values before displaying diagnostics. */
export function redactSecrets(value: string, extraSecrets: string[] = []): string {
  const secrets = Object.entries(process.env)
    .filter(([name, secret]) => /token|secret|password|credential|private.?key|api.?key/i.test(name) && Boolean(secret) && secret!.length >= 4)
    .map(([, secret]) => secret as string)
    .concat(extraSecrets.filter((secret) => secret.length >= 4))
    .sort((left, right) => right.length - left.length);
  let redacted = value;
  for (const secret of [...new Set(secrets)]) redacted = redacted.split(secret).join("[REDACTED]");
  redacted = redacted.replace(/(Bearer\s+)[^\s,]+/gi, "$1[REDACTED]");
  redacted = redacted.replace(/([?&](?:token|secret|password|key)=)[^&\s]+/gi, "$1[REDACTED]");
  return redacted;
}

/** Remove common credentials before invoking repository-controlled commands. */
export function safeChildEnvironment(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const environment = { ...process.env };
  for (const name of Object.keys(environment)) {
    if (/token|secret|password|credential|private.?key|api.?key|^NODE_OPTIONS$|^BASH_ENV$|^ENV$|^GIT_SSH_COMMAND$/i.test(name)) delete environment[name];
  }
  return { ...environment, ...extra };
}
