import { spawn } from "node:child_process";
const [exe, detached] = process.argv.slice(2);
const args = /chrome/.test(exe) ? ["--no-sandbox", "--remote-debugging-pipe", "about:blank"] : ["-version"];
const child = spawn(exe, args, { windowsHide: true, detached: detached === "1", stdio: ["ignore", "ignore", "ignore", "pipe", "pipe"] });
setTimeout(() => { child.kill(); process.exit(0); }, 2500);
