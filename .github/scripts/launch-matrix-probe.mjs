// One Chrome launch with one variation of what the engine passes to Puppeteer, then a page, so a renderer exists.
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
const [workspace, chrome, variant] = process.argv.slice(2);
const engineRequire = createRequire(`${workspace}/packages/engine/package.json`);
const engine = await import(pathToFileURL(`${workspace}/packages/engine/dist/index.js`).href);
const lib = variant.includes("core") ? engineRequire("puppeteer-core") : engineRequire("puppeteer");
const args = variant.includes("noargs") ? ["--no-sandbox"] : engine.buildChromeArgs({ width: 1920, height: 1080 });
const options = {
  headless: true,
  pipe: true,
  args,
  executablePath: chrome,
  ...(variant.includes("viewport") ? {} : { defaultViewport: null }),
  ...(variant.includes("nodetach") ? {} : { detached: false }),
  ...(variant.includes("noenv") ? {} : { env: { ...process.env } }),
  ...(variant.includes("sigint") ? { handleSIGINT: true } : { handleSIGINT: false }),
};
const browser = await lib.launch(options);
const page = await browser.newPage();
await page.goto("data:text/html,<p>probe</p>");
await new Promise((resolve) => setTimeout(resolve, 1500));
await browser.close();
