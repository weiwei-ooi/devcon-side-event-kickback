// Browser test of the guest deposit page (site/index.html) against ganache with a fake injected wallet.
// Needs Playwright with Chromium: npm i --no-save playwright && npx playwright install chromium
//   node test/site.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
const proj = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const req = createRequire(path.join(proj, "package.json"));
const ganache = req("ganache");
const { ethers } = req("ethers");
let chromium;
try { ({ chromium } = req("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/node_modules/")("playwright")); }
const U = (x) => ethers.parseUnits(String(x), 6);
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const keys = Array.from({ length: 10 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const RPC = 18647, WEB = 18888;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true });
// ga: deposits in two tabs; gx: stray deposit returned, then a real one; gy: declined while USDC refuses its refund
const [owner, g1, g2, g3, poor, ga, gx, gy] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const addr = async (w) => w.getAddress();
const g2a = await addr(g2);
const { abi: uabi, bytecode: ubc } = load("MockUSDC");
const { abi: kabi, bytecode: kbc } = load("TruthPaysKickback");
const usdc = await (await new ethers.ContractFactory(uabi, ubc, owner).deploy()).waitForDeployment();
for (const g of [g1, g2, g3, ga, gx, gy]) await (await usdc.mint(await addr(g), U(100))).wait();
const now = (await prov.getBlock("latest")).timestamp;
const deployBlock = await prov.getBlockNumber();
const arbitrator = await (await new ethers.ContractFactory(load("MockArbitrator").abi, load("MockArbitrator").bytecode, owner).deploy()).waitForDeployment();
const resolver = await (await new ethers.ContractFactory(load("MockDisputeResolver").abi, load("MockDisputeResolver").bytecode, owner).deploy(arbitrator.target)).waitForDeployment();
await (await arbitrator.setResolver(resolver.target)).wait();
const kitAddr = await arbitrator.kit(); // the mock DisputeKitClassic: the page finds it through KlerosCore.disputeKits(1)
const kit = new ethers.Contract(kitAddr, load("MockDisputeKit").abi, owner);
const evidence = await (await new ethers.ContractFactory(load("MockEvidenceModule").abi, load("MockEvidenceModule").bytecode, owner).deploy()).waitForDeployment();
const kleros = [resolver.target, ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [1, 3, 1]), "/ipfs/QmE2E/policy.md"];
const deploy = async (dep) => (await new ethers.ContractFactory(kabi, kbc, owner).deploy(await usdc.getAddress(), U(dep), "E2E", await addr(owner), now + 86400, now + 86400 * 9, kleros)).waitForDeployment();
const kick = await deploy(25), bad = await deploy(15), late = await deploy(25);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-site-"));
const build = (contract, name, extra = {}) => {
  const cfg = path.join(outDir, `${name}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ eventName: "E2E", chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${RPC}`, token: usdc.target, explorer: "https://arbiscan.io", deposit: "25", receiver: contract || "0x0000000000000000000000000000000000000001", contract, eventStart: new Date((now + 86400) * 1000).toISOString(), claimDeadline: new Date((now + 86400 * 9) * 1000).toISOString(), owner: "0x0000000000000000000000000000000000000001", deployBlock, kleros: { disputeResolver: resolver.target, evidenceModule: evidence.target }, ...extra }));
  execFileSync("node", ["scripts/build-site.mjs", "--config", cfg, "--out", path.join(outDir, name), ...(contract ? [] : ["--preview"])], { cwd: proj, stdio: "pipe" });
};
build(kick.target, "live"); build(bad.target, "bad"); build(late.target, "late"); build("", "preview");
http.createServer((rq, rs) => { if (!/^\/(live|bad|preview|late)?$/.test(rq.url)) { rs.writeHead(404); return rs.end(); } const f = path.join(outDir, rq.url.split("/")[1] || "live", "index.html"); rs.writeHead(200, { "content-type": "text/html" }); rs.end(fs.readFileSync(f)); }).listen(WEB);

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };
const browser = await chromium.launch();
const allSent = []; // every transaction any page asked the wallet to send
// opts: failLogs (every log query fails, on the public RPC and in the wallet), logRange (log queries over more blocks
// are refused, like a range-limited RPC), emptyRevert (eth_call with this selector reverts with no data, like a missing function),
// clockAt (the browser's clock, in unix seconds: the chain's clock after evm_increaseTime)
async function open(site, wallet, startChain = 1337, opts = {}) {
  const page = await browser.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  let chain = startChain, signer = wallet, me = wallet ? await addr(wallet) : null;
  page.sent = [];
  const refused = (f) => opts.failLogs || (opts.logRange && parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) > opts.logRange);
  await page.exposeFunction("__rpc", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
    if (method === "eth_chainId") return "0x" + chain.toString(16);
    if (method === "wallet_switchEthereumChain") { chain = parseInt(params[0].chainId, 16); return null; }
    if (method === "eth_sendTransaction") {
      const t = params[0]; page.sent.push(t); allSent.push(t);
      // like MetaMask: a request pinned to another network than the wallet's is refused
      if (t.chainId !== undefined && parseInt(t.chainId, 16) !== chain) throw new Error("Invalid chainId for the current network");
      const r = await signer.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n }); return r.hash;
    }
    if (method === "eth_getLogs" && refused(params[0])) throw new Error("wallet RPC: log range not allowed");
    return prov.send(method, params ?? []);
  });
  if (opts.failLogs || opts.logRange || opts.emptyRevert)
    await page.route((u) => u.port === String(RPC), async (route) => {
      let body = null;
      try { body = JSON.parse(route.request().postData() || "null"); } catch {}
      const fail = (error) => route.fulfill({ status: 200, headers: { "content-type": "application/json", "access-control-allow-origin": "*" }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error }) });
      if (body && body.method === "eth_getLogs" && refused(body.params[0])) return fail({ code: -32005, message: "block range too large" });
      if (body && body.method === "eth_call" && opts.emptyRevert && String(body.params[0].data).startsWith(opts.emptyRevert)) return fail({ code: -32000, message: "execution reverted" });
      return route.continue();
    });
  if (wallet) await page.addInitScript(() => {
    const listeners = {};
    window.ethereum = { request: ({ method, params }) => window.__rpc(method, params), on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); }, removeListener() {} };
    window.__emit = (ev, arg) => (listeners[ev] || []).forEach((f) => f(arg));
  });
  if (opts.clockAt) await page.clock.setFixedTime(new Date(opts.clockAt * 1000));
  page.switchAccount = async (w) => { signer = w; me = await addr(w); await page.evaluate((a) => window.__emit("accountsChanged", [a]), me); };
  await page.goto(`http://localhost:${WEB}/${site}`);
  await page.waitForTimeout(800);
  page.errs = errs;
  return page;
}
const txt = (p, id) => p.locator("#" + id).innerText();
const vis = (p, id) => p.locator("#" + id).isVisible();
const dis = (p, id) => p.locator("#" + id).isDisabled();
const toStatus = async (p) => { await p.evaluate(() => { location.hash = "status"; }); await p.waitForTimeout(100); };
const toDeposit = async (p) => { await p.evaluate(() => { location.hash = ""; }); await p.waitForTimeout(100); };
const waitText = async (pg, id, re) => { for (let i = 0; i < 40 && !re.test(await txt(pg, id)); i++) await pg.waitForTimeout(250); return txt(pg, id); };
// waits until step 3 is done checking the wallet (balances and earlier deposits)
const settle = async (pg) => { for (let i = 0; i < 60; i++) { await pg.waitForTimeout(200); if (!/^Checking/.test(await txt(pg, "check-msg"))) break; } await pg.waitForTimeout(200); };
const connect = async (pg) => { await pg.click("#connect"); await settle(pg); };
const lookupAs = async (pg, who) => {
  await toStatus(pg); await pg.fill("#lookup-addr", who); await pg.click("#lookup");
  for (let i = 0; i < 60; i++) { await pg.waitForTimeout(150); if (!/^Checking/.test(await txt(pg, "lookup-out"))) break; }
  await pg.waitForTimeout(300);
  return txt(pg, "lookup-out");
};
const sendDeposit = async (pg) => { await toDeposit(pg); await pg.click("#send"); return waitText(pg, "send-msg", /Done|failed|cancelled|Nothing was sent|Couldn't/); };
const linkHref = (pg) => pg.locator("#lookup-out a").first().getAttribute("href");

// 1. preview, and no live page without a deploy block
let p = await open("preview", null);
check("preview: 'opens soon' shown", await vis(p, "preview"));
check("preview: connect disabled", await dis(p, "connect"));
await p.close();
let refusedBuild = false;
try { build(kick.target, "nodeploy", { deployBlock: "" }); } catch (e) { refusedBuild = /deployBlock/.test(String(e.stderr)); }
check("build-site refuses a live page without deployBlock", refusedBuild);

// 2. wrong deposit contract
p = await open("bad", g1);
check("bad contract: amount check fails", /not 25 USDC/.test(await txt(p, "checks")), await txt(p, "checks"));
await connect(p);
check("bad contract: send disabled", await dis(p, "send"));
await p.close();

// 3. happy path from wrong network
p = await open("live", g1, 1);
check("live: all checks pass", (await p.locator("#checks .mark.ok").count()) === 4, await txt(p, "checks"));
await connect(p);
check("wrong network warning", /Ethereum mainnet/.test(await txt(p, "net-wrong")));
check("send disabled on wrong network", await dis(p, "send"));
await p.click("#switch"); await settle(p);
check("switched: pill says Arbitrum One", /Arbitrum One|network 1337/.test(await txt(p, "net-pill")), await txt(p, "net-pill"));
check("balance shown", /100 USDC/.test(await txt(p, "bal-usdc")), await txt(p, "bal-usdc"));
check("send enabled", !(await dis(p, "send")));
check("send success message", /Done/.test(await sendDeposit(p)), await txt(p, "send-msg"));
check("tx link shown for Luma", /arbiscan\.io\/tx\/0x[0-9a-f]{64}/.test(await txt(p, "tx-link")), await txt(p, "tx-link"));
check("contract holds 25", (await usdc.balanceOf(kick.target)) === U(25));
check("guest paid exactly 25", (await usdc.balanceOf(await addr(g1))) === U(75));
check("deposit tx pinned to the network (chainId)", p.sent.length === 1 && p.sent[0].chainId === "0x539", JSON.stringify(p.sent));
check("send button now disabled (no double send)", await dis(p, "send"));
// the wallet's browser refuses the clipboard: stay on the page with the link selected
const g1Link = await txt(p, "tx-link");
await p.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: () => Promise.reject(new Error("Write permission denied")) } }));
await p.click("#luma-link"); await p.waitForTimeout(400);
check("copy failed: stays on the page, link selected, asks to copy by hand",
  p.url().startsWith(`http://localhost:${WEB}/`) && /Copy this link, then go back to Luma/.test(await txt(p, "luma-msg")) && (await p.evaluate(() => getSelection().toString())) === g1Link
  && (await p.locator("#luma-msg a").getAttribute("href")) === "https://luma.com/qewnqhas", await txt(p, "luma-msg"));
check("no page errors", p.errs.length === 0, p.errs.join("; "));
// the copy works: the link is on the clipboard, then the page goes back to Luma
let copied = null;
await p.exposeFunction("__clip", (t) => { copied = t; });
await p.evaluate(() => Object.defineProperty(navigator, "clipboard", { configurable: true, value: { writeText: (t) => window.__clip(t) } }));
await p.route("https://luma.com/**", (r) => r.fulfill({ status: 200, contentType: "text/html", body: "<title>Luma</title>Luma" }));
await Promise.all([p.waitForURL(/luma\.com/, { timeout: 5000 }).catch(() => {}), p.click("#luma-link")]);
check("copy worked: link copied, then back to Luma", copied === g1Link && /luma\.com\/qewnqhas/.test(p.url()), `${copied} ${p.url()}`);
await p.close();

// 4. revisit: prior deposit detected, even through an RPC that only answers short block ranges
p = await open("live", g1, 1337, { logRange: 3 });
await connect(p);
check("revisit (range-limited RPC): warns already deposited", /already see a deposit/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("revisit: send disabled", await dis(p, "send"));
check("revisit: Luma link offered", (await vis(p, "luma-box")) && (await txt(p, "tx-link")) === g1Link, await txt(p, "tx-link"));
check("deposit page: no lookup or challenge tools", !(await vis(p, "lookup-addr")) && !(await vis(p, "fair-h")));
await toStatus(p);
check("status page: lookup shown, deposit steps hidden", (await vis(p, "lookup-addr")) && !(await vis(p, "send")) && !(await vis(p, "luma-box")) && (await vis(p, "connect")));
check("lookup: deposit received, waiting review", /Waiting for the hosts/.test(await lookupAs(p, await addr(g1))), await txt(p, "lookup-out"));
check("no page errors (range-limited RPC)", p.errs.length === 0, p.errs.join("; "));
await p.close();

// 4b. the deposit history can't be read: unknown, never "no deposit"
p = await open("live", g3, 1337, { failLogs: true });
await connect(p);
check("history unreadable: send blocked, asks to reload", /Couldn't check for an earlier deposit\. Reload the page\./.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
let out = await lookupAs(p, await addr(g3));
check("history unreadable: lookup says it couldn't check", /Couldn't check this wallet's deposits/.test(out) && !/No deposit found/.test(out), out);
await p.close();

// 4c. the same wallet in two tabs: the second tab re-checks right before the wallet prompt
const pA = await open("live", ga), pB = await open("live", ga);
await connect(pA); await connect(pB);
check("two tabs: both offer Send at first", !(await dis(pA, "send")) && !(await dis(pB, "send")));
const held = await usdc.balanceOf(kick.target);
check("two tabs: first deposit sent", /Done/.test(await sendDeposit(pA)), await txt(pA, "send-msg"));
const second = await sendDeposit(pB);
check("two tabs: second tab refuses a second deposit", /already see a deposit/.test(second) && /Nothing was sent/.test(second) && pB.sent.length === 0 && (await usdc.balanceOf(kick.target)) === held + U(25), second);
await pB.close();
// 4d. switching accounts in the wallet: nothing of the previous account's deposit carries over
const gaLink = await txt(pA, "tx-link");
await pA.switchAccount(g3); await settle(pA);
check("account switch: old link and send note cleared", !(await vis(pA, "luma-box")) && !(await vis(pA, "send-msg")) && (await txt(pA, "who")).toLowerCase() === (await addr(g3)).toLowerCase(), await txt(pA, "check-msg"));
check("account switch: the new wallet can send", !(await dis(pA, "send")), await txt(pA, "check-msg"));
await pA.switchAccount(ga); await settle(pA);
check("account switch back: its deposit found again", /already see a deposit/.test(await txt(pA, "check-msg")) && (await txt(pA, "tx-link")) === gaLink && (await dis(pA, "send")), await txt(pA, "check-msg"));
check("no page errors (two tabs, account switch)", pA.errs.length === 0, pA.errs.join("; "));
await pA.close();

// 5. no USDC
p = await open("live", poor);
await connect(p);
check("poor: needs 25 USDC message", /You need 25 USDC/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("poor: send disabled", await dis(p, "send"));
await p.close();

// 6. register g1, reject g2 after deposit
await (await usdc.connect(g2).transfer(kick.target, U(25))).wait();
const k = kick.connect(owner);
await (await k.registerStakers([await addr(g1)])).wait();
await (await k.rejectAndRefund([await addr(g2)])).wait();
p = await open("live", g1);
await connect(p);
check("registered: confirmed spot message", /confirmed spot/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("registered: send disabled", await dis(p, "send"));
check("lookup registered: spot confirmed", /Spot confirmed/.test(await lookupAs(p, await addr(g1))), await txt(p, "lookup-out"));
check("lookup rejected: refunded", /Refunded/.test(await lookupAs(p, await addr(g2))), await txt(p, "lookup-out"));
await toStatus(p); await p.fill("#lookup-addr", "0x123"); await p.click("#lookup"); await p.waitForTimeout(300);
check("lookup bad address error", /isn't a wallet address/.test(await txt(p, "lookup-out")));
check("stats count 1 spot", /1 spot confirmed/.test(await txt(p, "stats")), await txt(p, "stats"));
await p.close();

// 6b. a stray deposit returned with refund() ("Return a stray transfer"), then a real deposit
const stray = await (await usdc.connect(gx).transfer(kick.target, U(25))).wait();
await (await k.refund(await addr(gx), U(25))).wait();
p = await open("live", gx);
await connect(p);
check("returned stray: a new deposit is allowed", /earlier deposit from this wallet was sent back/.test(await txt(p, "check-msg")) && !(await dis(p, "send")), await txt(p, "check-msg"));
check("returned stray: its link is not offered for Luma", !(await vis(p, "luma-box")));
check("returned stray: new deposit sent", /Done/.test(await sendDeposit(p)), await txt(p, "send-msg"));
const gxLink = await txt(p, "tx-link");
await p.close();
p = await open("live", gx);
await connect(p);
check("returned stray then a deposit: the new link is offered, Send blocked", /already see a deposit/.test(await txt(p, "check-msg")) && (await txt(p, "tx-link")) === gxLink && !gxLink.includes(stray.hash) && (await dis(p, "send")), await txt(p, "tx-link"));
out = await lookupAs(p, await addr(gx));
check("returned stray then a deposit: lookup links the new deposit", /Deposit received/.test(out) && (await linkHref(p)) === gxLink, out);
await p.close();

// 7. refunded guest: allowed but warned; once they pay again, the new deposit is the one to paste
p = await open("live", g2);
await connect(p);
check("refunded guest: warned, send allowed", /refunded before/.test(await txt(p, "check-msg")) && !(await dis(p, "send")), await txt(p, "check-msg"));
check("refunded guest: old refunded tx not offered for Luma", !(await vis(p, "luma-box")));
await p.setViewportSize({ width: 390, height: 800 }); await p.emulateMedia({ colorScheme: "dark" });
check("phone width: no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await p.screenshot({ path: path.join(outDir, "shot-phone.png"), fullPage: false });
check("refunded guest: pays again", /Done/.test(await sendDeposit(p)), await txt(p, "send-msg"));
const g2Link = await txt(p, "tx-link");
await p.close();
p = await open("live", g2);
await connect(p);
check("refunded guest who paid again: new deposit offered for Luma, Send blocked", /already see a deposit/.test(await txt(p, "check-msg")) && (await txt(p, "tx-link")) === g2Link && (await dis(p, "send")), await txt(p, "check-msg"));
out = await lookupAs(p, await addr(g2));
check("lookup refunded + new deposit: waiting for review", /Refunded earlier\. A new deposit/.test(out) && (await linkHref(p)) === g2Link, out);
await p.close();

// 7b. declined guest whose refund USDC refuses (blocklisted): the money waits in the contract to be claimed
await (await usdc.connect(gy).transfer(kick.target, U(25))).wait();
await (await usdc.setBlocked(await addr(gy), true)).wait();
await (await k.rejectAndRefund([await addr(gy)])).wait();
check("undelivered refund kept for the guest", (await kick.owed(await addr(gy))) === U(25));
p = await open("live", gy);
await connect(p);
check("undelivered refund: deposit page points to the claim, Send blocked", /refund couldn't be delivered/.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
out = await lookupAs(p, await addr(gy));
check("lookup declined + owed: waiting to be claimed, claim offered", /waiting to be claimed/.test(out) && !/went back to this wallet/.test(out) && (await vis(p, "claim-usdc")), out);
await p.fill("#claim-to", await addr(poor)); await p.click("#claim-usdc");
check("undelivered refund claimed to another address", /Done/.test(await waitText(p, "lookup-out", /Done|didn't go through|cancelled|would fail/)) && (await usdc.balanceOf(await addr(poor))) === U(25) && (await kick.owed(await addr(gy))) === 0n, await txt(p, "lookup-out"));
await p.close();

// 8. after the event: list posted (g1 only), g3 challenges, g2 disputes it, appeals funded on Kleros, payouts released while
// the case is open, Kleros rules "attended", anyone settles, funders collect from Kleros
await (await usdc.connect(g3).transfer(kick.target, U(25))).wait();
await (await k.registerStakers([await addr(g3)])).wait();
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
await (await k.postAttendance([await addr(g1)], U(50))).wait();
p = await open("live", g3);
check("listed: checks say list published", /attendance list is published/.test(await txt(p, "checks")), await txt(p, "checks"));
await connect(p);
check("listed: lookup off-list offers challenge", /Not on the attendance list/.test(await lookupAs(p, await addr(g3))) && /Challenge \(0\.015 ETH\)/.test(await txt(p, "ch-action")), await txt(p, "lookup-out"));
check("listed, window running: no Release payouts button", !(await vis(p, "release-box")));
await p.click("#ch-action");
check("challenge sent", /Challenge sent/.test(await waitText(p, "lookup-out", /Challenge sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("challenge recorded on-chain", Number((await kick.challenges(await addr(g3))).state) === 1);
check("listed: attendee sees on the list", /On the attendance list/.test(await lookupAs(p, await addr(g1))), await txt(p, "lookup-out"));
await p.close();
p = await open("live", g2); await toStatus(p);
check("open challenges list shows challenger", (await vis(p, "open-ch")) && (await txt(p, "open-ch-list")).toLowerCase().includes((await addr(g3)).toLowerCase()), await txt(p, "open-ch-list"));
await connect(p);
check("challenge open: dispute offered", /Challenge open/.test(await lookupAs(p, await addr(g3))) && /Dispute this claim/.test(await txt(p, "ch-action")), await txt(p, "lookup-out"));
await p.click("#ch-action");
check("dispute created", /Dispute created on Kleros/.test(await waitText(p, "lookup-out", /Dispute created on Kleros|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("in dispute: Kleros case link", /In a Kleros dispute/.test(await lookupAs(p, await addr(g3))) && /Kleros case #1000/.test(await txt(p, "lookup-out")), await txt(p, "lookup-out"));
check("evidence form shown", await vis(p, "ev-box"));
await p.fill("#ev-title", "Photo at the venue"); await p.fill("#ev-text", "Cai at the bar at 19:30, with the Truth Pays banner."); await p.fill("#ev-link", "ipfs://QmPhoto");
await p.click("#ev-send");
check("evidence sent", /Evidence sent to Kleros case #1000/.test(await waitText(p, "lookup-out", /Evidence sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
const localId = (await kick.challenges(await addr(g3))).localDisputeID;
const evs = await evidence.queryFilter(evidence.filters.Evidence(localId));
check("evidence filed under the DisputeResolver's own dispute ID, not the core ID", localId !== 1000n && evs.length === 1 && evs[0].args._party === await addr(g2) && JSON.parse(evs[0].args._evidence).name === "Photo at the venue" && (await evidence.queryFilter(evidence.filters.Evidence(1000))).length === 0, evs.map((e) => e.args._evidence).join("; "));
// round 1: jurors say g3 did not attend. Someone already put 0.005 ETH on "Yes" directly on Kleros.
await (await arbitrator.startAppealPeriod(1000, 2, 3 * 86400, { gasLimit: 500000 })).wait();
await (await kit.connect(g1).fundAppeal(1000, 1, { value: ethers.parseEther("0.005") })).wait();
out = await lookupAs(p, await addr(g3));
check("appeal window shown, with what is already raised", /Round 1: jurors voted No, did not attend/.test(out) && /"Yes, attended": 0\.005 ETH of 0\.105 ETH raised/.test(out) && /Appeal: fund "Yes, attended" \(0\.1 ETH\)/.test(await txt(p, "ch-action")) && /Appeal: fund "No, did not attend" \(0\.07 ETH\)/.test(await txt(p, "ch-action2")), out);
const kickEth = await prov.getBalance(kick.target), n0 = p.sent.length;
await p.click("#ch-action");
check("appeal funded (losing side)", /Appeal funding sent to Kleros/.test(await waitText(p, "lookup-out", /Appeal funding sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
const contributions = () => kit.queryFilter("Contribution").then((l) => l.map((e) => e.args));
const fundTx = p.sent[n0];
check("appeal money went straight to the Kleros kit from the guest's wallet", fundTx && fundTx.to.toLowerCase() === kitAddr.toLowerCase() && fundTx.data.startsWith("0x4b2f0ea0") && fundTx.chainId === "0x539"
  && (await contributions()).some((c) => c._contributor === g2a && c._choice === 1n && c._coreRoundID === 0n && c._amount === ethers.parseEther("0.1")) && (await prov.getBalance(kick.target)) === kickEth, JSON.stringify(fundTx));
check("losing side shown funded, other side offered", /"Yes, attended": fully funded/.test(await lookupAs(p, await addr(g3))) && /fund "No, did not attend"/.test(await txt(p, "ch-action")) && !(await vis(p, "ch-action2")), await txt(p, "lookup-out"));
await p.click("#ch-action");
check("appeal funded (other side)", /Appeal funding sent to Kleros/.test(await waitText(p, "lookup-out", /Appeal funding sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("both funded: round 2 on Kleros", (await arbitrator.getNumberOfRounds(1000)) === 2n);
check("round 2 shown", /Round 2: jurors are being drawn/.test(await lookupAs(p, await addr(g3))) && !(await vis(p, "ch-box")) && !(await vis(p, "reward-box")), await txt(p, "lookup-out"));
// round 2: jurors say attended and nobody appeals. Meanwhile the challenge window is over: anyone can release the payouts.
await (await arbitrator.startAppealPeriod(1000, 1, 86400, { gasLimit: 500000 })).wait();
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
await lookupAs(p, await addr(g1)); await p.waitForTimeout(500);
check("Release payouts offered once the challenge window is over", await vis(p, "release-box"));
const g1Usdc = await usdc.balanceOf(await addr(g1));
await p.click("#release");
check("payouts released from the guest page", /Payouts released/.test(await waitText(p, "release-msg", /Payouts released|didn't go through|cancelled|would fail/)) && Number(await kick.phase()) === 2
  && (await usdc.balanceOf(await addr(g1))) === g1Usdc + U(25) && (await kick.challenges(await addr(g3))).heldShare > 0n, await txt(p, "release-msg"));
check("Release payouts gone once released", !(await vis(p, "release-box")));
await (await arbitrator.passPeriod(1000)).wait(); await (await arbitrator.executeRuling(1000)).wait();
out = await lookupAs(p, await addr(g3));
check("final ruling shown, appeal money offered right away", /Final ruling: Yes, attended/.test(out) && /Settle challenge/.test(await txt(p, "ch-action")) && (await vis(p, "collect")), out);
await p.click("#ch-action");
check("settled after ruling", /Settled according to the Kleros ruling/.test(await waitText(p, "lookup-out", /Settled according to the Kleros ruling|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("challenger's held share paid (status Paid)", Number(await kick.status(await addr(g3))) === 2);
out = await lookupAs(p, await addr(g3));
check("paid challenger: Kleros outcome shown, appeal rewards offered", /Paid out\. Kleros jurors ruled that this guest attended/.test(out) && (await vis(p, "collect")) && /Collect my appeal rewards \(0\.1333 ETH\)/.test(await txt(p, "collect")) && /bot usually pays it out/.test(await txt(p, "reward-text")), `${out} | ${await txt(p, "collect")}`);
const g2Eth = await prov.getBalance(await addr(g2)), n1 = p.sent.length;
await p.click("#collect");
check("appeal rewards collected", /Appeal money collected/.test(await waitText(p, "lookup-out", /Appeal money collected|didn't go through|cancelled|would fail|Couldn't/)) && (await prov.getBalance(await addr(g2))) > g2Eth, await txt(p, "lookup-out"));
const withdrawals = (await kit.queryFilter("Withdrawal")).map((e) => e.args), collectTxs = p.sent.slice(n1);
check("collected from Kleros with the 4-argument call; the losing answer (pays 0) skipped",
  collectTxs.length === 1 && collectTxs[0].to.toLowerCase() === kitAddr.toLowerCase() && collectTxs[0].data.startsWith("0x362c3479")
  && withdrawals.length === 1 && withdrawals[0]._contributor === g2a && withdrawals[0]._choice === 1n && withdrawals[0]._coreRoundID === 0n, JSON.stringify(collectTxs));
await lookupAs(p, await addr(g3));
check("nothing left to collect afterwards", /nothing left to collect/.test(await txt(p, "reward-text")) && !(await vis(p, "collect")), await txt(p, "reward-text"));
check("no page errors (challenges)", p.errs.length === 0, p.errs.join("; "));
await p.close();
// a newer kit: the 4-argument call refusing with a reason is shown as is; only a missing function (empty revert) switches
// to the 3-argument call
await (await kit.setNewStyle(true)).wait();
p = await open("live", g1); await connect(p);
await lookupAs(p, await addr(g3));
check("kit refuses the 4-argument call with a reason: reason shown, nothing sent", /unknown function/.test(await txt(p, "reward-text")) && !(await vis(p, "collect")), await txt(p, "reward-text"));
await p.close();
p = await open("live", g1, 1337, { emptyRevert: "0x362c3479" }); await connect(p);
await lookupAs(p, await addr(g3));
check("kit without the 4-argument call: rewards offered through the 3-argument one", await vis(p, "collect"), await txt(p, "reward-text"));
const g1Eth = await prov.getBalance(await addr(g1));
await p.click("#collect");
check("collected with the 3-argument call", /Appeal money collected/.test(await waitText(p, "lookup-out", /Appeal money collected|didn't go through|cancelled|would fail|Couldn't/)) && p.sent.at(-1).data.startsWith("0x223e2757") && (await prov.getBalance(await addr(g1))) > g1Eth, await txt(p, "lookup-out"));
await p.close();
check("every transaction pinned to the network (chainId)", allSent.length >= 12 && allSent.every((t) => t.chainId === "0x539"), JSON.stringify(allSent.map((t) => t.chainId)));
check("no appeal call ever sent to the deposit contract", !allSent.some((t) => t.to.toLowerCase() === kick.target.toLowerCase() && /^0x(503fc58f|4e6186db)/.test(t.data)));

// 9. a list never published: after the claim deadline a staker withdraws their own deposit from the page
await (await usdc.connect(g1).transfer(late.target, U(25))).wait();
await (await late.connect(owner).registerStakers([await addr(g1)])).wait();
await prov.send("evm_increaseTime", [8 * 86400]); await prov.send("evm_mine", []);
p = await open("late", g1, 1337, { clockAt: (await prov.getBlock("latest")).timestamp }); await connect(p);
check("footer: self-withdrawal only if the list is never published", /never publish the attendance list by the claim deadline \(.+IST\)/.test(await p.locator("footer").innerText()), await p.locator("footer").innerText());
out = await lookupAs(p, await addr(g1));
check("deadline passed, no list: withdrawal offered", /never published before the deadline/.test(out) && (await vis(p, "claim-emergency")), out);
const g1Before = await usdc.balanceOf(await addr(g1));
await p.fill("#claim-to", await addr(g1)); await p.click("#claim-emergency");
check("deposit withdrawn from the page", /Done/.test(await waitText(p, "lookup-out", /Done|didn't go through|cancelled|would fail/)) && (await usdc.balanceOf(await addr(g1))) === g1Before + U(25), await txt(p, "lookup-out"));
out = await lookupAs(p, await addr(g1));
check("after the withdrawal: 'Withdrawn after the deadline', not 'checked in'", /Withdrawn after the deadline/.test(out) && !/checked in/.test(out), out);
check("no page errors (late)", p.errs.length === 0, p.errs.join("; "));
await p.close();

await browser.close(); await server.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
