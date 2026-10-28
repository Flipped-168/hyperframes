import { createRequire } from "node:module";
const [workspace, executablePath, flag] = process.argv.slice(2);
const puppeteer = createRequire(workspace + "/package.json")("puppeteer-core");
const browser = await puppeteer.launch({
  executablePath,
  headless: true,
  pipe: true,
  detached: false,
  args: flag ? [flag] : [],
});
const page = await browser.newPage();
await page.goto("data:text/html,<p>probe</p>");
await new Promise((resolve) => setTimeout(resolve, 1500));
await browser.close();
