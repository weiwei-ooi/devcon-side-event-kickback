// Browser test of the hosted admin panel (scripts/build-admin.mjs → the console page in "hosted" mode)
// against ganache with a fake injected wallet, stand-ins for Kleros Court v1 (test/MockKleros.sol) and
// for Kleros's IPFS upload service and gateway (the page's requests are intercepted; any other request
// outside this computer is blocked and counted):
// the build (four files, the settings baked in; refused without the compiled contract or with a
// Dispute Resolver that is not Kleros's on mainnet) → the page opens with no event → a new event from
// the form (preview, a refused deposit, the juror policy saved on IPFS only at its computed address,
// one confirmation, then the admin and guest links; a second one asks first) → the deposits table
// (none yet; register selected; refund selected; a ticked list made out of date by a return is refused)
// → the Luma guest list (approved ticked to register, declined to refund, the rest listed; the file
// never leaves the browser) → the scripts' lists from files (another contract and out of date refused)
// → another wallet: owner buttons disabled → links with ?contract=&from=, without from (the deploy
// block is searched), with a wrong from → a contract with another Dispute Resolver is flagged → the
// attendance list from the check-in export (locked until the event starts, POST typed; a payout-plan.json
// for another contract or out of date refused) → a guest left off challenges and the organiser disputes it
// (its case description saved on IPFS first) → payouts, one share set aside for the Kleros case → the page
// fits a phone's width. Also: the event's timezone (none preselected that isn't this computer's on the
// event's date; a timezone name that contradicts the offset refused; the start shown in UTC), the
// Luma setup the checks need, a refunded guest who paid again registered from the table, a late payer's
// Luma tick that does not survive a return, a check-in export without a deposit link column, a door
// list alone, a contract with other code refused, a juror policy that is not an IPFS path not linked,
// and a page whose code did not load says so. Never "Claude", never "console" on the page, its dialogs
// or its log; every transaction carries the chainId and at most 2^24 gas; nothing is fetched from
// outside this computer.
// Needs Playwright with Chromium (see test/site.e2e.mjs).
//   node test/admin.e2e.mjs
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import http from "node:http";
import { EventEmitter } from "node:events";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
const proj = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const req = createRequire(path.join(proj, "package.json"));
const ganache = req("ganache");
const { ethers } = req("ethers");
const core = await import(path.join(proj, "scripts/core.mjs"));
let chromium;
try { ({ chromium } = req("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/node_modules/")("playwright")); }
const E = (x) => ethers.parseEther(String(x));
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const DAY = 86400;
// free ports, so this test can run next to the other suites
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.once("error", rej); s.listen(0, "127.0.0.1", () => { const p = s.address().port; s.close(() => res(p)); }); });
const RPC = await freePort(), WEB = await freePort();
const NAMES = ["owner", "ana", "ben", "cai", "dan", "eve", "fay", "gus", "stranger"];
const keys = NAMES.map((_, i) => "0x" + (i + 31).toString(16).padStart(64, "0"));
EventEmitter.defaultMaxListeners = 50;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true, cacheTimeout: -1 });
const W = Object.fromEntries(NAMES.map((n, i) => [n, new ethers.NonceManager(new ethers.Wallet(keys[i], prov))]));
const A = Object.fromEntries(await Promise.all(NAMES.map(async (n) => [n, await W[n].getAddress()])));
const { owner } = W;
const me = A.owner;
const bal = (a) => prov.getBalance(a);
const dep = async (n, ...a) => (await new ethers.ContractFactory(load(n).abi, load(n).bytecode, owner).deploy(...a)).waitForDeployment();
const liquid = await dep("MockKlerosLiquid");
const proxy = await dep("MockArbitrableProxy", liquid.target);
const otherProxy = await dep("MockArbitrableProxy", liquid.target); // not "Kleros's" on this chain
const abi = load("TruthPaysKickback").abi;
const genericPolicy = fs.readFileSync(path.join(proj, core.GENERIC_POLICY), "utf8");
const genericTemplate = fs.readFileSync(path.join(proj, core.GENERIC_METAEVIDENCE_TEMPLATE), "utf8");
const POLICY = core.ipfsPathOf(genericPolicy);

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };

// ---------------------------------------------------------------- the build
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "admin-e2e-"));
const adminDir = path.join(tmp, "site", "admin");
const config = {
  eventName: "unused", chain: "local", chainId: 1337, chainName: "Local test chain", rpcUrl: `http://127.0.0.1:${RPC}`, explorer: "https://etherscan.io",
  logChunk: 7, deposit: "0.01", receiver: "0x0000000000000000000000000000000000000001",
  kleros: { court: 0, jurors: 3, disputeResolver: proxy.target, arbitrator: liquid.target },
};
const cfgFile = path.join(tmp, "config.json");
fs.writeFileSync(cfgFile, JSON.stringify(config));
const build = (script, ...a) => spawnSync("node", [script, ...a], { cwd: proj, encoding: "utf8" });
const BUILD = path.join(proj, "scripts", "build-admin.mjs");
let b = build(BUILD, "--out", adminDir, "--config", cfgFile);
check("build-admin builds the panel", b.status === 0, b.stderr);
check("build-admin writes exactly index.html, ethers.min.js, core.mjs and kickback.json",
  JSON.stringify(fs.readdirSync(adminDir).sort()) === JSON.stringify(["core.mjs", "ethers.min.js", "index.html", "kickback.json"]), fs.readdirSync(adminDir).join(","));
const builtHtml = fs.readFileSync(path.join(adminDir, "index.html"), "utf8");
const hostedOf = (html) => JSON.parse(html.match(/\/\*HOSTED\*\/ const HOSTED = ([\s\S]*?); \/\*END HOSTED\*\//)?.[1] ?? "null");
const H0 = hostedOf(builtHtml);
check("the page's settings are baked in: network, Kleros, generic policy and template, no default event",
  H0?.chainId === 1337 && H0.rpcUrl === config.rpcUrl && H0.logChunk === 7 && H0.kleros.disputeResolver === proxy.target && H0.kleros.arbitrator === liquid.target &&
  H0.policy.uri === POLICY && H0.policy.text === genericPolicy && H0.template.text === genericTemplate && H0.defaultEvent === null && H0.artifact === "kickback.json" && H0.guestPage === "../event/",
  JSON.stringify(H0).slice(0, 300));
check("import map points at the copies next to the page; body in hosted mode; title",
  builtHtml.includes('"ethers": "./ethers.min.js"') && builtHtml.includes('"kickback/core": "./core.mjs"') && !builtHtml.includes("/node_modules/") &&
  builtHtml.includes('<body class="hosted">') && builtHtml.includes("<title>Kickback · Admin panel</title>"));
check("the kickback contract's runtime code is baked in (its fingerprint, immutable values left out)",
  /^0x[0-9a-f]{64}$/.test(H0?.runtime?.sha256 ?? "") && H0.runtime.immutables.length > 0 && H0.runtime.immutables.every(([s, l]) => Number.isInteger(s) && l === 32), JSON.stringify(H0?.runtime));
check("the copies are the repo's: core, ethers ESM build, compiled contract",
  fs.readFileSync(path.join(adminDir, "core.mjs"), "utf8") === fs.readFileSync(path.join(proj, "scripts/core.mjs"), "utf8") &&
  fs.readFileSync(path.join(adminDir, "ethers.min.js"), "utf8") === fs.readFileSync(path.join(proj, "node_modules/ethers/dist/ethers.min.js"), "utf8") &&
  JSON.parse(fs.readFileSync(path.join(adminDir, "kickback.json"), "utf8")).bytecode === load("TruthPaysKickback").bytecode);
// the live config: mainnet, Kleros's own contracts, the deployed contract opened by default (nothing is fetched)
const liveDir = path.join(tmp, "live");
b = build(BUILD, "--out", liveDir);
const HL = b.status === 0 ? hostedOf(fs.readFileSync(path.join(liveDir, "index.html"), "utf8")) : null;
const live = JSON.parse(fs.readFileSync(path.join(proj, "config.json"), "utf8"));
check("built from config.json: Ethereum mainnet, Kleros's Dispute Resolver and court, the live contract by default",
  HL?.chainId === 1 && HL.rpcUrl === live.rpcUrl && HL.kleros.disputeResolver.toLowerCase() === core.KLEROS[1].disputeResolver.toLowerCase() &&
  HL.kleros.arbitrator === core.KLEROS[1].arbitrator && HL.defaultEvent?.contract === ethers.getAddress(live.contract) && HL.defaultEvent?.deployBlock === live.deployBlock && HL.policy.uri === POLICY,
  b.stderr + JSON.stringify(HL?.defaultEvent));
b = build(BUILD);
check("build-admin needs --out", b.status !== 0 && /Usage: node scripts\/build-admin\.mjs --out <dir>/.test(b.stderr), b.stderr);
const badCfg = path.join(tmp, "bad.json");
fs.writeFileSync(badCfg, JSON.stringify({ chain: "ethereum", deposit: "0.01", receiver: config.receiver, kleros: { disputeResolver: proxy.target } }));
b = build(BUILD, "--out", path.join(tmp, "bad"), "--config", badCfg);
check("on mainnet, a Dispute Resolver that is not Kleros's is refused", b.status !== 0 && /not Kleros's own 0x4b89e798b10478a839ea0abcf86c4b94a3c782a4/i.test(b.stderr) && !fs.existsSync(path.join(tmp, "bad")), b.stderr);
// never on the website of a baked guest page (like the live Truth Pays page): links there look like that event's own
const bakedSite = path.join(tmp, "baked-site");
fs.mkdirSync(bakedSite);
fs.writeFileSync(path.join(bakedSite, "index.html"), `<script>/*CONFIG*/ const CONFIG = ${JSON.stringify({ contract: proxy.target, chainId: 1337 })}; /*END CONFIG*/</script>`);
b = build(BUILD, "--out", path.join(bakedSite, "admin"), "--config", cfgFile);
check("refused inside the website of a baked guest page", b.status !== 0 && /The admin panel must live on another website/.test(b.stderr) && !fs.existsSync(path.join(bakedSite, "admin")), b.stderr);
// a checkout without the compiled contract (build/)
const bare = path.join(tmp, "bare");
for (const d of ["scripts", "console", "docs"]) fs.cpSync(path.join(proj, d), path.join(bare, d), { recursive: true });
fs.copyFileSync(path.join(proj, "package.json"), path.join(bare, "package.json"));
fs.symlinkSync(path.join(proj, "node_modules"), path.join(bare, "node_modules"));
b = build(path.join(bare, "scripts", "build-admin.mjs"), "--out", path.join(tmp, "bare-out"), "--config", cfgFile);
check("refused without build/ (npm run compile first)", b.status !== 0 && /build\/TruthPaysKickback\.json is missing: run `npm run compile` first/.test(b.stderr) && !fs.existsSync(path.join(tmp, "bare-out")), b.stderr);

// ---------------------------------------------------------------- a static host, like GitHub Pages
const TYPES = { ".html": "text/html; charset=utf-8", ".mjs": "text/javascript", ".js": "text/javascript", ".json": "application/json" };
const served = [];
const web = http.createServer((rq, rs) => {
  const p = new URL(rq.url, "http://x").pathname;
  served.push(p);
  const file = p.startsWith("/admin/") ? path.join(adminDir, p.slice(7) || "index.html") : null;
  if (!file || !file.startsWith(adminDir) || !fs.existsSync(file)) { rs.writeHead(404); return rs.end("not found"); }
  rs.writeHead(200, { "content-type": TYPES[path.extname(file)] ?? "application/octet-stream" });
  rs.end(fs.readFileSync(file));
});
await new Promise((r) => web.listen(WEB, "127.0.0.1", r));
const ADMIN = `http://localhost:${WEB}/admin/`;

const browser = await chromium.launch();
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
const sent = []; // every transaction the page asked the wallet to send
let current = owner; // the account the fake wallet extension holds
await page.exposeFunction("__rpc", async (method, params) => {
  const from = await current.getAddress();
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [from];
  if (method === "eth_chainId") return "0x539";
  if (method === "eth_sendTransaction") {
    const t = params[0];
    sent.push(t);
    const r = await current.sendTransaction({ to: t.to ?? null, data: t.data, value: t.value ? BigInt(t.value) : 0n, gasLimit: t.gas ? BigInt(t.gas) : undefined });
    return r.hash;
  }
  return prov.send(method, params ?? []);
});
await page.addInitScript(() => {
  const real = Date.now;
  Date.now = () => real() + (window.__skew || 0);
  window.ethereum = { request: ({ method, params }) => window.__rpc(method, params), on() {}, removeListener() {} };
});
// nothing leaves this computer: the static host and the chain only (Kleros's services are simulated below)
const outside = [], bodies = [];
page.on("request", (r) => bodies.push(`${r.url()} ${r.postData() ?? ""}`));
await page.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if ((u.hostname === "localhost" && u.port === String(WEB)) || (u.hostname === "127.0.0.1" && u.port === String(RPC))) return route.continue();
  outside.push(u.href);
  return route.abort();
});
// `noHistory`: the chain can't read past states (eth_getCode at an old block fails), like most public RPCs
let noHistory = false;
await page.route(new RegExp(`127\\.0\\.0\\.1:${RPC}`), async (route) => {
  if (!noHistory || route.request().method() !== "POST") return route.continue();
  const body = JSON.parse(route.request().postData() || "null");
  const res = await route.fetch();
  const out = await res.json();
  const fix = (q, a) => (q?.method === "eth_getCode" && q.params?.[1] !== "latest" ? { jsonrpc: "2.0", id: a.id, error: { code: -32000, message: "missing trie node" } } : a);
  const json = Array.isArray(out) ? out.map((a) => fix([body].flat().find((q) => q.id === a.id), a)) : fix(body, out);
  return route.fulfill({ response: res, body: JSON.stringify(json) });
});
// Kleros's IPFS upload service and gateway, simulated (as in test/console.e2e.mjs). `wrapPolicy`: the
// service answers with another address (the file inside a folder), which the page must refuse.
const uploads = [], ipfsStore = new Map();
let wrapPolicy = false;
const cors = { "access-control-allow-origin": "*" };
const fileOf = (buf) => { const head = buf.indexOf("\r\n\r\n", buf.indexOf("filename=")) + 4; return buf.subarray(head, buf.indexOf("\r\n--", head)); };
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeCid = (n) => "Qm" + Array.from({ length: 44 }, (_, i) => B58[(n * 7 + i * 13 + 5) % 58]).join("");
await page.route(/cdn\.kleros\.link/, (route) => {
  const p = new URL(route.request().url()).pathname;
  return ipfsStore.has(p) ? route.fulfill({ status: 200, headers: cors, body: ipfsStore.get(p) }) : route.fulfill({ status: 404, headers: cors, body: "not found" });
});
await page.route(/kleros-api\.netlify\.app/, (route) => {
  const r = route.request();
  const buf = r.postDataBuffer();
  const file = buf.toString("utf8").match(/filename="([^"]+)"/)?.[1] ?? "file";
  const content = fileOf(buf);
  const p = wrapPolicy ? `/ipfs/${fakeCid(uploads.length)}/${file}` : `/ipfs/${core.ipfsCidV0(content)}`;
  uploads.push({ operation: new URL(r.url()).searchParams.get("operation"), file, path: p, content: content.toString("utf8") });
  ipfsStore.set(p, content);
  return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ message: "File has been stored successfully", cids: [wrapPolicy ? "ipfs://" + p.slice(6) : p] }) });
});
// confirm() → yes; prompt() → the word it asks for. A queued answer overrides: false = Cancel, a string = typed.
const dialogs = [], answers = [];
page.on("dialog", (d) => {
  dialogs.push(d.message());
  const a = answers.length ? answers.shift() : d.message().match(/Type (\w+)/)?.[1];
  if (a === false) return d.dismiss();
  d.accept(a);
});
const lastDialog = () => dialogs[dialogs.length - 1] ?? "";
const txt = (id) => page.locator("#" + id).innerText();
const logText = () => txt("log");
const visible = () => page.evaluate(() => document.body.innerText);
const waitLog = async (re) => { for (let i = 0; i < 160 && !re.test(await logText()); i++) await page.waitForTimeout(250); return re.test(await logText()); };
const idle = async () => { await page.waitForTimeout(200); for (let i = 0; i < 400 && (await page.isDisabled("#refresh")); i++) await page.waitForTimeout(250); };
const click = async (id, re) => { await page.click("#" + id); const ok = await waitLog(re); await idle(); return ok; };
const clearLog = () => page.locator("#log").evaluate((el) => (el.textContent = ""));
let skewMs = 0;
const skew = async (secs) => { await prov.send("evm_increaseTime", [secs]); await prov.send("evm_mine", []); skewMs += secs * 1000; await page.evaluate((ms) => (window.__skew = ms), skewMs); };
const open = async (query = "") => { await page.goto(ADMIN + query); await page.evaluate((ms) => (window.__skew = ms), skewMs); await idle(); };
const connect = async () => { await page.click("#connect"); for (let i = 0; i < 80 && !/ETH on/.test(await txt("who")); i++) await page.waitForTimeout(250); await idle(); };
const nonce = () => prov.getTransactionCount(me);
const noClaude = async (where) => {
  const v = await visible();
  check(`no "Claude" or "console" on the page (${where})`, !/claude|console/i.test(v), v.match(/.{0,60}(claude|console).{0,60}/i)?.[0]);
};
const rows = () => page.evaluate(() => [...document.querySelectorAll("#depTable tr[data-wallet]")].map((tr) => {
  const r = tr.querySelector("input.register"), f = tr.querySelector("input.refund");
  return { wallet: tr.dataset.wallet.toLowerCase(), text: tr.innerText, reg: !r.disabled, regOn: r.checked, ref: !f.disabled, refOn: f.checked };
}));
const rowOf = async (w) => (await rows()).find((r) => r.wallet === w.toLowerCase());
const tick = (w, kind) => page.evaluate(([w, kind]) => {
  const tr = [...document.querySelectorAll("#depTable tr[data-wallet]")].find((t) => t.dataset.wallet.toLowerCase() === w.toLowerCase());
  const cb = tr?.querySelector("input." + kind);
  if (!cb || cb.disabled) return false;
  if (!cb.checked) cb.click();
  return cb.checked;
}, [w, kind]);
const csvFile = (name, text) => ({ name, mimeType: "text/csv", buffer: Buffer.from(text) });
const jsonFile = (name, d) => ({ name, mimeType: "application/json", buffer: Buffer.from(JSON.stringify(d)) });

// ---------------------------------------------------------------- the page, no event yet
await open();
check("hosted page: title and heading", (await page.title()) === "Kickback · Admin panel" && /Kickback · Admin panel/.test(await page.locator("h1").innerText()), await page.title());
check("hosted parts shown, local parts hidden", await page.isVisible("#createEvent") && await page.isVisible("#loadDeposits") && !(await page.isVisible("#deploy")) && !(await page.isVisible("#register")) && !(await page.isVisible("#refundDeclined")));
check("no event in the link and none by default: nothing opened", (await page.inputValue("#addr")) === "" && (await txt("status")) === "" && (await page.innerText("#refresh")) === "Open");
check("deposit actions wait for an event", await page.isDisabled("#loadDeposits") && await page.isDisabled("#registerSel") && await page.isDisabled("#postList") && await page.isDisabled("#createEvent"));
check("the banner says it is a local test chain", /LOCAL TEST CHAIN/.test(await txt("banner")), await txt("banner"));
await noClaude("no event");
await page.fill("#addr", ethers.Wallet.createRandom().address);
check("an address with no contract is explained", await click("refresh", /There is no contract at 0x[0-9a-fA-F]{40} on Local test chain/), await logText());
await page.fill("#addr", liquid.target);
check("a contract that is not a deposit contract is explained", await click("refresh", /is not a kickback deposit contract, so this page can't run it/), await logText());
check("nothing shown for them", (await txt("status")) === "" && await page.isDisabled("#loadDeposits"));
await page.fill("#addr", "");

// ---------------------------------------------------------------- a new event from the form
await connect();
check("connect enables the new-event form", !(await page.isDisabled("#previewEvent")) && !(await page.isDisabled("#createEvent")));
const chainNow = (await prov.getBlock("latest")).timestamp;
const t0 = (Math.floor(chainNow / 60) + 120) * 60; // in about two hours, on the minute
const startLocal = new Date(t0 * 1000).toISOString().slice(0, 16);
const endLocal = new Date((t0 + 3 * 3600) * 1000).toISOString().slice(11, 16);
const FORM = { eventTitle: "Admin E2E Night: Talks and Dinner", eventName: "Admin E2E Night", eventWhere: "Test Hall, 1 Main Street", hosts: "Kleros and friends", eventLink: "https://luma.com/admin-e2e" };
await page.fill("#neTitle", FORM.eventTitle); await page.fill("#neName", FORM.eventName);
await page.fill("#neStart", startLocal); await page.fill("#neEnd", endLocal);
await page.selectOption("#neTz", "+00:00"); await page.fill("#neZone", "UTC");
await page.fill("#neWhere", FORM.eventWhere); await page.fill("#neHosts", FORM.hosts); await page.fill("#neLink", FORM.eventLink);
await page.fill("#neDeposit", "2");
let n0 = await nonce();
check("a deposit above 1 ETH is refused", await click("createEvent", /Deposit: more than 1 ETH per guest looks like a mistake/) && (await nonce()) === n0 && dialogs.length === 0, await logText());
await page.fill("#neDeposit", "0.01");
await page.fill("#neLink", "luma.com/x");
check("a registration link without https:// is refused", await click("previewEvent", /Registration link must be a web address starting with https:\/\//), await logText());
await page.fill("#neLink", FORM.eventLink);
await page.fill("#neDays", "6");
check("settling in less than 7 days is refused", await click("previewEvent", /Settle within: a whole number of days, at least 7/), await logText());
await page.fill("#neDays", "14");
// the timezone: chosen on purpose, and a timezone name must not contradict it (jurors read both)
await page.selectOption("#neTz", "");
check("no timezone chosen: refused", await click("previewEvent", /Timezone of the event: choose the event's UTC offset on its date/), await logText());
await page.selectOption("#neTz", "+00:00");
await page.fill("#neZone", "CEST");
check("a timezone name that is not the chosen offset is refused", await click("previewEvent", /Timezone name: "CEST" is not UTC\+00:00, the timezone of the event on that date/), await logText());
await page.fill("#neZone", "UTC");
check("preview",await click("previewEvent", /Preview ready/), await logText());
const preview = await txt("nePreview");
check("preview: what jurors would read, with the event, an example wallet and the juror policy",
  preview.includes(FORM.eventTitle) && preview.includes(FORM.eventWhere) && preview.includes(FORM.hosts) && preview.includes("0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed") &&
  /Attended/.test(preview) && /Did not attend/.test(preview) && preview.includes(POLICY), preview);
const startsAt = `${startLocal.replace("T", " ")} (UTC+00:00) = ${startLocal.replace("T", " ")} UTC = `;
check("preview: the start in the event's timezone, in UTC and on this computer", preview.includes(`The event starts (deposits close, the attendance list can be posted): ${startsAt}`), preview);
check("the venue is what was planned when the contract was created; the announced venue counts",
  preview.includes(`given when the deposit contract was created as "${FORM.eventWhere}"`) && /the venue announced to registered guests/.test(preview), preview);
// the juror policy saved somewhere else than its computed address: refused, nothing sent
wrapPolicy = true;
n0 = await nonce();
check("policy saved at another address: not created", await click("createEvent", /saved the juror policy at \/ipfs\/Qm\w+\/attendance-policy\.md, not at \/ipfs\/Qm\w+ where the new contract would point\. Not created: nothing was sent/) && (await nonce()) === n0, await logText());
const confirmMsg = lastDialog();
check("one confirmation with everything that can't be changed",
  /Create the deposit contract for this event on Local test chain\?/.test(confirmMsg) && confirmMsg.includes(`Event: ${FORM.eventTitle}`) && confirmMsg.includes(`Short name (in the contract): ${FORM.eventName}`) &&
  /Deposit: 0\.01 ETH per guest/.test(confirmMsg) && /Settle by: .+ \(14 days later/.test(confirmMsg) && /Kleros Court, General Court, 3 jurors/.test(confirmMsg) &&
  confirmMsg.includes(`Starts (deposits close, the attendance list can be posted): ${startsAt}`) &&
  confirmMsg.includes(`Juror policy: ${POLICY}`) && confirmMsg.includes(`Owner: ${me} (this wallet)`) && /None of this can be changed/.test(confirmMsg), confirmMsg);
wrapPolicy = false;
check("create event", await click("createEvent", /Event contract created at 0x[0-9a-fA-F]{40} \(block \d+\)/), await logText());
const policyUp = uploads.filter((u) => u.file === "attendance-policy.md");
check("the juror policy was saved on IPFS (Kleros's service, operation=file), the generic text at its computed address",
  policyUp.length === 2 && policyUp.every((u) => u.operation === "file" && u.content === genericPolicy) && policyUp[1].path === POLICY && ipfsStore.has(POLICY), JSON.stringify(policyUp.map((u) => [u.operation, u.path])));
const kAddr = ethers.getAddress(await page.inputValue("#addr"));
const kBlock = Number(await page.inputValue("#fromBlock"));
const kick = new ethers.Contract(kAddr, abi, owner);
check("the deploy block is the contract's creation block", (await prov.getTransactionReceipt((await prov.getBlock(kBlock, true)).transactions[0]))?.contractAddress === kAddr);
const startIso = `${startLocal}:00+00:00`;
const endIso = new Date((t0 + 3 * 3600) * 1000).toISOString();
const network = { chainId: 1337, chainName: "Local test chain", rpcUrl: config.rpcUrl, explorer: config.explorer, logChunk: 7,
  kleros: { ...H0.kleros, policyURI: POLICY } };
const expected = core.deployArgs(core.newEventConfig({ ...FORM, eventWhen: core.describeWhen(startIso, endIso, "UTC"), deposit: "0.01", eventStart: startIso,
  claimDeadline: new Date((t0 + 14 * DAY) * 1000).toISOString() }, network, me), me, genericTemplate);
const [kPieces, kSlots] = await kick.metaEvidenceTemplate();
check("created with the form's values: name, deposit, owner, start, 14 days to settle, Kleros, the generic policy and case description",
  (await kick.eventName()) === FORM.eventName && (await kick.depositAmount()) === E("0.01") && (await kick.owner()) === me &&
  Number(await kick.eventStart()) === t0 && Number(await kick.claimDeadline()) === t0 + 14 * DAY && (await kick.disputeResolver()) === proxy.target &&
  (await kick.arbitrator()) === liquid.target && (await kick.policyURI()) === POLICY && JSON.stringify([...kPieces]) === JSON.stringify(expected[5][2]) && kSlots === expected[5][3]);
const [caseText] = await kick.caseMetaEvidence(A.ana);
const caseJson = JSON.parse(caseText);
check("each case names the event, the guest's wallet, the organiser and the policy",
  caseJson.title.includes(A.ana) && caseJson.description.includes(FORM.eventTitle) && caseJson.description.includes(FORM.eventWhere) &&
  caseJson.description.includes(me) && caseJson.fileURI === POLICY && /Wednesday|Thursday|Friday|Saturday|Sunday|Monday|Tuesday/.test(caseJson.title), caseJson.title);
const links = await page.$$eval("#neDone input", (els) => els.map((e) => e.value));
check("admin link and guest link with the contract and its block, ready to copy",
  /Admin link/.test(await txt("neDone")) && /Guest page link/.test(await txt("neDone")) &&
  JSON.stringify(links) === JSON.stringify([`${ADMIN}?contract=${kAddr}&from=${kBlock}`, `http://localhost:${WEB}/event/?contract=${kAddr}&from=${kBlock}`]), links.join(" | "));
const doneText = await txt("neDone");
check("then how to set up the registration page so this page's Luma checks can read it",
  /Now set up the registration page \(Luma\) like this, before guests register/.test(doneText) && /Every registration needs your approval/.test(doneText) &&
  doneText.includes('has "deposit", "commit" or "stake" in its name') && /The ETH address question is turned on/.test(doneText) &&
  doneText.includes('named like "Deposit tx link (etherscan.io)"') && /checked_in_at/.test(doneText), doneText);
check("the new contract's code is the one baked into the page", core.codeFingerprint(await prov.getCode(kAddr), H0.runtime.immutables) === H0.runtime.sha256);
check("the event is open: status, title, link in the address bar",
  /Event\s*Admin E2E Night/.test(await txt("status")) && (await txt("status")).includes(`${me} (you)`) && (await page.title()) === "Kickback · Admin panel · Admin E2E Night" &&
  page.url() === `${ADMIN}?contract=${kAddr}&from=${kBlock}` && /Event: Admin E2E Night/.test(await txt("eventTitle")), await txt("status"));
check("Kleros check passes for Kleros's Dispute Resolver", await page.isHidden("#kwarn") && /Kleros Court, through Kleros's Dispute Resolver/.test(await txt("status")));
const stored = await page.evaluate(() => localStorage.getItem("kickback.deploys.hosted.1337") ?? "");
check("the new event is remembered in this browser", stored.includes(kAddr) && (await txt("myEvents")).includes(`Admin E2E Night · ${kAddr}`), stored);
answers.push("no");
n0 = await nonce();
check("another event asks first (type NEW)", await click("createEvent", /Not created: no new contract/) && (await nonce()) === n0, await logText());
check("the question lists the event already created", /Type NEW to create another contract/.test(lastDialog()) && lastDialog().includes(kAddr) && lastDialog().includes('"Admin E2E Night"'), lastDialog());

// ---------------------------------------------------------------- deposits: register, refund
check("no deposits yet", await click("loadDeposits", /0 deposit\(s\) read/) && (await txt("depInfo")) === "No deposits yet.", await txt("depInfo"));
const pay = async (who, eth) => (await (await W[who].sendTransaction({ to: kAddr, value: E(eth) })).wait()).hash;
const tx = {};
for (const g of ["ana", "ben", "cai"]) tx[g] = await pay(g, "0.01");
tx.dan = await pay("dan", "0.005"); // too little
check("load deposits", await click("loadDeposits", /4 deposit\(s\) read/), await logText());
let r = await rows();
const ok3 = ["ana", "ben", "cai"].every((g) => { const x = r.find((y) => y.wallet === A[g].toLowerCase()); return x?.reg && x.ref && !x.regOn && !x.refOn && /received, not registered/.test(x.text); });
const danRow = r.find((y) => y.wallet === A.dan.toLowerCase());
check("deposits table: full deposits can be registered or refunded, a short one neither", r.length === 4 && ok3 && danRow && !danRow.reg && !danRow.ref && /AMOUNT_TOO_LOW/.test(danRow.text), JSON.stringify(r));
check("nothing ticked: nothing to register", await click("registerSel", /Tick Register for the guests first/), await logText());
await tick(A.ana, "register"); await tick(A.ben, "register");
await tick(A.cai, "refund");
check("register and refund are exclusive per row", (await rowOf(A.cai)).refOn && !(await rowOf(A.cai)).regOn);
n0 = await nonce();
check("register selected", await click("registerSel", /Registered 2 stakers/), await logText());
check("register confirmation names the guests", /Register 2 approved guests/.test(dialogs.find((d) => /Register 2 approved/.test(d)) ?? "") && (dialogs.find((d) => /Register 2 approved/.test(d)) ?? "").includes(A.ana.slice(0, 6)));
check("Ana and Ben registered on-chain, in one transaction", Number(await kick.status(A.ana)) === 1 && Number(await kick.status(A.ben)) === 1 && (await nonce()) === n0 + 1);
const anaAfter = await rowOf(A.ana), caiAfter = await rowOf(A.cai);
check("the table was reloaded: registered, and the other ticks kept", /\bregistered\b/.test(anaAfter.text) && !/not registered/.test(anaAfter.text) && !anaAfter.reg && !anaAfter.regOn && caiAfter.refOn, JSON.stringify([anaAfter, caiAfter]));
let caiBal = await bal(A.cai);
check("refund selected", await click("refundSel", /Refunded 1 declined guests/), await logText());
check("Cai got exactly the deposit back", (await bal(A.cai)) - caiBal === E("0.01") && Number(await kick.status(A.cai)) === 3);
// a ticked list goes out of date when money is returned after the table was loaded
await tick(A.ben, "refund");
await (await kick.refund(A.dan, E("0.005"))).wait(); // "Return a stray transfer", from elsewhere
n0 = await nonce();
check("a ticked list made out of date by a return is refused", await click("refundSel", /The ticked list is out of date: the contract registered, refunded or returned money since it was made\. Press "Load deposits"/) && (await nonce()) === n0, await logText());
check("Ben is still registered", Number(await kick.status(A.ben)) === 1);

// ---------------------------------------------------------------- the Luma guest list
for (const g of ["eve", "fay", "gus"]) tx[g] = await pay(g, "0.01");
// Ivy sends 25 USDC instead of ETH and pastes that transaction
const usdc = await dep("TestToken");
await (await usdc.mint(A.stranger, 25_000_000n)).wait();
tx.stranger = (await (await usdc.connect(W.stranger).transfer(kAddr, 25_000_000n)).wait()).hash;
const HEAD = "name,email,ticket_name,approval_status,checked_in_at,eth_address,Deposit tx link (Committed Spot only)";
const TICKET = "Committed Spot (0.01 ETH)";
const lumaCsv = (checked = {}) => [HEAD,
  ...[["Ana", "ana", "approved"], ["Ben", "ben", "approved"], ["Cai", "cai", "declined"], ["Dan", "dan", "approved"], ["Eve", "eve", "approved"], ["Fay", "fay", "declined"], ["Gus", "gus", "pending_approval"], ["Ivy", "stranger", "approved"]]
    .map(([n, g, s]) => `${n},${g}@x.io,${TICKET},${s},${checked[n] ?? ""},${A[g]},https://etherscan.io/tx/${tx[g]}`),
  `Hal,hal@x.io,Request to Join (Free),approved,${checked.Hal ?? ""},,`,
].join("\r\n") + "\r\n";
await page.setInputFiles("#lumaFile", csvFile("luma-guests.csv", lumaCsv()));
check("check the Luma list", await click("checkLuma", /Luma list checked: 1 ticked to register, 1 ticked to refund, 1 waiting for your decision/), await logText());
const eveRow = await rowOf(A.eve), fayRow = await rowOf(A.fay), gusRow = await rowOf(A.gus), anaRow = await rowOf(A.ana);
check("approved payer ticked to register, declined payer ticked to refund, waiting payer not ticked",
  eveRow?.regOn && !eveRow.refOn && fayRow?.refOn && !fayRow.regOn && gusRow && !gusRow.regOn && !gusRow.refOn && !anaRow.regOn && !anaRow.refOn, JSON.stringify([eveRow, fayRow, gusRow]));
check("the table names the guests from the Luma list", /Eve/.test(eveRow.text) && /Fay/.test(fayRow.text) && /Ana/.test(anaRow.text));
const luma = await txt("lumaResult");
check("Luma result: who is waiting, what needs a look, files to save",
  /Waiting for your decision on Luma: 1/.test(luma) && /Gus/.test(luma) && /Needs a look/.test(luma) && /Dan/.test(luma) &&
  ["verified.csv", "to-review.csv", "issues.csv", "returns.csv", "unmatched.csv"].every((f) => luma.includes(f)), luma);
check("a token sent instead of ETH is named, with what to do on this page", /NO_DEPOSIT_TRANSFER/.test(luma) && luma.includes(usdc.target) && /Return tokens sent by mistake' on this page/.test(luma), luma);
check("the Luma file never left the browser", !bodies.some((x) => /gus@x\.io|eve@x\.io|luma-guests/.test(x)));
await noClaude("Luma list checked");
check("register selected (Eve)", await click("registerSel", /Registered 1 stakers/), await logText());
check("the confirmation names Eve", /• Eve 0x/.test(dialogs.find((d) => /Register 1 approved/.test(d)) ?? ""));
let fayBal = await bal(A.fay);
check("refund selected (Fay)", await click("refundSel", /Refunded 1 declined guests/), await logText());
check("Eve registered, Fay refunded", Number(await kick.status(A.eve)) === 1 && Number(await kick.status(A.fay)) === 3 && (await bal(A.fay)) - fayBal === E("0.01"));

// ---------------------------------------------------------------- lists made by the scripts
await page.setInputFiles("#stakersFile", jsonFile("new-stakers.json", { contract: liquid.target, chainId: 1337, deposit: E("0.01").toString(), items: [{ wallet: A.gus, name: "Gus", status: 0 }] }));
n0 = await nonce();
check("a list for another contract is refused", await click("registerFile", /new-stakers\.json was made for another contract or network\. Run the scripts' check again/) && (await nonce()) === n0, await logText());
const gusList = (block) => ({ contract: kAddr, chainId: 1337, deposit: E("0.01").toString(), block, items: [{ wallet: A.gus, name: "Gus", status: 0 }] });
await page.setInputFiles("#refundsFile", jsonFile("refunds.json", gusList(kBlock)));
check("an out-of-date list is refused", await click("refundFile", /refunds\.json is out of date: the contract registered, refunded or returned money since it was made/) && (await nonce()) === n0, await logText());
await page.setInputFiles("#refundsFile", jsonFile("refunds.json", gusList(await prov.getBlockNumber())));
let gusBal = await bal(A.gus);
check("refunds.json from the scripts", await click("refundFile", /Refunded 1 declined guests/) && (await bal(A.gus)) - gusBal === E("0.01") && Number(await kick.status(A.gus)) === 3, await logText());

// Cai, refunded earlier, pays again and is approved: the contract accepts a refunded wallet, so the table registers them
const rowTx = (h) => page.evaluate((h) => {
  const tr = document.querySelector(`#depTable tr[data-tx="${h}"]`);
  if (!tr) return null;
  const r = tr.querySelector("input.register"), f = tr.querySelector("input.refund");
  return { text: tr.innerText, reg: !r.disabled, regOn: r.checked, ref: !f.disabled, refOn: f.checked };
}, h);
// the wallets in the deposits table's "To give back" list
const giveBack = () => page.evaluate(() => {
  const h = [...document.querySelectorAll("#depTable h3")].find((x) => /To give back/.test(x.textContent));
  return h?.nextElementSibling ? [...h.nextElementSibling.querySelectorAll("a")].map((a) => a.title.toLowerCase()) : [];
});
tx.cai2 = await pay("cai", "0.01");
await clearLog();
check("load deposits (Cai paid again)", await click("loadDeposits", /8 deposit\(s\) read/), await logText());
const cai2 = await rowTx(tx.cai2);
check("a refunded guest who paid again: Register can be ticked, Refund can't", cai2 && /refunded, then paid again/.test(cai2.text) && cai2.reg && !cai2.ref, JSON.stringify(cai2));
await page.setInputFiles("#lumaFile", csvFile("luma-cai.csv", [HEAD, `Cai,cai@x.io,${TICKET},approved,,${A.cai},https://etherscan.io/tx/${tx.cai2}`].join("\r\n") + "\r\n"));
check("approved on Luma: ticked to register", await click("checkLuma", /Luma list checked: 1 ticked to register, 0 ticked to refund/) && (await rowTx(tx.cai2))?.regOn, await logText());
await clearLog();
check("register selected (Cai, paid again)", await click("registerSel", /Registered 1 stakers/) && Number(await kick.status(A.cai)) === 1, await logText());
// and removed again ("Remove and refund"), so the rest of this test has the same stakers
await page.evaluate(() => document.querySelectorAll("details").forEach((d) => (d.open = true)));
await page.fill("#rmAddr", A.cai);
caiBal = await bal(A.cai);
check("remove and refund one registered guest", await click("removeOne", new RegExp(`Refunded ${A.cai}`)) && Number(await kick.status(A.cai)) === 3 && (await bal(A.cai)) - caiBal === E("0.01"), await logText());

// ---------------------------------------------------------------- another wallet, links
current = W.stranger;
await open(`?contract=${kAddr}&from=${kBlock}`);
check("the admin link opens the event, without a wallet", /Event\s*Admin E2E Night/.test(await txt("status")) && (await page.inputValue("#fromBlock")) === String(kBlock) && !(await page.isDisabled("#loadDeposits")), await txt("status"));
await connect();
check("another wallet is told it is not the owner", await waitLog(/The connected wallet is not the owner of this contract/), await logText());
const ownerOnly = ["registerSel", "refundSel", "registerFile", "refundFile", "postList", "removeOne", "refundOne", "returnTokens", "sweep", "cancel"];
const disabled = await Promise.all(ownerOnly.map((id) => page.isDisabled("#" + id)));
check("owner buttons disabled for another wallet", disabled.every(Boolean), ownerOnly.filter((_, i) => !disabled[i]).join(","));
check("anyone can still read the deposits and create their own event", !(await page.isDisabled("#loadDeposits")) && !(await page.isDisabled("#checkLuma")) && !(await page.isDisabled("#createEvent")));
current = owner;
await clearLog();
await open(`?contract=${kAddr}`);
check("without a deploy block, the page finds it", (await page.inputValue("#fromBlock")) === String(kBlock) && /Looking for the block the contract was created in/.test(await logText()) && page.url().endsWith(`?contract=${kAddr}&from=${kBlock}`), await logText());
// a network connection that can't read old states: the page asks for the block from Etherscan
noHistory = true;
await clearLog();
await open(`?contract=${kAddr}`);
check("deploy block not found: the page asks for Etherscan's Contract Creation block",
  await waitLog(/Could not find the block this contract was created in .+ find its "Contract Creation" transaction, type that transaction's block number in "Deploy block", and press Open again/) && (await txt("status")) === "", await logText());
noHistory = false;
await page.fill("#fromBlock", String(kBlock));
await page.click("#refresh"); await idle();
check("typed in, the event opens", /Event\s*Admin E2E Night/.test(await txt("status")) && page.url().endsWith(`?contract=${kAddr}&from=${kBlock}`), await txt("status"));
await clearLog();
await open(`?contract=${kAddr}&from=${kBlock + 3}`);
check("a deploy block after the creation is refused", await waitLog(/The contract already existed before block \d+, so deposits sent before that block would be missed/) && (await txt("status")) === "", await logText());

// a contract whose Dispute Resolver is not Kleros's
const t1 = (Math.floor(chainNow / 60) + 180) * 60;
const otherArgs = core.deployArgs(core.newEventConfig({ ...FORM, eventName: "Not Kleros", eventWhen: "soon", deposit: "0.01", eventStart: new Date(t1 * 1000).toISOString() },
  { ...network, kleros: { ...network.kleros, disputeResolver: otherProxy.target } }, me), me, genericTemplate);
const other = await (await new ethers.ContractFactory(abi, load("TruthPaysKickback").bytecode, owner).deploy(...otherArgs)).waitForDeployment();
const otherBlock = (await other.deploymentTransaction().wait()).blockNumber;
await open(`?contract=${other.target}&from=${otherBlock}`);
const kw = await txt("kwarn");
check("another Dispute Resolver is flagged in big letters", await page.isVisible("#kwarn") && /WARNING: this contract does not use Kleros/.test(kw) && kw.includes(otherProxy.target) && /Do not send ETH to it/.test(kw), kw);
check("and in the status", /not Kleros's own Dispute Resolver/.test(await txt("status")), await txt("status"));

// a copy of the kickback contract with other code (one comment more in its source): it answers every read alike, but
// its code is not the one the page knows (answers can be faked, the code can't)
const solc = req("solc");
const copyInput = JSON.parse(fs.readFileSync(path.join(proj, "build", "TruthPaysKickback.standard-input.json"), "utf8"));
copyInput.sources["TruthPaysKickback.sol"].content += "\n// a copy\n";
copyInput.settings.outputSelection = { "*": { TruthPaysKickback: ["evm.bytecode.object"] } };
const copyBytecode = "0x" + JSON.parse(solc.compile(JSON.stringify(copyInput))).contracts["TruthPaysKickback.sol"].TruthPaysKickback.evm.bytecode.object;
const argsAt = (eventName) => core.deployArgs(core.newEventConfig({ ...FORM, eventName, eventWhen: "soon", deposit: "0.01", eventStart: new Date(t1 * 1000).toISOString() }, network, me), me, genericTemplate);
const copy = await (await new ethers.ContractFactory(abi, copyBytecode, owner).deploy(...argsAt("Copied Night"))).waitForDeployment();
const copyBlock = (await copy.deploymentTransaction().wait()).blockNumber;
check("the copy answers like a kickback contract", (await copy.eventName()) === "Copied Night" && copyBytecode !== load("TruthPaysKickback").bytecode);
await clearLog();
await open(`?contract=${copy.target}&from=${copyBlock}`);
check("a contract with other code is refused, with what to do", await waitLog(new RegExp(`The contract at ${copy.target} answers like a kickback deposit contract, but its code is not the one this page knows, so this page can't run it\\. Don't send ETH to it`)) &&
  (await txt("status")) === "" && await page.isDisabled("#loadDeposits"), await logText());
// a juror policy that is not an IPFS path: shown as text, never as a link (gateway + "@host/…" is another website)
const oddArgs = argsAt("Odd Policy");
oddArgs[5] = [...oddArgs[5]];
oddArgs[5][4] = "@evil.example/attendance-policy";
const odd = await (await new ethers.ContractFactory(abi, load("TruthPaysKickback").bytecode, owner).deploy(...oddArgs)).waitForDeployment();
const oddBlock = (await odd.deploymentTransaction().wait()).blockNumber;
await open(`?contract=${odd.target}&from=${oddBlock}`);
const oddStatus = await txt("status");
check("a juror policy that is not an IPFS path is not linked, and is flagged",
  /Event\s*Odd Policy/.test(oddStatus) && oddStatus.includes("@evil.example/attendance-policy (not an IPFS path: jurors may not be able to open it)") &&
  (await page.locator('a[href*="evil.example"]').count()) === 0, oddStatus);

// ---------------------------------------------------------------- after the event: the attendance list, payouts
await open(`?contract=${kAddr}&from=${kBlock}`);
await connect();
check("Post attendance list is locked until the event starts", await page.isDisabled("#postList") && /locked until/.test(await page.innerText("#postList")), await page.innerText("#postList"));
// a payout-plan.json from the scripts: for another contract, or out of date (checked again when posting)
const planOf = (d) => jsonFile("payout-plan.json", { contract: kAddr, chainId: 1337, stakers: 3, attendees: [A.ana, A.eve], share: E("0.015").toString(), ...d });
await page.setInputFiles("#planFile", planOf({ contract: liquid.target }));
check("a payout-plan.json for another contract is refused", await waitLog(/payout-plan\.json was made for another contract or network/), await logText());
await idle();
// an export without a deposit tx link column: said in plain words, with what to do instead
await page.setInputFiles("#checkinFile", csvFile("no-link.csv", `name,email,ticket_name,approval_status,checked_in_at,eth_address\r\nAna,ana@x.io,${TICKET},approved,2026-11-04T18:30:00.000Z,${A.ana}\r\n`));
await clearLog();
check("a check-in export without a deposit tx link column is explained",
  await click("buildPlan", /no-link\.csv has no deposit tx link column, so its check-ins can't be matched to the stakers' wallets\. Use the export of a registration page that asked for the deposit link/) &&
  /or build the list from a door list alone/.test(await logText()) && !/config\.columns/.test(await logText()), await logText());
// a door list alone (wallets): only the stakers it doesn't name are asked about
await page.setInputFiles("#checkinFile", []);
await page.setInputFiles("#doorFile", csvFile("door.csv", `name,wallet\r\nAna,${A.ana}\r\nEve,${A.eve}\r\n`));
const nDialogs = dialogs.length;
check("a door list alone builds the attendance list", await click("buildPlan", /Attendance list built: 2 of 3 stakers checked in, 0\.015 ETH each/), await logText());
const noShowAsk = dialogs.slice(nDialogs).join("\n");
check("it asks about the staker the door list doesn't name, and only them",
  /1 registered stakers are not on the door list/.test(noShowAsk) && noShowAsk.includes(A.ben) && !noShowAsk.includes(A.ana) && !noShowAsk.includes(A.eve) && /Type NOSHOW/.test(noShowAsk), noShowAsk);
check("the summary names the door list", (await txt("planResult")).includes("door.csv"), await txt("planResult"));
await page.setInputFiles("#doorFile", []);
await clearLog();
const after = lumaCsv({ Ana: "2026-11-04T18:30:00.000Z", Eve: "2026-11-04T18:45:00.000Z", Hal: "2026-11-04T19:00:00.000Z" });
await page.setInputFiles("#checkinFile", csvFile("luma-after.csv", after));
check("build the attendance list", await click("buildPlan", /Attendance list built: 2 of 3 stakers checked in, 0\.015 ETH each/), await logText());
const plan = await txt("planResult");
check("summary: stakers, who came, no-shows, the share; files to save",
  /Stakers\s*3/.test(plan) && /Showed up\s*2/.test(plan) && /No-shows\s*1/.test(plan) && /Ben/.test(plan) && /0\.015 ETH/.test(plan) &&
  ["payout-plan.json", "payout-summary.md", "payout.csv"].every((f) => plan.includes(f)), plan);
check("the check-in file never left the browser", !bodies.some((x) => /luma-after|ana@x\.io/.test(x)));
n0 = await nonce();
await skew(t0 - (await prov.getBlock("latest")).timestamp + 60); // the event has started
await page.click("#refresh"); await idle();
check("unlocked once the event started", !(await page.isDisabled("#postList")), await page.innerText("#postList"));
// Lou pays late and is declined on Luma (ticked to refund); the deposit is then given back with "Return a stray
// transfer" from elsewhere. The ticked list is out of date, and after "Load deposits" the Luma tick is gone: the
// contract no longer holds that deposit, so a refund would be paid with someone else's.
const lou = new ethers.Wallet("0x" + (99).toString(16).padStart(64, "0"), prov);
await (await W.gus.sendTransaction({ to: lou.address, value: E("0.1") })).wait();
tx.lou = (await (await lou.sendTransaction({ to: kAddr, value: E("0.01") })).wait()).hash;
await clearLog();
check("load deposits (a late payment)", await click("loadDeposits", /9 deposit\(s\) read/), await logText());
const louCsv = ["name,email,ticket_name,approval_status,checked_in_at,eth_address,Deposit tx link (etherscan.io)",
  `Lou,lou@x.io,Kickback spot (0.01 ETH),declined,,${lou.address},https://etherscan.io/tx/${tx.lou}`].join("\r\n") + "\r\n";
await page.setInputFiles("#lumaFile", csvFile("lou.csv", louCsv));
check("declined late payer ticked to refund", await click("checkLuma", /Luma list checked: 0 ticked to register, 1 ticked to refund/) && (await rowTx(tx.lou))?.refOn, await logText());
check("a ticket name without \"deposit\", \"commit\" or \"stake\" is warned about",
  /No ticket name in lou\.csv contains "deposit", "commit" or "stake", so a guest who chose the paid ticket but never pasted a deposit link is not listed anywhere/.test(await logText()), await logText());
check("ticked to refund, so not also listed to give back", !(await giveBack()).includes(lou.address.toLowerCase()), (await giveBack()).join(","));
await (await kick.refund(lou.address, E("0.01"))).wait(); // "Return a stray transfer", from elsewhere
const louBal = await bal(lou.address);
n0 = await nonce();
check("the ticked list made before that return is refused",
  await click("refundSel", /The ticked list is out of date: the contract registered, refunded or returned money since it was made\. Press "Load deposits" again \(and "Check the Luma list" again if you used it\)/) && (await nonce()) === n0, await logText());
await clearLog();
check("load deposits again", await click("loadDeposits", /9 deposit\(s\) read/), await logText());
const louRow = await rowTx(tx.lou);
check("the Luma tick did not survive: the deposit is no longer held, Refund can't be ticked", louRow && !louRow.ref && !louRow.refOn && /received, not registered/.test(louRow.text), JSON.stringify(louRow));
check("nothing to refund: no transaction, Lou neither refunded nor paid twice",
  await click("refundSel", /Tick Refund for the guests first/) && (await nonce()) === n0 && Number(await kick.status(lou.address)) === 0 && (await bal(lou.address)) === louBal, await logText());
await page.setInputFiles("#planFile", planOf({ stakers: 2 }));
check("a payout-plan.json file can be loaded", await waitLog(/Loaded payout-plan\.json: 2 attendee\(s\)/), await logText());
await idle();
check("an out-of-date payout-plan.json is refused when posting", await click("postList", /The plan counts 2 stakers but the contract has 3\. Run the scripts' check again and load the new file/) && (await nonce()) === n0, await logText());
await page.setInputFiles("#checkinFile", csvFile("luma-after.csv", after));
check("build the attendance list again", await click("buildPlan", /Attendance list built: 2 of 3 stakers checked in/), await logText());
answers.push("no");
check("posting needs POST typed", await click("postList", /Attendance list not posted/) && (await nonce()) === n0 && /Type POST to continue/.test(lastDialog()), await logText());
check("post attendance list", await click("postList", /Attendance list posted\. The 1-day challenge window is open/), await logText());
check("on-chain: Ana and Eve on the list", Number(await kick.phase()) === 1 && (await kick.attendeeCount()) === 2n && (await kick.attended(A.ana)) && (await kick.attended(A.eve)) && !(await kick.attended(A.ben)));
// Ben, left off, challenges; the organiser disputes it from this page: Kleros Court gets the case, its own
// description saved on IPFS first (the Kleros settings baked into the page)
await (await kick.connect(W.ben).challenge({ value: await kick.challengeDeposit() })).wait();
await page.click("#refresh"); await idle();
check("the challenge shows in the list", /waiting for a match/.test(await txt("challenges")), await txt("challenges"));
await page.fill("#chAddr", A.ben);
check("dispute Ben's challenge (sent to Kleros)", await click("matchOne", /Sent to Kleros: case #\d+/), await logText());
const desc = uploads.find((u) => u.file === "metaevidence.json");
check("its case description was saved on IPFS first: Ben's wallet and the event",
  !!desc && desc.operation === "file" && desc.content.includes(A.ben) && desc.content.includes(FORM.eventTitle) && desc.path === (await kick.caseMetaEvidence(A.ben))[1], JSON.stringify(desc?.path));
check("on-chain: matched by the organiser, a Kleros case is open", Number((await kick.challenges(A.ben)).state) === 2 && (await kick.challenges(A.ben)).matcher === me);
await skew(DAY + 120);
await page.click("#refresh"); await idle();
const before = await Promise.all(["ana", "ben", "eve"].map((g) => bal(A[g])));
check("release payouts", await click("release", /Paid out/), await logText());
const afterBal = await Promise.all(["ana", "ben", "eve"].map((g) => bal(A[g])));
const held = await kick.heldBack();
check("Ana and Eve paid the same share, Ben's share set aside for the Kleros case, Ben paid nothing",
  afterBal[0] - before[0] === E("0.01") && afterBal[2] - before[2] === E("0.01") && held === E("0.01") && afterBal[1] === before[1],
  afterBal.map((x, i) => ethers.formatEther(x - before[i])).join(",") + " held " + ethers.formatEther(held));
await noClaude("paid out");

// on a phone the page fits the screen's width (wide tables scroll inside their own box)
await clearLog();
check("load deposits after the payout", await click("loadDeposits", /9 deposit\(s\) read/), await logText());
check("paid out shows in the table", /paid out/.test((await rowOf(A.ana)).text) && !(await rowOf(A.ana)).ref && !(await rowOf(A.ana)).reg, (await rowOf(A.ana))?.text);
await page.setViewportSize({ width: 375, height: 800 });
await page.waitForTimeout(300);
const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
const wide = await page.evaluate(() => [...document.querySelectorAll("main *")]
  .filter((e) => e.offsetParent !== null && !e.closest(".scroll") && e.getBoundingClientRect().right > document.documentElement.clientWidth + 1)
  .slice(0, 5).map((e) => `${e.tagName}#${e.id}.${e.className}: ${e.textContent.slice(0, 50)}`).join(" | "));
check("fits a phone's width: no sideways scrolling of the page", overflow <= 0, `${overflow}px too wide: ${wide}`);

// the event's timezone on a computer elsewhere: its offset on the event's date (summer time included) is preselected,
// until the organiser picks one by hand
const localOnly = (p) => p.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if ((u.hostname === "localhost" && u.port === String(WEB)) || (u.hostname === "127.0.0.1" && u.port === String(RPC))) return route.continue();
  outside.push(u.href);
  return route.abort();
});
const zoneOf = (p) => p.evaluate(() => { const s = document.getElementById("neTz"); return { value: s.value, label: s.selectedOptions[0]?.textContent ?? "" }; });
const berlin = await browser.newContext({ timezoneId: "Europe/Berlin" });
const bp = await berlin.newPage();
bp.on("pageerror", (e) => errs.push(e.message));
await localOnly(bp);
await bp.goto(ADMIN);
await bp.waitForFunction(() => document.getElementById("neTz").options.length > 1);
await bp.fill("#neStart", "2027-07-15T19:00");
let z = await zoneOf(bp);
check("Berlin in July: UTC+02:00 preselected, named as this computer's on that date", z.value === "+02:00" && z.label === "UTC+02:00 (this computer, on that date)", JSON.stringify(z));
await bp.fill("#neStart", "2027-12-10T19:00");
z = await zoneOf(bp);
check("Berlin in December: UTC+01:00", z.value === "+01:00" && z.label === "UTC+01:00 (this computer, on that date)", JSON.stringify(z));
await bp.selectOption("#neTz", "+05:30");
await bp.fill("#neStart", "2027-07-15T19:00");
z = await zoneOf(bp);
check("an offset picked by hand is kept when the date changes", z.value === "+05:30", JSON.stringify(z));
await berlin.close();
const stJohns = await browser.newContext({ timezoneId: "America/St_Johns" });
const sp = await stJohns.newPage();
await localOnly(sp);
await sp.goto(ADMIN);
await sp.waitForFunction(() => document.getElementById("neTz").options.length > 1);
await sp.fill("#neStart", "2027-07-15T19:00");
z = await zoneOf(sp);
check("Newfoundland in July: UTC-02:30 is in the list and preselected", z.value === "-02:30", JSON.stringify(z));
await stJohns.close();

// the page's code did not load (here: core.mjs missing on the host): the page says so, instead of buttons that do nothing
const dead = await browser.newPage();
await dead.route("**/*", (route) => {
  const u = new URL(route.request().url());
  if (u.hostname === "localhost" && u.port === String(WEB)) return u.pathname.endsWith("/core.mjs") ? route.fulfill({ status: 404, body: "not found" }) : route.continue();
  if (u.hostname === "127.0.0.1" && u.port === String(RPC)) return route.continue();
  outside.push(u.href);
  return route.abort();
});
await dead.goto(ADMIN);
await dead.waitForFunction(() => window.__pageFailed === true, null, { timeout: 15000 }).catch(() => {});
const deadBanner = await dead.locator("#banner").innerText(), deadLog = await dead.locator("#log").innerText();
check("code that did not load: the banner and the log say so, and what to do",
  /This page's code did not load, so its buttons do nothing\. Reload the page/.test(deadBanner) && /This page's code did not load/.test(deadLog) && !/claude|console/i.test(deadBanner + deadLog),
  deadBanner + " | " + deadLog);
await dead.close();

// ---------------------------------------------------------------- everywhere
check("no dialog or log line mentions Claude or the console", !dialogs.some((d) => /claude|console/i.test(d)) && !/claude|console/i.test(await logText()),
  dialogs.find((d) => /claude|console/i.test(d)) ?? (await logText()).match(/.{0,80}(claude|console).{0,40}/i)?.[0]);
check("every transaction: signed in the wallet with the chainId, the sender's own account, gas at most 2^24",
  sent.length > 0 && sent.every((t) => t.chainId === "0x539" && BigInt(t.gas) <= 16_777_216n && t.from.toLowerCase() === me.toLowerCase()), sent.map((t) => `${t.chainId}/${t.gas}/${t.from}`).join(","));
check("nothing was fetched from outside this computer but Kleros's (simulated) services", outside.length === 0, outside.join(", "));
check("the host only served the panel's own files", served.every((p) => p.startsWith("/admin/") || p === "/favicon.ico") && !served.some((p) => /settings\.json|config\.json|\/out\//.test(p)), [...new Set(served)].join(", "));
check("no page errors", errs.length === 0, errs.join("; "));

await browser.close(); web.close(); await server.close();
fs.rmSync(tmp, { recursive: true, force: true });
const fails = results.filter((x) => !x).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
