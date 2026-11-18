// Screenshots of every page on a local chain with a demo event, in light and dark, desktop and phone.
//   node tools/screenshots.mjs <out dir>
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";
import { startChain, deployAll, root, load, keyOf } from "../test/helpers.mjs";
import { serve } from "../scripts/serve.mjs";

const require = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = require("playwright")); } catch { ({ chromium } = require("/opt/node-tools/node_modules/playwright")); }
const outDir = path.resolve(process.argv[2] ?? "screenshots");
fs.mkdirSync(outDir, { recursive: true });
const RPC = 18591, WEB = 18592, BASE = `http://127.0.0.1:${WEB}`;
const chain = await startChain({ port: RPC, accounts: 12 });
const P = await deployAll(chain.wallets[0]);
const t = (await chain.prov.getBlock("latest")).timestamp;
const D = ethers.parseEther("0.01");
const f = P.factory.connect(chain.wallets[1]);
const r = await (await f.createEvent(["Builders Dinner, Berlin", "https://luma.com/example", ethers.ZeroAddress, D, t + 3 * 86400, t + 3 * 86400 + 4 * 3600, t + 20 * 86400, 60])).wait();
await (await f.createEvent(["Kleros Community Call", "", ethers.ZeroAddress, D, t + 6 * 86400, t + 6 * 86400 + 3600, t + 20 * 86400, 0])).wait();
const ev = r.logs.map((l) => { try { return P.factory.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "EventCreated").args.eventContract;
for (const i of [2, 3, 4, 5, 6, 7, 8]) await (await chain.wallets[i].sendTransaction({ to: ev, value: D })).wait();
const dep = { chainId: 1337, name: "Ethereum mainnet", explorer: "https://etherscan.io", rpcs: [`http://127.0.0.1:${RPC}`], factory: P.factoryAddress, implementation: P.implementation };
const depFile = path.join(root, "build", "shot-deployment.json");
fs.writeFileSync(depFile, JSON.stringify(dep));
const site = path.join(root, "dist-shot");
execFileSync("node", [path.join(root, "scripts/build-web.mjs"), "--deployment", depFile, "--out", site]);
const web = await serve(site, WEB);
const browser = await chromium.launch();
const organiser = new ethers.Wallet(keyOf(1)).address;
const pages = [["home", "index.html"], ["create", "create.html"], ["guest", `event.html?e=${ev}`], ["organiser", `organiser.html?e=${ev}`]];
for (const scheme of ["light", "dark"]) {
  for (const [dev, opts] of [["desktop", { viewport: { width: 1280, height: 860 }, deviceScaleFactor: 2 }], ["phone", { viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true }]]) {
    const ctx = await browser.newContext({ ...opts, colorScheme: scheme });
    await ctx.addInitScript(({ rpc, account }) => {
      window.ethereum = { on() {}, async request({ method, params }) {
        if (method.endsWith("ccounts")) return [account];
        const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
        return (await r.json()).result;
      } };
    }, { rpc: `http://127.0.0.1:${RPC}`, account: organiser });
    for (const [name, url] of pages) {
      const page = await ctx.newPage();
      await page.goto(`${BASE}/${url}`);
      if (name === "organiser") { await page.click("#connect"); await page.waitForSelector("#dash:not([hidden])"); }
      if (name === "guest") await page.waitForSelector("#ev:not([hidden])");
      if (name === "home") await page.waitForSelector(".event-list");
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outDir, `${name}-${dev}-${scheme}.png`), fullPage: true });
      await page.close();
    }
    await ctx.close();
  }
}
await browser.close();
web.close();
await chain.server.close();
fs.rmSync(site, { recursive: true, force: true });
console.log(`Screenshots in ${outDir}`);
