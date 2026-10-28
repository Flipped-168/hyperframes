// Launches the managed Chrome the way the CLI does (pipe, no sandbox) and loads one page, so a renderer exists.
// With `hop`, it first re-runs itself the way the CLI is started by an app: windowsHide, stdio ignored.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const [workspace, executablePath, hop] = process.argv.slice(2);
if (hop === "hop") {
  spawn(process.execPath, [process.argv[1], workspace, executablePath], { windowsHide: true, stdio: "ignore" }).on(
    "exit",
    (code) => process.exit(code ?? 0),
  );
} else {
  const puppeteer = createRequire(workspace + "/package.json")("puppeteer-core");
  const browser = await puppeteer.launch({ executablePath, headless: true, pipe: true, args: ["--no-sandbox"] });
  const page = await browser.newPage();
  await page.goto("data:text/html,<p>probe</p>");
  await new Promise((resolve) => setTimeout(resolve, 2000));
  await browser.close();
}
