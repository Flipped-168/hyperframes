import { spawn } from "node:child_process";
const [exe, detached, nested] = process.argv.slice(2);
if (nested === "1") {
  // One more consoleless hop, like a CLI started by an app that has no console.
  spawn(process.execPath, [process.argv[1], exe, detached, "0"], { windowsHide: true, stdio: "ignore" }).on("exit", (c) => process.exit(c ?? 0));
} else {
  const args = /chrome/.test(exe) ? ["--no-sandbox", "--remote-debugging-pipe", "about:blank"] : ["-version"];
  const child = spawn(exe, args, { windowsHide: true, detached: detached === "1", stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
  setTimeout(() => { child.kill(); process.exit(0); }, 2500);
}
