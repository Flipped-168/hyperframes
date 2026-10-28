// Preloaded with NODE_OPTIONS: logs every child process started without windowsHide, with its call site.
const fs = require("node:fs");
const cp = require("node:child_process");
const out = process.env.HF_SPAWN_AUDIT;
const note = (kind, file, args, options) => {
  if (options && options.windowsHide === true) return;
  const site = (new Error().stack || "").split("\n").slice(3, 9).map((l) => l.trim().replace(/^at /, "")).filter((l) => !l.includes("node:")).slice(0, 3).join(" < ");
  fs.appendFileSync(out, `${kind} ${file} ${(args || []).join(" ").slice(0, 80)} :: ${site}\n`);
};
const proto = cp.ChildProcess.prototype;
const spawn = proto.spawn;
proto.spawn = function (options) {
  note("spawn", options.file, options.args && options.args.slice(1), options);
  return spawn.call(this, options);
};
for (const name of ["spawnSync", "execSync", "execFileSync"]) {
  const original = cp[name];
  cp[name] = function (file, a, b) {
    const options = Array.isArray(a) ? b : name === "execSync" ? a : a;
    note(name, file, Array.isArray(a) ? a : [], options && typeof options === "object" ? options : undefined);
    return original.apply(this, arguments);
  };
}
require("node:module").syncBuiltinESMExports();
