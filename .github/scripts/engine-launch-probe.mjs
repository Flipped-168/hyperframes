// Launches Chrome through the engine's own browser pool, as render and snapshot do, and loads one page.
// With `hop` it first re-runs itself the way an app starts the CLI: windowsHide, stdio ignored.
import { spawn } from "node:child_process";
import { pathToFileURL } from "node:url";
const [workspace, chrome, hop] = process.argv.slice(2);
if (hop === "hop") {
  spawn(process.execPath, [process.argv[1], workspace, chrome], { windowsHide: true, stdio: "ignore" }).on(
    "exit",
    (code) => process.exit(code ?? 0),
  );
} else {
  process.env.HYPERFRAMES_BROWSER_PATH = chrome;
  const engine = await import(pathToFileURL(`${workspace}/packages/engine/dist/index.js`).href);
  const lease = await engine.acquireBrowser(engine.buildChromeArgs({ width: 1920, height: 1080 }));
  const page = await lease.browser.newPage();
  await page.goto("data:text/html,<p>probe</p>");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await engine.releaseBrowser(lease.browser);
}
