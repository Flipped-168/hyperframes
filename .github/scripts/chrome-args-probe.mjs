// Launches Chrome with exactly the arguments in a file (no puppeteer defaults) and loads one page.
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
const [workspace, executablePath, argsFile, profile, hop] = process.argv.slice(2);
if (hop === "hop") {
  // Re-run one consoleless hop down, the way an app starts the CLI.
  spawn(process.execPath, [process.argv[1], workspace, executablePath, argsFile, profile], {
    windowsHide: true,
    stdio: "ignore",
  }).on("exit", (code) => process.exit(code ?? 0));
} else {
  const args = readFileSync(argsFile, "utf8").split(/\r?\n/).filter(Boolean);
  const puppeteer = createRequire(workspace + "/package.json")("puppeteer-core");
  const browser = await puppeteer.launch({
    executablePath,
    headless: true,
    pipe: true,
    ignoreDefaultArgs: true,
    args: [
      ...args,
      "--headless=new",
      "--enable-automation",
      `--user-data-dir=${profile}`,
      "about:blank",
    ],
  });
  const page = await browser.newPage();
  await page.goto("data:text/html,<p>probe</p>");
  await new Promise((resolve) => setTimeout(resolve, 1500));
  await browser.close();
}
