#!/usr/bin/env node
// Usage: node run.mjs <label> <hyperframes-cli-entry> <runs> <fixture-dir>... [-- extra render args]
// Renders one at a time, interleaving fixtures per run. Appends one JSON line per render to
// results.jsonl next to this file: wall, exit code, output sha256, the CLI's stage line and
// per-phase durations from the [Render:trace] lines.
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const [label, cli, runsArg, ...rest] = process.argv.slice(2);
const sep = rest.indexOf("--");
const fixtures = (sep === -1 ? rest : rest.slice(0, sep)).map((f) => resolve(f));
const extra = sep === -1 ? [] : rest.slice(sep + 1);
mkdirSync(join(here, "out"), { recursive: true });
mkdirSync(join(here, "logs"), { recursive: true });
const env = { ...process.env, HYPERFRAMES_NO_TELEMETRY: "1", DO_NOT_TRACK: "1", HYPERFRAMES_NO_UPDATE_CHECK: "1", CI: "1" };

for (let run = 1; run <= Number(runsArg); run++) {
  for (const fx of fixtures) {
    const name = basename(fx);
    const out = join(here, "out", `${label}-${name}-${run}.mp4`);
    const log = join(here, "logs", `${label}-${name}-${run}.log`);
    rmSync(out, { force: true });
    const t0 = performance.now();
    const r = await renderWithPeakRss([cli, "render", fx, "-o", out, ...extra]);
    const wall = (performance.now() - t0) / 1000;
    const text = r.output.replace(/\x1b\[[0-9;]*m/g, "");
    writeFileSync(log, text);
    const phases = {};
    for (const m of text.matchAll(/\[Render:trace\] (\{.*\})/g)) {
      try {
        const e = JSON.parse(m[1]);
        if (e.status === "end" && typeof e.durationMs === "number") phases[e.phase] = (phases[e.phase] ?? 0) + e.durationMs;
      } catch {}
    }
    const stages = text.split("\n").filter((l) => /capture .*·/.test(l)).pop()?.trim() ?? "";
    const workers = text.match(/"workerCount":(\d+)/)?.[1];
    const sha = existsSync(out) ? createHash("sha256").update(readFileSync(out)).digest("hex").slice(0, 16) : "none";
    const row = { label, fixture: name, run, rc: r.status, wall_s: +wall.toFixed(2), peak_rss_mb: r.peakRssMb, workers: workers ? +workers : null, sha, stages, phases, args: extra.join(" "), os: process.platform };
    appendFileSync(join(here, "results.jsonl"), JSON.stringify(row) + "\n");
    console.log(JSON.stringify({ fixture: name, run, rc: r.status, wall_s: row.wall_s, peak_rss_mb: r.peakRssMb, workers: row.workers, sha, stages }));
  }
}

// Peak summed RSS of the CLI and every descendant (Chrome, ffmpeg), sampled every 250 ms via ps (macOS/Linux).
async function renderWithPeakRss(args) {
  const child = spawn(process.execPath, args, { env, stdio: ["ignore", "pipe", "pipe"] });
  let output = "";
  child.stdout.on("data", (d) => (output += d));
  child.stderr.on("data", (d) => (output += d));
  let peakKb = 0;
  const sample = () => {
    if (process.platform === "win32") return;
    try {
      const rows = execFileSync("ps", ["-A", "-o", "pid=,ppid=,rss="], { encoding: "utf8" })
        .trim().split("\n").map((l) => l.trim().split(/\s+/).map(Number));
      const kids = new Map();
      for (const [pid, ppid] of rows) kids.set(ppid, [...(kids.get(ppid) ?? []), pid]);
      const rss = new Map(rows.map(([pid, , kb]) => [pid, kb]));
      let total = 0;
      const stack = [child.pid];
      while (stack.length) {
        const pid = stack.pop();
        total += rss.get(pid) ?? 0;
        stack.push(...(kids.get(pid) ?? []));
      }
      peakKb = Math.max(peakKb, total);
    } catch {}
  };
  const timer = setInterval(sample, 250);
  const status = await new Promise((res) => child.on("close", (code) => res(code)));
  clearInterval(timer);
  return { status, output, peakRssMb: Math.round(peakKb / 1024) };
}
