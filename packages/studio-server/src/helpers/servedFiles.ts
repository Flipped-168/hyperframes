import type { ReadStream } from "node:fs";
import { resolve } from "node:path";

// Windows refuses to replace a file while any read of it is open, and a loaded <video> keeps its read open.
const serving = new Map<string, Set<ReadStream>>();
const keyOf = (path: string) =>
  process.platform === "win32" ? resolve(path).toLowerCase() : resolve(path);

/** Tracks a read the preview serves from `path` until it closes. */
export function serveWhileOpen(path: string, stream: ReadStream): ReadStream {
  const key = keyOf(path);
  const reads = serving.get(key) ?? new Set();
  serving.set(key, reads.add(stream));
  stream.once("close", () => {
    reads.delete(stream);
    if (reads.size === 0 && serving.get(key) === reads) serving.delete(key);
  });
  return stream;
}

/** Ends the preview's open reads of `path` so it can be replaced; the player asks again for the new bytes. */
export function stopServing(path: string): void {
  for (const stream of serving.get(keyOf(path)) ?? []) stream.destroy();
}
