import childProcess from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { promisify } from "node:util";

type Spawner = (command: string, ...rest: unknown[]) => unknown;
type ChildProcessModule = Record<string, unknown>;

const ENTRY_POINTS = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];

/** The call's arguments with `windowsHide: true` set unless the caller chose either way. */
function hidden(command: string, rest: unknown[]): unknown[] {
  const at = rest.findIndex((arg) => arg && typeof arg === "object" && !Array.isArray(arg));
  if (at >= 0) {
    const options = rest[at] as { windowsHide?: boolean };
    return [command, ...rest.with(at, { windowsHide: true, ...options })];
  }
  const callback = rest.findIndex((arg) => typeof arg === "function");
  return [
    command,
    ...rest.toSpliced(callback < 0 ? rest.length : callback, 0, { windowsHide: true }),
  ];
}

/**
 * On Windows a console program started without `windowsHide` opens a visible console window, and so does every
 * child it starts. Every child this process starts, ours and our dependencies', is hidden unless it opts out
 * with `windowsHide: false` (a browser or app the person is meant to see).
 */
export function hideChildConsoles(
  target: ChildProcessModule = childProcess as unknown as ChildProcessModule,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform !== "win32") return;
  for (const name of ENTRY_POINTS) {
    const original = target[name] as Spawner & { [promisify.custom]?: Spawner };
    const wrapped: Spawner & { [promisify.custom]?: Spawner } = (command, ...rest) =>
      original(...(hidden(command, rest) as [string, ...unknown[]]));
    const custom = original[promisify.custom];
    if (custom)
      wrapped[promisify.custom] = (command, ...rest) =>
        custom(...(hidden(command, rest) as [string]));
    target[name] = wrapped;
  }
  if (target === (childProcess as unknown as ChildProcessModule)) syncBuiltinESMExports();
}

hideChildConsoles();
