// Browser test of the generic guest page (node scripts/build-site.mjs --generic, published at /event/): a page for any
// kickback deposit contract, named by the organiser's link (?contract=0x…&from=<block>), against ganache with a fake
// injected wallet. The events are created as the admin panel creates them: the core's new-event form and constructor
// arguments, with the generic case description template and juror policy. Also checks that the Truth Pays build (the
// contract baked in) still ignores the link. Kleros's IPFS upload service and gateway are mocked, never reached.
// Needs Playwright with Chromium (see test/site.e2e.mjs).
//   node test/site-generic.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import * as core from "../scripts/core.mjs";
const proj = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const req = createRequire(path.join(proj, "package.json"));
const ganache = req("ganache");
const { ethers } = req("ethers");
let chromium;
try { ({ chromium } = req("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/node_modules/")("playwright")); }
const E = (x) => ethers.parseEther(String(x));
const read = (f) => fs.readFileSync(path.join(proj, f), "utf8");
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const keys = Array.from({ length: 10 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const RPC = 18657, WEB = 18898;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const rpcUrl = `http://127.0.0.1:${RPC}`;
const prov = new ethers.JsonRpcProvider(rpcUrl, 1337, { staticNetwork: true, cacheTimeout: -1 });
const estimate = prov.estimateGas.bind(prov);
prov.estimateGas = async (tx) => ((await estimate(tx)) * 12n) / 10n; // real wallets add a margin to the estimate
// org: the organiser who created the events from the admin panel; g1..g3: guests
const [owner, org, g1, g2, g3] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const addr = async (w) => (typeof w === "string" ? w : w.target ?? w.getAddress());
const [orga, g1a, g2a, g3a] = [await addr(org), await addr(g1), await addr(g2), await addr(g3)];
const deployC = async (by, name, ...a) => (await new ethers.ContractFactory(load(name).abi, load(name).bytecode, by).deploy(...a)).waitForDeployment();
const liquid = await deployC(owner, "MockKlerosLiquid");
const proxy = await deployC(owner, "MockArbitrableProxy", liquid.target);
const otherProxy = await deployC(owner, "MockArbitrableProxy", liquid.target);
// a few empty blocks, so that the contracts below aren't near block 0
for (let i = 0; i < 20; i++) await prov.send("evm_mine", []);

// New events as the admin panel creates them: the form, then the core's constructor arguments with the generic case
// description template and the generic juror policy
const TEMPLATE = read(core.GENERIC_METAEVIDENCE_TEMPLATE), POLICY = core.ipfsPathOf(read(core.GENERIC_POLICY));
const now = (await prov.getBlock("latest")).timestamp;
const FORM = {
  eventTitle: "Builders Brunch: Oracles & Courts", eventName: "Builders Brunch, Lisbon", eventWhen: "Saturday 7 November 2026, 11:00-14:00 WET",
  eventWhere: "Café Exemplo, Rua Augusta 1, Lisbon", hosts: "Kleros and friends", eventLink: "https://luma.com/builders-brunch",
  deposit: "0.02", eventStart: new Date((now + 86400) * 1000).toISOString(),
};
const network = (resolver) => ({ chainId: 1337, rpcUrl, explorer: "https://etherscan.io", logChunk: 7, kleros: { disputeResolver: resolver.target, arbitrator: liquid.target, policyURI: POLICY } });
async function createEvent(form = {}, resolver = proxy) {
  const cfg = core.newEventConfig({ ...FORM, ...form }, network(resolver), orga);
  const c = await deployC(org, "TruthPaysKickback", ...core.deployArgs(cfg, orga, TEMPLATE));
  return { c, block: (await c.deploymentTransaction().wait()).blockNumber };
}
const ev = await createEvent();
for (let i = 0; i < 5; i++) await prov.send("evm_mine", []);
const wrong = await createEvent({ eventName: "Elsewhere Night" }, otherProxy);
const tricky = await createEvent({ eventName: '<img src=x onerror="window.__xss=1">Night \u202Eevil & "co"' });
const longName = await createEvent({ eventName: "A very long event name that goes on and on, Lisbon Builders Week 2026, day two" });
const baked = await createEvent({ eventName: "Baked Event", deposit: "0.01" });
const evName = FORM.eventName, D = E("0.02");

// the pages: /event/ (generic) and /live/ (built for one contract, `baked`, like the Truth Pays page)
const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-generic-"));
const configFile = (name, extra = {}) => {
  const f = path.join(outDir, `${name}.json`);
  fs.writeFileSync(f, JSON.stringify({ eventName: "E2E", chain: "local", chainId: 1337, rpcUrl, logChunk: 7, explorer: "https://etherscan.io", deposit: "0.01", receiver: baked.c.target, contract: baked.c.target,
    eventStart: new Date((now + 86400) * 1000).toISOString(), claimDeadline: new Date((now + 86400 * 15) * 1000).toISOString(), owner: orga, deployBlock: baked.block,
    kleros: { disputeResolver: proxy.target, arbitrator: liquid.target, policyURI: POLICY }, ...extra }));
  return f;
};
const build = (cfg, out, ...flags) => execFileSync("node", ["scripts/build-site.mjs", "--config", cfg, "--out", path.join(outDir, out), ...flags], { cwd: proj, stdio: "pipe" }).toString();
build(configFile("generic"), "event", "--generic");
build(configFile("live"), "live");
http.createServer((rq, rs) => {
  const m = new URL(rq.url, "http://x").pathname.match(/^\/(event|live)\/$/);
  if (!m) { rs.writeHead(404); return rs.end(); }
  rs.writeHead(200, { "content-type": "text/html" }); rs.end(fs.readFileSync(path.join(outDir, m[1], "index.html")));
}).listen(WEB);

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };

// 1. the build
const genHtml = fs.readFileSync(path.join(outDir, "event", "index.html"), "utf8");
const cfgOf = (html) => JSON.parse(html.slice(html.indexOf("const CONFIG = ") + 15, html.indexOf(";\n/*END CONFIG*/")));
const genCfg = cfgOf(genHtml);
check("generic build: no contract, block or deposit baked in, Kleros addresses from the config, no Luma link",
  genCfg.generic === true && genCfg.contract === "" && genCfg.deployBlock === 0 && genCfg.depositWei === "0" && genCfg.klerosPolicy === "" && !("lumaUrl" in genCfg)
  && genCfg.klerosResolver === proxy.target && genCfg.klerosArbitrator === liquid.target && genCfg.logChunk === 7 && !/luma\.com|qewnqhas/.test(genHtml), JSON.stringify(genCfg));
check("generic build: no baked/generic markers left, the generic markup only", !/<!--(baked|generic:)/.test(genHtml) && genHtml.includes('<h1 id="ev-name">') && !genHtml.includes("Hitchki") && !genHtml.includes('id="luma-link"'));
const liveHtml = fs.readFileSync(path.join(outDir, "live", "index.html"), "utf8");
check("baked build: the Truth Pays markup only, the contract baked in, no generic flag", !/<!--(baked|generic:)/.test(liveHtml) && liveHtml.includes("Hitchki, BKC, Mumbai") && liveHtml.includes('id="luma-link"') && !liveHtml.includes('id="ev-name"')
  && cfgOf(liveHtml).contract === baked.c.target && !("generic" in cfgOf(liveHtml)));
// the page calls the contract by function selector: each one is the selector of the function it names in the ABI
const selBlock = genHtml.slice(genHtml.indexOf("const SEL = {"), genHtml.indexOf("};", genHtml.indexOf("const SEL = {")));
const sels = [...selBlock.matchAll(/(\w+): "(0x[0-9a-f]{8})"/g)].map((m) => [m[1], m[2]]);
const iface = new ethers.Interface(load("TruthPaysKickback").abi);
const wrongSels = sels.filter(([name, sel]) => iface.getFunction(name)?.selector !== sel);
check("every contract selector on the page matches the contract's ABI (the generic page's reads included)", sels.length >= 28 && wrongSels.length === 0
  && ["eventName", "owner", "policyURI", "metaEvidenceTemplate"].every((n) => sels.some(([name]) => name === n)), JSON.stringify(wrongSels));
const buildFails = (cfg, ...flags) => { try { build(cfg, "x", ...flags); return ""; } catch (e) { return String(e.stderr); } };
check("generic build refuses --preview", /leave out --preview/.test(buildFails(configFile("generic"), "--generic", "--preview")));
// on Ethereum mainnet the generic page only trusts Kleros's own Dispute Resolver
const mainnet = (kleros) => configFile("mainnet", { chain: "ethereum", chainId: 1, rpcUrl: "https://rpc.mevblocker.io", logChunk: 5000, contract: "", receiver: "0x0000000000000000000000000000000000000001", deployBlock: 0, kleros });
check("generic build for mainnet refuses another Dispute Resolver", /only works with Kleros's own Dispute Resolver \(0x4b89e798b10478a839ea0abcf86c4b94a3c782a4\), but the config names/.test(buildFails(mainnet({ disputeResolver: otherProxy.target }), "--generic")));
build(mainnet({ policyURI: POLICY }), "mainnet-event", "--generic");
const mainCfg = cfgOf(fs.readFileSync(path.join(outDir, "mainnet-event", "index.html"), "utf8"));
check("generic build for mainnet: Kleros's own Dispute Resolver and court, the public RPC, no contract", mainCfg.chainId === 1 && core.isKnownResolver(1, mainCfg.klerosResolver)
  && mainCfg.klerosArbitrator.toLowerCase() === core.KLEROS[1].arbitrator.toLowerCase() && mainCfg.rpc === "https://rpc.mevblocker.io" && mainCfg.contract === "" && mainCfg.klerosPolicy === "", JSON.stringify(mainCfg));

// 2. the browser. Kleros's IPFS upload service and gateway are mocked as in test/site.e2e.mjs: a case description
// ("metaevidence.json") is stored at the real CIDv0 of its bytes, and the gateway serves what was stored.
const browser = await chromium.launch();
const ipfs = { uploads: [], store: new Map() };
const CORS = { "access-control-allow-origin": "*" };
// opts: noArchive (the public RPC keeps no old state: eth_getCode for any block but "latest" fails, like a pruned node),
// timezoneId (the browser's time zone). page.calls lists every public RPC request ({ method, params }).
async function open(url, wallet, opts = {}) {
  const ctx = await browser.newContext(opts.timezoneId ? { timezoneId: opts.timezoneId } : {});
  const page = await ctx.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  const me = wallet ? await addr(wallet) : null;
  Object.assign(page, { sent: [], calls: [], errs });
  if (wallet) await page.exposeFunction("__rpc", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
    if (method === "eth_chainId") return "0x539";
    if (method === "eth_sendTransaction") {
      const t = params[0]; page.sent.push(t);
      if (t.chainId !== undefined && parseInt(t.chainId, 16) !== 1337) throw new Error("Invalid chainId for the current network");
      return (await wallet.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n, ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}) })).hash;
    }
    return prov.send(method, params ?? []);
  });
  await page.route((u) => u.port === String(RPC), async (route) => {
    let body = null;
    try { body = JSON.parse(route.request().postData() || "null"); } catch {}
    if (body) page.calls.push({ method: body.method, params: body.params });
    if (body && opts.noArchive && body.method === "eth_getCode" && body.params[1] !== "latest")
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error: { code: -32000, message: "missing trie node 5c3a… (path ) state is not available" } }) });
    return route.continue();
  });
  await page.route("https://kleros-api.netlify.app/**", async (route) => {
    const rq = route.request(), raw = rq.postDataBuffer() || Buffer.alloc(0), body = raw.toString("latin1");
    const file = (body.match(/filename="([^"]*)"/) || [])[1] || "";
    const boundary = ((rq.headers()["content-type"] || "").match(/boundary=(.+)$/) || [])[1];
    const from = body.indexOf("\r\n\r\n") + 4, to = boundary ? body.indexOf(`\r\n--${boundary}`, from) : -1;
    const data = to > from ? Buffer.from(body.slice(from, to), "latin1") : Buffer.alloc(0);
    const at = file === "metaevidence.json" ? `/ipfs/${core.ipfsCidV0(data)}` : `/ipfs/QmTestCid${String(ipfs.uploads.length).padStart(35, "Z")}/${file}`;
    ipfs.uploads.push({ file, operation: new URL(rq.url()).searchParams.get("operation"), data, path: at });
    ipfs.store.set(at, data);
    return route.fulfill({ status: 200, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify({ message: "File has been stored successfully", cids: [at] }) });
  });
  await page.route("https://cdn.kleros.link/**", (route) => {
    const data = ipfs.store.get(new URL(route.request().url()).pathname);
    return data ? route.fulfill({ status: 200, headers: { "content-type": "application/octet-stream", ...CORS }, body: data }) : route.fulfill({ status: 404, headers: CORS, body: "not found" });
  });
  if (wallet) await page.addInitScript(() => {
    const listeners = {};
    window.ethereum = { request: ({ method, params }) => window.__rpc(method, params), on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); }, removeListener() {} };
  });
  if (opts.clockAt) await page.clock.setFixedTime(new Date(opts.clockAt * 1000));
  await page.goto(`http://localhost:${WEB}${url}`);
  // the page has read the event (or refused it), and for a usable one the contract checks are shown
  for (let i = 0; i < 100; i++) {
    const note = await page.locator("#link-note").count() ? await page.locator("#link-note").textContent() : "baked";
    if (!/^(Reading|)$/.test(note) && (await page.evaluate(() => document.body.classList.contains("refused") || document.querySelectorAll("#checks li").length > 0))) break;
    await page.waitForTimeout(100);
  }
  await page.waitForTimeout(200);
  page.close = async () => ctx.close();
  return page;
}
const link = (c, from) => `/event/?contract=${c.target ?? c}${from === undefined ? "" : `&from=${from}`}`;
const txt = (p, id) => p.locator("#" + id).innerText();
const vis = (p, id) => p.locator("#" + id).isVisible();
const dis = (p, id) => p.locator("#" + id).isDisabled();
const refused = (p) => p.evaluate(() => document.body.classList.contains("refused"));
const visible = (p) => p.evaluate(() => `${document.title}\n${document.querySelector('meta[name="description"]').content}\n${document.body.innerText}`);
const toStatus = async (p) => { await p.evaluate(() => { location.hash = "status"; }); await p.waitForTimeout(100); };
const toDeposit = async (p) => { await p.evaluate(() => { location.hash = ""; }); await p.waitForTimeout(100); };
const waitText = async (pg, id, re) => { for (let i = 0; i < 80 && !re.test(await txt(pg, id)); i++) await pg.waitForTimeout(250); return txt(pg, id); };
const settle = async (pg) => { for (let i = 0; i < 80; i++) { await pg.waitForTimeout(200); if (!/^Checking/.test(await txt(pg, "check-msg"))) break; } await pg.waitForTimeout(200); };
const connect = async (pg) => { await pg.click("#connect"); await settle(pg); };
const lookupAs = async (pg, who) => {
  await toStatus(pg); await pg.fill("#lookup-addr", who); await pg.click("#lookup");
  for (let i = 0; i < 80; i++) { await pg.waitForTimeout(150); if (!/^Checking/.test(await txt(pg, "lookup-out"))) break; }
  await pg.waitForTimeout(300);
  return txt(pg, "lookup-out");
};
// eth_getCode reads of old blocks (finding or checking the block the contract was created in), and the first block of the log scans
const oldCode = (p) => p.calls.filter((c) => c.method === "eth_getCode" && c.params[1] !== "latest").length;
const logStarts = (p) => p.calls.filter((c) => c.method === "eth_getLogs").map((c) => parseInt(c.params[0].fromBlock, 16));
const EVENT_SPECIFIC = /Truth Pays|Devcon|Mumbai|Hitchki|BKC|Arkiv|Web3 Mumbai|Luma|Committed Spot|\bIST\b/;

// 2a. no contract in the link, or half an address: nothing but why
let p = await open("/event/", g1);
check("no contract in the link: says so, nothing else on the page", await refused(p) && /This link doesn't name a deposit contract\. Open the deposit link the organiser gave you: it ends with \?contract=0x…&from=…/.test(await txt(p, "link-note"))
  && !(await vis(p, "connect")) && !(await vis(p, "s-send")) && !(await vis(p, "contract-box")) && !(await p.locator("footer").isVisible()) && p.calls.length === 0, await txt(p, "link-note"));
await toStatus(p);
check("no contract in the link: the status page has nothing to check either", !(await vis(p, "lookup-addr")) && !(await vis(p, "fair-h")));
check("no page errors (no contract)", p.errs.length === 0, p.errs.join("; "));
await p.close();
p = await open("/event/?contract=0x1234", g1);
check("half an address: says the link isn't complete", await refused(p) && /The deposit contract address in this link isn't complete/.test(await txt(p, "link-note")) && !(await vis(p, "connect")), await txt(p, "link-note"));
await p.close();

// 2b. the organiser's link: everything about the event comes from the contract, in the guest's own time zone
p = await open(link(ev.c, ev.block), g1, { timezoneId: "Asia/Tokyo" });
const notice = await txt(p, "link-note");
check("the organiser's link: the notice names the event, the contract and the organiser",
  notice === `Only use a link the organiser gave you. This page is for ${evName}, deposit contract ${ev.c.target}, organiser ${orga.toLowerCase()}.` && (await p.locator("#link-note").getAttribute("class")) === "note warn", notice);
// the event starts at this hour in Tokyo (Chromium and Node may lay out the rest of the date a little differently)
const tokyo = new Date((now + 86400) * 1000).toLocaleString("en-GB", { timeZone: "Asia/Tokyo", hour: "2-digit", minute: "2-digit", hour12: false });
check("event header from the contract: name, start in the guest's time zone (GMT+9), deposit; page title", (await txt(p, "ev-name")) === evName && await p.title() === `${evName} · Deposit`
  && new RegExp(`^Starts .*\\b${tokyo} GMT\\+9\\s*Deposit 0\\.02 ETH$`).test(await txt(p, "ev-meta")), `${await txt(p, "ev-meta")} (${tokyo})`);
check("contract checks pass with the contract's own deposit (0.02 ETH) and Kleros", (await p.locator("#checks .mark.ok").count()) === 4 && /The deposit is exactly 0\.02 ETH/.test(await txt(p, "checks")) && /disputes go to Kleros Court/.test(await txt(p, "checks"))
  && /Deposits are open until .+ GMT\+9/.test(await txt(p, "checks")) && (await txt(p, "contract-addr")) === ev.c.target && (await p.locator("#contract-link").getAttribute("href")) === `https://etherscan.io/address/${ev.c.target}`, await txt(p, "checks"));
check("the deposit amount everywhere is the contract's", /Send exactly 0\.02 ETH/.test(await p.locator("#s-send h2").innerText()) && /get your 0\.02 ETH back/.test(await p.locator("footer").innerText()));
check("the link's block is checked with two reads of the contract's code, not searched", oldCode(p) === 2, String(oldCode(p)));
let shown = await visible(p);
check("nothing on the page names the Truth Pays event, Luma or India time", !EVENT_SPECIFIC.test(shown) && /Check that the deposit address shown here is the one the organiser gave you/.test(shown) && /Back to the registration page/.test(shown), (shown.match(EVENT_SPECIFIC) || [])[0]);
await connect(p);
check("connected: the deposit can be sent", /All set/.test(await txt(p, "check-msg")) && !(await dis(p, "send")), await txt(p, "check-msg"));
await toDeposit(p); await p.click("#send");
const sent = await waitText(p, "send-msg", /Done|failed|cancelled|Nothing was sent|Couldn't/);
const depTx = p.sent[0] || {};
check("deposit sent: deposit() with the contract's own amount, to the contract from the link, pinned to the network",
  /^Done\. 0\.02 ETH received by the deposit contract\. Now paste the link on the event's registration page\.$/.test(sent) && p.sent.length === 1 && depTx.to.toLowerCase() === ev.c.target.toLowerCase()
  && depTx.data === "0xd0e30db0" && BigInt(depTx.value) === D && depTx.chainId === "0x539", `${sent} ${JSON.stringify(p.sent)}`);
check("the contract logged the deposit", (await ev.c.queryFilter(ev.c.filters.Deposited(g1a))).map((e) => e.args.amount).join() === String(D));
check("step 5: the transaction link to copy, and no Luma button", /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(await txt(p, "tx-link")) && (await vis(p, "luma-box")) && (await p.locator("#luma-link").count()) === 0);
const g1Link = await txt(p, "tx-link");
check("no page errors (deposit)", p.errs.length === 0, p.errs.join("; "));
await p.close();
// back again: the earlier deposit is found, read from the block the contract was created in, in logChunk-sized ranges
p = await open(link(ev.c, ev.block), g1);
await connect(p);
check("revisit: the earlier deposit found, Send blocked, its link offered", /We already see a deposit from this wallet: .+ Don't send it twice\. Paste that link on the event's registration page \(shown in step 5\)\./.test(await txt(p, "check-msg"))
  && (await dis(p, "send")) && (await txt(p, "tx-link")) === g1Link, await txt(p, "check-msg"));
check("deposits read from the contract's creation block on, in short ranges", Math.min(...logStarts(p)) === ev.block && p.calls.filter((c) => c.method === "eth_getLogs").every((c) => parseInt(c.params[0].toBlock, 16) - parseInt(c.params[0].fromBlock, 16) < 7), JSON.stringify(logStarts(p)));
let out = await lookupAs(p, g1a);
check("lookup: deposit received, waiting for the hosts (no Luma)", /^Deposit received\. Waiting for the hosts to review your registration\. Deposit: /.test(out), out);
check("status page: the jurors' policy from the contract, linked on Kleros's gateway", (await p.locator("#policy-link a").getAttribute("href")) === `https://cdn.kleros.link${POLICY}`);
shown = await visible(p);
check("status page: nothing names the Truth Pays event, Luma or India time", !EVENT_SPECIFIC.test(shown) && /Missed at check-in\? Challenge it on Kleros/.test(shown), (shown.match(EVENT_SPECIFIC) || [])[0]);
check("no page errors (revisit)", p.errs.length === 0, p.errs.join("; "));
await p.close();
// a link straight to the status page works too
p = await open(`${link(ev.c, ev.block)}#status`, null);
check("link with #status: the status page of that event", (await vis(p, "lookup-addr")) && !(await vis(p, "send")) && (await txt(p, "ev-name")) === evName);
await p.close();

// 2c. the link's block missing, wrong or too late: the page finds the creation block itself (binary search over the
// contract's code); with an RPC that keeps no old state it takes the link's block, and without one it can't go on
for (const [what, from] of [["missing", undefined], ["too late (after the contract was created)", ev.block + 3], ["not a number", "abc"], ["in the future", 10 ** 9]]) {
  p = await open(link(ev.c, from), g1);
  await connect(p);
  check(`link's block ${what}: the creation block is found, the earlier deposit too`, !(await refused(p)) && oldCode(p) >= 5 && Math.min(...logStarts(p)) === ev.block && /already see a deposit/.test(await txt(p, "check-msg")), `${oldCode(p)} ${JSON.stringify(logStarts(p).slice(0, 3))} ${await txt(p, "check-msg")}`);
  await p.close();
}
p = await open(link(ev.c, ev.block), g1, { noArchive: true });
await connect(p);
check("RPC without old state: the link's block is used as it is", !(await refused(p)) && Math.min(...logStarts(p)) === ev.block && /already see a deposit/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
await p.close();
p = await open(link(ev.c), g1, { noArchive: true });
check("RPC without old state and no block in the link: asks for the full link, nothing else", await refused(p) && new RegExp(`Couldn't find when the deposit contract ${ev.c.target} was created.*Ask the organiser for the full link: it ends with &from= and a block number`).test(await txt(p, "link-note"))
  && !(await vis(p, "connect")) && !p.calls.some((c) => c.method === "eth_getLogs"), await txt(p, "link-note"));
await p.close();

// 2d. contracts the page refuses: another dispute service, not a kickback contract, no contract at all
p = await open(link(wrong.c, wrong.block), g2);
check("disputes not on Kleros's own Dispute Resolver: refused, nothing can be sent", await refused(p) && (await txt(p, "link-note")).includes(`The deposit contract at ${wrong.c.target} sends its attendance disputes to ${otherProxy.target.toLowerCase()}, not to Kleros Court. This page only works with Kleros's own. Don't send anything to it`)
  && !(await vis(p, "connect")) && !(await vis(p, "send")) && (await p.locator("#link-note").getAttribute("class")) === "note bad" && p.sent.length === 0, await txt(p, "link-note"));
await toStatus(p);
check("refused: no lookup, challenge or payout tools either", !(await vis(p, "lookup-addr")) && !(await vis(p, "release-box")) && !(await vis(p, "fair-h")));
await p.close();
for (const [what, c] of [["Kleros's court contract", liquid.target], ["a Dispute Resolver", proxy.target]]) {
  p = await open(link(c, 1), g2);
  check(`not a kickback contract (${what}): refused`, await refused(p) && (await txt(p, "link-note")).includes(`The contract at ${c} isn't a kickback deposit contract, so this page can't take deposits for it.`) && !(await vis(p, "connect")), await txt(p, "link-note"));
  check(`no page errors (${what})`, p.errs.length === 0, p.errs.join("; "));
  await p.close();
}
const nobody = ethers.Wallet.createRandom().address;
p = await open(link(nobody, 1), g2);
check("no contract at the address: refused", await refused(p) && (await txt(p, "link-note")).includes(`There is no contract at ${nobody} on Ethereum mainnet. Don't send anything to it, and check the link with the organiser.`), await txt(p, "link-note"));
await p.close();

// 2e. the event's name is the contract's text: shown as text, never as markup, without text-direction tricks; a long
// one fits a phone
p = await open(link(tricky.c, tricky.block), g2);
const trickyName = '<img src=x onerror="window.__xss=1">Night evil & "co"';
check("an event name with markup: shown as plain text (no image, no script), text-direction character removed", (await txt(p, "ev-name")) === trickyName && await p.title() === `${trickyName} · Deposit`
  && (await p.locator("#ev-name img, #link-note img").count()) === 0 && (await p.evaluate(() => window.__xss)) === undefined && (await txt(p, "link-note")).includes(`This page is for ${trickyName}, deposit contract`), await txt(p, "ev-name"));
await p.close();
p = await open(link(longName.c, longName.block), g2);
await p.setViewportSize({ width: 390, height: 800 });
check("phone width, long event name: no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await p.screenshot({ path: path.join(outDir, "generic-phone.png") });
await p.close();

// 2f. the Truth Pays build (contract baked in) ignores the link: another contract in the URL changes nothing
p = await open(`/live/?contract=${ev.c.target}&from=${ev.block}`, g1);
await connect(p);
out = await lookupAs(p, g1a);
const touched = p.calls.filter((c) => JSON.stringify(c.params || []).toLowerCase().includes(ev.c.target.slice(2).toLowerCase()));
check("baked page with another contract in its link: still its own contract, never reads the other one", (await txt(p, "contract-addr")) === baked.c.target && /Truth Pays: Queryable Data/.test(await p.locator("h1").innerText())
  && /The deposit is exactly 0\.01 ETH/.test(await txt(p, "checks")) && touched.length === 0 && /No deposit found from this wallet yet/.test(out) && (await p.locator("#link-note").count()) === 0, `${touched.length} reads of the other contract | ${out}`);
check("baked page: still India time and Luma", /Deposits are open until .+ IST/.test(await txt(p, "checks")) && (await p.locator("#luma-link").getAttribute("href")) === "https://luma.com/qewnqhas");
check("no page errors (baked page)", p.errs.length === 0, p.errs.join("; "));
await p.close();

// 3. after the event, on the generic page: g1 and g2 have confirmed spots, the list names g1 only, g2 challenges from the
// page and g3 disputes it. The case description the jurors read comes from the generic template: it names the event
// (title, date, place, hosts, link), the wallet, the deposit, the contract and the organiser, and is saved on IPFS
// byte for byte at the address the contract computed.
await (await g2.sendTransaction({ to: ev.c.target, value: D })).wait();
const kick = ev.c.connect(org);
await (await kick.registerStakers([g1a, g2a])).wait();
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
await (await kick.postAttendance([g1a], 2n * D)).wait();
const chainNow = async () => (await prov.getBlock("latest")).timestamp;
p = await open(link(ev.c, ev.block), g2, { clockAt: await chainNow(), timezoneId: "America/Bogota" });
check("listed: checks say the list is published", /attendance list is published/.test(await txt(p, "checks")), await txt(p, "checks"));
await connect(p);
out = await lookupAs(p, g2a);
check("off the list: challenge offered, deadline in the guest's time zone (not IST)", /Not on the attendance list\. If you were at the event, you can challenge until .+ GMT-5 with a deposit/.test(out) && !/\bIST\b/.test(out) && /^Challenge \(0\.0162 ETH\)$/.test(await txt(p, "ch-action")), `${out} | ${await txt(p, "ch-action")}`);
await p.click("#ch-action");
out = await waitText(p, "lookup-out", /saved on IPFS|Couldn't save|didn't go through|would fail/);
const [caseText, caseUri] = await ev.c.caseMetaEvidence(g2a);
const meta = JSON.parse(caseText), metaUps = () => ipfs.uploads.filter((u) => u.file === "metaevidence.json");
check("challenge sent from the generic page, to the contract from the link", Number((await ev.c.challenges(g2a)).state) === 1 && p.sent.at(-1).to.toLowerCase() === ev.c.target.toLowerCase() && p.sent.at(-1).data === "0xd2ef7398", out);
check("the generic case description is valid ERC-1497 and names the event, the wallet, the deposit, the contract and the organiser",
  meta.title === `Did wallet ${g2a} attend ${evName} (${FORM.eventWhen})?` && meta.question.includes(g2a) && meta.question.includes(FORM.eventTitle) && meta.question.includes(FORM.eventWhere)
  && [FORM.eventTitle, FORM.eventWhen, FORM.eventWhere, FORM.hosts, FORM.eventLink, "0.02 ETH", ev.c.target, orga].every((s) => meta.description.includes(s)) && meta.fileURI === POLICY
  && meta.aliases[g2a] && meta.aliases[g2a.toLowerCase()] && meta.aliases[orga] && meta.aliases[orga.toLowerCase()] && !EVENT_SPECIFIC.test(caseText.replace(FORM.eventLink, "")), caseText.slice(0, 300));
check("the case description saved on IPFS by the page: byte for byte the contract's text, at the contract's address", /The case description jurors would read is saved on IPFS/.test(out) && metaUps().length === 1 && metaUps()[0].operation === "file"
  && metaUps()[0].data.equals(Buffer.from(caseText, "utf8")) && metaUps()[0].path === caseUri && caseUri === `/ipfs/${core.ipfsCidV0(caseText)}`, out);
check("no page errors (challenge)", p.errs.length === 0, p.errs.join("; "));
await p.close();
p = await open(link(ev.c, ev.block), g3, { clockAt: await chainNow() });
await connect(p);
out = await lookupAs(p, g2a);
check("someone else sees the open challenge and can dispute it", /Challenge open/.test(out) && /Jurors read this case description/.test(out) && /^Dispute this claim \(0\.0162 ETH\)$/.test(await txt(p, "ch-action")), out);
await p.click("#ch-action");
out = await waitText(p, "lookup-out", /Dispute created on Kleros|Couldn't save|didn't go through|would fail/);
const { localDisputeID } = await ev.c.challenges(g2a);
const metaEv = (await proxy.queryFilter(proxy.filters.MetaEvidence(localDisputeID))).map((e) => e.args._evidence);
check("dispute created from the generic page: the Kleros case carries this case's own description", /Dispute created on Kleros/.test(out) && Number((await ev.c.challenges(g2a)).state) === 2 && metaEv.join() === caseUri && metaUps().length === 1, `${out} | ${metaEv.join()}`);
out = await lookupAs(p, g2a);
check("in dispute: the Kleros case linked, evidence form shown", /In a Kleros dispute/.test(out) && /Kleros case #\d+/.test(out) && (await vis(p, "ev-box")), out);
check("no page errors (dispute)", p.errs.length === 0, p.errs.join("; "));
await p.close();

await browser.close(); await server.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
