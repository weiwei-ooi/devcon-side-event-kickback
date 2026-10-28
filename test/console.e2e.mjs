// Browser test of the owner console (console/index.html) against ganache with a fake injected wallet,
// stand-ins for Kleros Court v1 (KlerosLiquid and the Dispute Resolver, test/MockKleros.sol) and a
// stand-in for Kleros's IPFS upload service (the page's requests are intercepted, never sent):
// deploy (constructor arguments from the scripts' own settings) → register → post attendance list →
// a guest challenges ("use this wallet" in the list) → its case description (written by the contract)
// is saved on IPFS → the owner disputes it → the optional "Challenge details" →
// evidence (text, link, file) → Kleros rules; appeals are funded and collected on the Dispute
// Resolver from the owner wallet (never through the deposit contract; an answer must be chosen first),
// with warnings when one answer, "refuse to arbitrate" included, is funded alone and when the funding
// cannot be read → deliver the final ruling → settle → release payouts. Then a second contract: a
// rehearsal dispute that saves the case description itself, and a payout too big for one transaction
// with an unmatched challenge in it, settled first. Also: deploy refuses a changed config and a live
// config without the pinned juror policy, and asks before a second deploy; single refunds only for
// registered stakers; stray returns list earlier returns; leftover warning above rounding dust; lists
// made for another deposit are refused; tokens sent by mistake go back with "Return tokens"; no gas
// limit above 2^24 (EIP-7825); failing log searches are split; the shared core (scripts/core.mjs) loads in
// the browser from the console with an import map and gives the scripts' results.
// Needs Playwright with Chromium (see test/site.e2e.mjs).
//   node test/console.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const proj = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const req = createRequire(path.join(proj, "package.json"));
const ganache = req("ganache");
const { ethers } = req("ethers");
const { loadConfig, deployArgs, ipfsCidV0 } = await import(path.join(proj, "scripts/lib.mjs"));
let chromium;
try { ({ chromium } = req("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/node_modules/")("playwright")); }
const E = (x) => ethers.parseEther(String(x));
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const keys = Array.from({ length: 5 }, (_, i) => "0x" + (i + 7).toString(16).padStart(64, "0"));
const RPC = 18747, WEB = 18787, DAY = 86400;
const KGAS = { gasLimit: 500000 }; // the Kleros stand-ins' test hooks: ganache under-estimates them
const POLICY = "/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/attendance-policy.md";
const EXTRA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 3]);
// ganache's HTTP fallback adds a listener per open connection, and every page load opens a few
EventEmitter.defaultMaxListeners = 50;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true, cacheTimeout: -1 });
const [owner, g1, g2, g3, stranger] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const addr = (w) => w.getAddress();
const bal = async (w) => prov.getBalance(typeof w === "string" ? w : await addr(w));
const dep = async (n, ...a) => (await new ethers.ContractFactory(load(n).abi, load(n).bytecode, owner).deploy(...a)).waitForDeployment();
const liquid = await dep("MockKlerosLiquid");
const proxy = await dep("MockArbitrableProxy", liquid.target);
const FEE = await liquid.arbitrationCost(EXTRA); // the challenge deposit: 0.0162 ETH (3 jurors)
const now = (await prov.getBlock("latest")).timestamp;

// config and lists live in a gitignored out-* folder inside the project (the console serves from there)
const dir = "out-console-e2e";
fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
fs.mkdirSync(path.join(proj, dir));
const write = (f, d) => fs.writeFileSync(path.join(proj, dir, f), JSON.stringify(d, null, 2));
const config = {
  eventName: "Console E2E", chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${RPC}`, logChunk: 5, deposit: "0.01",
  receiver: "0x0000000000000000000000000000000000000001",
  eventStart: new Date((now - 60) * 1000).toISOString(), claimDeadline: new Date((now + 9 * DAY) * 1000).toISOString(),
  owner: await addr(owner), mode: "live",
  kleros: { court: 0, jurors: 3, disputeResolver: proxy.target, arbitrator: liquid.target, policyURI: POLICY },
};
write("config.json", config);
const web = spawn("node", ["scripts/console.mjs", "--config", `${dir}/config.json`, "--out", dir], { cwd: proj, env: { ...process.env, PORT: String(WEB) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));
// a console left running by an earlier run would answer on the same port with its own config
if (web.exitCode !== null) throw new Error(`The console server exited at once (port ${WEB} already in use? stop the old one first)`);

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };
const browser = await chromium.launch();
const page = await browser.newPage();
const errs = []; page.on("pageerror", (e) => errs.push(e.message));
const me = await addr(owner);
const sent = []; // every transaction the console asked the wallet to send
await page.exposeFunction("__rpc", async (method, params) => {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
  if (method === "eth_chainId") return "0x539";
  if (method === "eth_sendTransaction") {
    const t = params[0];
    sent.push(t);
    const r = await owner.sendTransaction({ to: t.to ?? null, data: t.data, value: t.value ? BigInt(t.value) : 0n, gasLimit: t.gas ? BigInt(t.gas) : undefined });
    return r.hash;
  }
  return prov.send(method, params ?? []);
});
// the page's clock can be moved forward together with the chain (window.__skew, in ms)
await page.addInitScript(() => {
  const real = Date.now;
  Date.now = () => real() + (window.__skew || 0);
  window.ethereum = { request: ({ method, params }) => window.__rpc(method, params), on() {}, removeListener() {} };
});
// `bigEstimate`: the chain answers gas estimates from the page with 13.6 million gas (a big payout
// batch), so the console's 30% margin would pass the 2^24 per-transaction cap (EIP-7825): true for
// every estimate, or a function selector for that call's only. `failEstimate` (a selector): that
// call's estimates fail, like a payout too big for one transaction. `logsFail(from, to)`: the
// Dispute Resolver's log searches over that block range fail, like an overloaded public RPC.
let bigEstimate = false, failEstimate = null, logsFail = null;
const logsServed = []; // Dispute Resolver log searches answered while `logsFail` was set: [from, to]
await page.route(new RegExp(`127\\.0\\.0\\.1:${RPC}`), async (route) => {
  if ((!bigEstimate && !failEstimate && !logsFail) || route.request().method() !== "POST") return route.continue();
  const body = JSON.parse(route.request().postData() || "null");
  const res = await route.fetch();
  const out = await res.json();
  const fail = (a, message) => ({ jsonrpc: "2.0", id: a.id, error: { code: -32000, message } });
  const fix = (q, a) => {
    const p = q?.params?.[0] ?? {};
    if (q?.method === "eth_estimateGas") {
      if (failEstimate && String(p.data).startsWith(failEstimate)) return fail(a, "gas required exceeds allowance (16777216)");
      if (bigEstimate === true || (bigEstimate && String(p.data).startsWith(bigEstimate))) return { ...a, result: "0xd00000" };
    }
    if (q?.method === "eth_getLogs" && logsFail && String(p.address).toLowerCase() === proxy.target.toLowerCase()) {
      if (logsFail(Number(p.fromBlock), Number(p.toBlock))) return fail(a, "block range too large");
      logsServed.push([Number(p.fromBlock), Number(p.toBlock)]);
    }
    return a;
  };
  const json = Array.isArray(out) ? out.map((a) => fix([body].flat().find((q) => q.id === a.id), a)) : fix(body, out);
  return route.fulfill({ response: res, body: JSON.stringify(json) });
});
// Kleros's IPFS upload service, simulated: each upload gets a new CID and answers like the real one
// ({ cids: ["ipfs://<cid>/<file name>"] }). A case description (metaevidence.json) gets its real CIDv0
// and no file name ({ cids: ["/ipfs/<cid>"] }), as the real service answered for the pinned docs. The
// gateway (cdn.kleros.link) serves what was uploaded. `ipfsFail` makes the next uploads fail with an HTTP 500.
const uploads = [];
const ipfsStore = new Map(); // what the simulated IPFS holds, by "/ipfs/…" path
let ipfsFail = false;
const fileOf = (buf) => { // the uploaded file's bytes, from the multipart body
  const head = buf.indexOf("\r\n\r\n", buf.indexOf("filename=")) + 4;
  return buf.subarray(head, buf.indexOf("\r\n--", head));
};
await page.route(/cdn\.kleros\.link/, async (route) => {
  const p = new URL(route.request().url()).pathname;
  const cors = { "access-control-allow-origin": "*" };
  return ipfsStore.has(p) ? route.fulfill({ status: 200, headers: cors, body: ipfsStore.get(p) }) : route.fulfill({ status: 404, headers: cors, body: "not found" });
});
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeCid = (n) => "Qm" + Array.from({ length: 44 }, (_, i) => B58[(n * 7 + i * 13 + 5) % 58]).join("");
await page.route(/kleros-api\.netlify\.app/, async (route) => {
  const r = route.request();
  const body = r.postDataBuffer()?.toString("utf8") ?? "";
  const cors = { "access-control-allow-origin": "*" };
  if (ipfsFail) return route.fulfill({ status: 500, headers: cors, body: "upstream error" });
  const file = body.match(/filename="([^"]+)"/)?.[1] ?? "file";
  const content = fileOf(r.postDataBuffer());
  const p = file === "metaevidence.json" ? `/ipfs/${ipfsCidV0(content)}` : `/ipfs/${fakeCid(uploads.length)}/${file}`;
  uploads.push({ url: r.url(), method: r.method(), body, file, path: p, content: content.toString("utf8") });
  ipfsStore.set(p, content);
  return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ message: "File has been stored successfully", cids: [file === "metaevidence.json" ? p : "ipfs:/" + p.slice(5)] }) });
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
const clearLog = () => page.locator("#log").evaluate((el) => (el.textContent = ""));
const waitLog = async (re) => { for (let i = 0; i < 120 && !re.test(await logText()); i++) await page.waitForTimeout(250); return re.test(await logText()); };
// the status panel refreshes after the log line, so wait for it instead of reading it once
const waitStatus = async (...res) => { const ok = async () => { const t = await txt("status"); return res.every((re) => re.test(t)); }; for (let i = 0; i < 120 && !(await ok()); i++) await page.waitForTimeout(250); return ok(); };
const click = async (id, re) => { await page.click("#" + id); return waitLog(re); };
let skewMs = 0; // how far the chain (and so the page's clock) was moved forward
const skew = async (secs) => { await prov.send("evm_increaseTime", [secs]); await prov.send("evm_mine", []); skewMs += secs * 1000; await page.evaluate((ms) => (window.__skew = ms), skewMs); };
const nonce = () => prov.getTransactionCount(me);
// (a reload starts the page's clock afresh: move it forward again with the chain)
const open = async () => { await page.goto(`http://localhost:${WEB}/`); await page.evaluate((ms) => (window.__skew = ms), skewMs); await page.waitForTimeout(800); };
// the current action (a click) has finished: the buttons are enabled again
const idle = async () => { await page.waitForTimeout(150); for (let i = 0; i < 240 && (await page.isDisabled("#refresh")); i++) await page.waitForTimeout(250); };

// a live config without the pinned juror policy cannot be deployed
const cfgPath = path.join(proj, dir, "config.json");
write("config.json", { ...config, kleros: { ...config.kleros, policyURI: "" } });
await open();
check("missing juror policy shown before the deploy", /Ready to deploy\?\s*No: Set "kleros\.policyURI"/.test(await txt("deployInfo")), await txt("deployInfo"));
await page.click("#connect"); await page.waitForTimeout(500);
let n0 = await nonce();
check("live deploy refused without the pinned juror policy", await click("deploy", /Not deployed: Set "kleros\.policyURI"/), await logText());
check("nothing deployed without the juror policy", (await nonce()) === n0);
write("config.json", config);

await open();
check("config shows Kleros Court, ETH deposit, the pinned policy and the case description template",
  /Kleros Court \(General Court\), 3 jurors/.test(await txt("deployInfo")) && /0\.01 ETH per guest/.test(await txt("deployInfo")) &&
  (await txt("deployInfo")).includes(POLICY) && /one per Kleros case, written by the contract from docs\/metaevidence\.template\.json/.test(await txt("deployInfo")) && !/Ready to deploy/.test(await txt("deployInfo")), await txt("deployInfo"));
check("connect", await click("connect", /ETH on/) || /ETH on/.test(await txt("who")), await txt("who"));

// F12: the config changed on disk after the page loaded (e.g. another console on the same port) → refuse
const cfgOrig = fs.readFileSync(cfgPath, "utf8");
fs.writeFileSync(cfgPath, cfgOrig.replace('"Console E2E"', '"Console E2E: REHEARSAL"'));
n0 = await nonce();
check("deploy refused when the config changed", await click("deploy", /settings changed since this page was opened/), await logText());
check("nothing deployed with the changed config", (await nonce()) === n0);
fs.writeFileSync(cfgPath, cfgOrig);

check("deploy", await click("deploy", /Deployed at/), await logText());
const deployMsg = dialogs.find((m) => /Deploy a new deposit contract/.test(m)) ?? "";
// (a local chain always shows as a local test chain, like the banner; config.json shows LIVE, the rehearsal REHEARSAL)
check("deploy confirm shows mode, event name, policy, case description, ETH deposit and IST times",
  /Mode: LOCAL TEST CHAIN/.test(deployMsg) && /LOCAL TEST CHAIN/.test(await txt("banner")) && /Event name: Console E2E\n/.test(deployMsg) &&
  deployMsg.includes(`Juror policy: ${POLICY}`) && deployMsg.includes("Case description for jurors: one per case, from docs/metaevidence.template.json") && /Kleros Court, General Court, 3 jurors/.test(deployMsg) &&
  /Deposit: 0\.01 ETH per guest/.test(deployMsg) && /Attendance list from: .+ IST/.test(deployMsg) && /List by: .+ IST/.test(deployMsg), deployMsg);
const kAddr = await page.inputValue("#addr");
const kick = new ethers.Contract(kAddr, load("TruthPaysKickback").abi, owner);
check("deployed with the configured Dispute Resolver and its court", (await kick.disputeResolver()) === proxy.target && (await kick.arbitrator()) === liquid.target);
const [, , , , , [, , tplPieces, tplSlots]] = deployArgs(loadConfig(cfgPath), ethers.ZeroAddress);
const [kPieces, kSlots] = await kick.metaEvidenceTemplate();
check("deployed with the policy, the case description template and court 0 / 3 jurors",
  (await kick.policyURI()) === POLICY && JSON.stringify([...kPieces]) === JSON.stringify(tplPieces) && kSlots === tplSlots && (await kick.arbitratorExtraData()) === EXTRA);
check("deployed with the deposit in wei, the owner and the dates", (await kick.depositAmount()) === E("0.01") && (await kick.owner()) === me &&
  Number(await kick.eventStart()) === Math.floor(Date.parse(config.eventStart) / 1000) && Number(await kick.claimDeadline()) === Math.floor(Date.parse(config.claimDeadline) / 1000));
const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => k + "=" + v).join(";"));
check("deploy remembered in this browser", stored.includes("truthpays.deploys.local.1337") && stored.includes(kAddr), stored);
// a second Deploy click asks to type SECOND; not typing it creates nothing
answers.push("no");
n0 = await nonce();
check("second deploy asks first", await click("deploy", /Not deployed: no second contract was created/), await logText());
check("second deploy prompt names the first contract", /SECOND, separate contract/.test(lastDialog()) && lastDialog().includes(kAddr), lastDialog());
check("no second contract", (await nonce()) === n0);

// three guests deposit 0.01 ETH (a plain transfer), all approved
for (const g of [g1, g2, g3]) await (await g.sendTransaction({ to: kAddr, value: E("0.01") })).wait();
const items = [];
for (const [g, name] of [[g1, "Ana"], [g2, "Ben"], [g3, "Cai"]]) items.push({ wallet: await addr(g), name, status: 0 });
// finding 5: a list checked against another deposit amount than the contract's is refused
write("new-stakers.json", { contract: kAddr, chainId: 1337, items });
n0 = await nonce();
check("list without a deposit stamp refused", await click("register", /was made for an unknown deposit, but this contract takes 0\.01 ETH\. Ask Claude to fix the deposit/) && (await nonce()) === n0, await logText());
write("new-stakers.json", { contract: kAddr, chainId: 1337, deposit: E("0.005").toString(), items });
check("list made for another deposit refused", await click("register", /was made for a deposit of 0\.005 ETH, but this contract takes 0\.01 ETH/) && (await nonce()) === n0, await logText());
write("new-stakers.json", { contract: kAddr, chainId: 1337, deposit: E("0.01").toString(), items });
check("register", await click("register", /Registered 3 stakers/), await logText());
check("status shows the ETH pool", await waitStatus(/Staked pool\s*0\.03 ETH/, /ETH in contract\s*0\.03 ETH/), await txt("status"));

// RC L8: "Remove and refund" refuses anyone who is not a registered staker
await page.evaluate(() => (document.querySelector("details").open = true)); // "Other actions"
await page.fill("#rmAddr", ethers.Wallet.createRandom().address);
n0 = await nonce();
check("remove and refund refused for a non-staker", await click("removeOne", /is not a registered staker, so .Remove and refund. cannot be used/), await logText());
check("refusal points to Refund declined guests / Return a stray transfer", /Refund declined guests/.test(await logText()) && /Return a stray transfer/.test(await logText()), await logText());
check("nothing sent for the non-staker", (await nonce()) === n0);
await page.fill("#rmAddr", "");

// F39: the cancel prompt says it refunds registered stakers only, and what to do for the others
answers.push(false);
check("cancel can be declined", await click("cancel", /Cancel aborted/), await logText());
check("cancel prompt: registered stakers only, then Refund declined guests and Return a stray transfer",
  /REGISTERED stakers only/.test(lastDialog()) && /0\.03 ETH in total/.test(lastDialog()) && /NOT refunded by this/.test(lastDialog()) && /decline each of them on Luma/.test(lastDialog()) &&
  /Refund declined guests/.test(lastDialog()) && /Return a stray transfer/.test(lastDialog()), lastDialog());

// F13: Ana sends 0.005 ETH by mistake; it is returned; she sends 0.005 more: the second return lists the first
const ana = await addr(g1);
await (await g1.sendTransaction({ to: kAddr, value: E("0.005") })).wait();
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "0.005");
let anaBal = await bal(ana);
check("return a stray transfer", await click("refundOne", /Sent 0\.005 ETH to/), await logText());
check("first return: nothing returned before", /Nothing was returned or refunded to this address before/.test(lastDialog()), lastDialog());
check("stray returned", (await bal(ana)) - anaBal === E("0.005"));
const firstReturn = (await kick.queryFilter(kick.filters.Refunded(ana)))[0]?.transactionHash ?? "none";
await (await g1.sendTransaction({ to: kAddr, value: E("0.005") })).wait();
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "0.005");
answers.push("no");
check("second return can be stopped", await click("refundOne", /Nothing returned\./), await logText());
check("second return lists the earlier return (amount + tx), found in small block chunks", /Already sent back to this address/.test(lastDialog()) && /0\.005 ETH returned with/.test(lastDialog()) && lastDialog().includes(firstReturn), lastDialog());
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "0.1");
n0 = await nonce();
check("returning more than the spare is refused", await click("refundOne", /Only 0\.005 ETH is spare/) && (await nonce()) === n0, await logText());
await page.fill("#rfTo", ""); await page.fill("#rfAmt", ""); // this 0.005 ETH stays in the contract (for the leftover test)

// finding 8: Ben sends 25 USDC to the contract by mistake; it is not a deposit, and goes back with "Return tokens"
const usdc = await dep("TestToken");
const ben = await addr(g2);
await (await usdc.mint(ben, 25_000_000n)).wait();
await (await usdc.connect(g2).transfer(kAddr, 25_000_000n)).wait();
const ethBefore = await bal(kAddr);
await page.fill("#tkToken", usdc.target); await page.fill("#tkTo", ben); await page.fill("#tkAmt", "30");
n0 = await nonce();
check("returning more tokens than the contract holds is refused", await click("returnTokens", /The contract holds only 25 USDC/) && (await nonce()) === n0, await logText());
await page.fill("#tkAmt", "25.0000001");
check("more decimals than the token has are refused", await click("returnTokens", /Enter an amount of USDC like 25 or 12\.5/) && (await nonce()) === n0, await logText());
await page.fill("#tkToken", ana); await page.fill("#tkAmt", "25");
check("an address without a token is refused", await click("returnTokens", /is not a token contract/) && (await nonce()) === n0, await logText());
await page.fill("#tkToken", usdc.target);
bigEstimate = true;
const sentTk = sent.length;
check("return tokens sent by mistake", await click("returnTokens", /Sent 25 USDC to/), await logText());
bigEstimate = false;
check("token return prompt: amount, token, no ETH", lastDialog().includes(`Send 25 USDC (token ${usdc.target})`) && /Tokens are never deposits, and this sends no ETH/.test(lastDialog()), lastDialog());
check("tokens back with the guest, contract ETH untouched", (await usdc.balanceOf(ben)) === 25_000_000n && (await usdc.balanceOf(kAddr)) === 0n && (await bal(kAddr)) === ethBefore);
check("gas limit capped at 2^24 (EIP-7825) when the estimate plus 30% is above it", sent.length === sentTk + 1 && BigInt(sent[sent.length - 1].gas) === 16_777_216n, sent.slice(sentTk).map((t) => t.gas).join(","));

// after the event: Ana and Ben checked in; Cai was missed at the door
write("payout-plan.json", { contract: kAddr, chainId: 1337, stakers: 3, attendees: [await addr(g1), await addr(g2)], share: E("0.015").toString() });
await page.click("#refresh"); await page.waitForTimeout(800);
check("post button unlocked", !(await page.isDisabled("#postList")), await txt("postList"));
check("post attendance list", await click("postList", /Attendance list posted/), await logText());
check("post prompt in ETH", /Each would get 0\.015 ETH \(pool 0\.03 ETH\)/.test(lastDialog()), lastDialog());
await page.waitForTimeout(1000);
check("phase shows challenge window", await waitStatus(/challenge window/), await txt("status"));
check("release locked during window", (await page.isDisabled("#release")) && /locked until/.test(await txt("release")), await txt("release"));

// Cai challenges from their own wallet; the owner disputes it from the console and sends the challenge details
const cai = await addr(g3);
const challengeTx = (await (await kick.connect(g3).challenge({ value: await kick.challengeDeposit() })).wait()).hash;
await page.click("#refresh"); await page.waitForTimeout(800);
check("challenge listed with the Kleros fee as deposit", /waiting for a match/.test(await txt("challenges")) && /Challenge deposit\s*0\.0162 ETH \(the Kleros fee\)/.test(await txt("challenges")), await txt("challenges"));
// finding 16: the list shows the full wallet, and "use this wallet" puts it in "Challenger wallet"
check("challenge list shows the full wallet", (await txt("challenges")).includes(cai), await txt("challenges"));
await page.click("#challenges a:has-text('use this wallet')");
check("'use this wallet' fills the challenger wallet", (await page.inputValue("#chAddr")) === cai, await page.inputValue("#chAddr"));
// the case description (the contract's own text: event, wallet, contract) is linked in the list, not on IPFS yet
const [caseText, caseUri] = await kick.caseMetaEvidence(cai);
await page.waitForTimeout(500);
check("case description linked in the challenge list, not on IPFS yet",
  (await page.locator("#challenges a", { hasText: "case description" }).getAttribute("href")) === `https://cdn.kleros.link${caseUri}` && /not on IPFS yet/.test(await txt("challenges")), await txt("challenges"));
// (its wording comes from the template and may change: only check what it must contain)
check("case description names the event, the wallet and the deposit contract",
  caseText.toLowerCase().includes(cai.toLowerCase()) && caseText.toLowerCase().includes(kAddr.toLowerCase()) && caseText.includes("Console E2E") && JSON.parse(caseText).fileURI === POLICY, caseText.slice(0, 400));
ipfsFail = true;
// a dispute first saves the case description; if that fails it asks, and Cancel sends nothing
answers.push("DISPUTE", false);
n0 = await nonce();
check("dispute: a failed save of the case description asks first; Cancel sends nothing", await click("matchOne", /Dispute not sent/) && (await nonce()) === n0 && uploads.length === 0, await logText());
check("dispute: it says the jurors could not read the case description yet", /could not be saved on IPFS, so the jurors could not read it yet/.test(lastDialog()) && /Send the dispute anyway\?/.test(lastDialog()), lastDialog());
check("publish case description: a failed upload says so", await click("publishCase", /Could not upload "metaevidence\.json" to IPFS/), await logText());
ipfsFail = false;
check("publish case description", await click("publishCase", /Case description for 0x\w+…\w+ saved on IPFS: https:\/\/cdn\.kleros\.link\/ipfs\/Qm/), await logText());
check("published through Kleros's service (operation=file): exactly the contract's text, at the contract's IPFS address",
  uploads.length === 1 && /operation=file/.test(uploads[0].url) && uploads[0].file === "metaevidence.json" && uploads[0].content === caseText && uploads[0].path === caseUri, JSON.stringify(uploads[0] ?? {}).slice(0, 300));
uploads.length = 0;
await page.click("#refresh"); await page.waitForTimeout(800);
check("challenge list shows it on IPFS", /case description ↗ \(on IPFS ✓\)/.test(await txt("challenges")), await txt("challenges"));
n0 = await nonce();
const dialogsBefore = dialogs.length;
check("dispute (match) from console", await click("matchOne", /Sent to Kleros: case #1000.*names/), await logText());
check("dispute prompt shows the ETH deposit, no rehearsal line on a local chain", /You send 0\.0162 ETH/.test(dialogs[dialogsBefore] ?? "") && !/REHEARSAL/.test(dialogs[dialogsBefore] ?? "x"), dialogs.slice(dialogsBefore).join(" | "));
check("dispute: the case description was already on IPFS, so nothing uploaded again; one transaction", uploads.length === 0 && (await nonce()) === n0 + 1 && /is on IPFS/.test(await logText()), await logText());
await idle();
check("dispute: one confirmation only, the challenge details are no longer offered", dialogs.length === dialogsBefore + 1 && !/Challenge details/.test(dialogs.slice(dialogsBefore).join(" ")), dialogs.slice(dialogsBefore).join(" | "));
const localID = (await kick.challenges(cai)).localDisputeID;
check("Kleros case created with this case's own description", (await proxy.queryFilter(proxy.filters.MetaEvidence(localID)))[0]?.args._evidence === caseUri);
// the optional "Challenge details": case number and transaction links
check("send challenge details (optional)", await click("sendDetails", /Challenge details sent to Kleros case #1000/), await logText());
const evidenceOf = async (group) => proxy.queryFilter(proxy.filters.Evidence(null, group));
let evs = await evidenceOf(localID);
const details = uploads[0] ? JSON.parse(uploads[0].body.slice(uploads[0].body.indexOf("{"), uploads[0].body.lastIndexOf("}") + 1)) : {};
check("challenge details uploaded through Kleros's service as an evidence JSON",
  uploads.length === 1 && uploads[0].method === "POST" && /operation=evidence/.test(uploads[0].url) && /name="data"/.test(uploads[0].body) && uploads[0].file === "evidence.json", JSON.stringify(uploads[0] ?? {}).slice(0, 300));
check("challenge details name the staker, the contract and the transactions",
  /Challenge details/.test(details.name) && details.description?.includes(`This case is about the wallet ${cai}`) && details.description.includes(kAddr) &&
  details.description.includes(me) && details.description.includes(`/tx/${challengeTx}`) && !("fileURI" in details), JSON.stringify(details));
// where to check: Read Contract → challenges(wallet), and the match transaction's logs; not the contract's
// Events tab, which only lists the latest 25 events (the payouts push these out)
const matchTx = (await kick.queryFilter(kick.filters.ChallengeMatched(cai)))[0]?.transactionHash ?? "none";
check("challenge details point to challenges(wallet) on Read Contract and to the match transaction's logs, not the Events tab",
  details.description?.includes(`/address/${kAddr}#readContract, "challenges" with the wallet ${cai} shows arbitratorDisputeID 1000 (this Kleros case) and matcher ${me}`) &&
  details.description.includes(`/tx/${matchTx}#eventlog, shows its ChallengeMatched event (Logs tab), which names ${cai} and Kleros case #1000.`) && !/#events/.test(details.description), JSON.stringify(details));
check("challenge details name the Kleros case number and the Dispute Resolver's number",
  details.description?.includes(`It is Kleros case #1000 (https://court.kleros.io/cases/1000), number ${localID} in Kleros's Dispute Resolver`), JSON.stringify(details));
check("challenge details on Kleros under the local ID, from the owner", localID !== 1000n && evs.length === 1 && evs[0].args._party === me && evs[0].args._evidence === uploads[0].path,
  `local ${localID}: ` + evs.map((e) => `${e.args._party} ${e.args._evidence}`).join("; "));
await page.waitForTimeout(500);
check("Kleros case link shown", /Kleros case #1000/.test(await txt("challenges")), await txt("challenges"));
check("case link goes to court.kleros.io", (await page.locator("#challenges a", { hasText: "Kleros case #1000" }).getAttribute("href")) === "https://court.kleros.io/cases/1000");
await skew(DAY + 60);
await page.click("#refresh"); await page.waitForTimeout(800);
check("release not held by the Kleros case", !(await page.isDisabled("#release")) && (await txt("release")) === "Release payouts", await txt("release"));
// payout now: Ana and Ben get 0.03 / 3 = 0.01 each; Cai's 0.01 is set aside until the final ruling
const before = await Promise.all([g1, g2, g3].map((g) => bal(g)));
check("release payouts during the case", await click("release", /Paid out/), await logText());
check("release prompt shows the set-aside share", /Pay 2 attendees 0\.01 ETH each/.test(lastDialog()) && /0\.01 ETH is set aside/.test(lastDialog()), lastDialog());
const mid = await Promise.all([g1, g2, g3].map((g) => bal(g)));
check("attendees paid 0.01, challenger's share set aside", mid[0] - before[0] === E("0.01") && mid[1] - before[1] === E("0.01") && mid[2] === before[2], mid.map(String).join(","));
await page.waitForTimeout(800);
check("set-aside share shown", /Set aside for open Kleros cases\s*0\.01 ETH/.test(await txt("challenges")), await txt("challenges"));

// evidence: uploads that fail send nothing; links; a file from this computer. Kleros Court v1 shows an
// attachment (fileURI) only for a content-addressed /ipfs/ path, and any https link as "unsafe": a link to
// an IPFS file is attached by its /ipfs/ path, any other link goes into the description as text.
const lastEvidence = () => { const u = uploads[uploads.length - 1]; return JSON.parse(u.body.slice(u.body.indexOf("{"), u.body.lastIndexOf("}") + 1)); };
await page.fill("#evTitle", "Door list"); await page.fill("#evText", "Cai is not on the door list and no host saw them.");
ipfsFail = true;
n0 = await nonce();
check("failed upload: clear error", await click("submitEvidence", /Could not upload "evidence\.json" to IPFS through Kleros's upload service \(error 500\)\. Nothing was sent to Kleros/), await logText());
check("failed upload: nothing sent", (await nonce()) === n0 && (await evidenceOf(localID)).length === 1);
ipfsFail = false;
const doorCid = fakeCid(90);
await page.fill("#evLink", `ipfs://${doorCid}`);
check("submit evidence with an ipfs:// link", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
evs = await evidenceOf(localID);
const second = lastEvidence();
check("evidence JSON (ERC-1497) on Kleros under the local ID; an ipfs:// link is attached as /ipfs/<CID>", evs.length === 2 && evs[1].args._party === me && evs[1].args._evidence === uploads[uploads.length - 1].path &&
  second.name === "Door list" && second.fileURI === `/ipfs/${doorCid}` && second.description === "Cai is not on the door list and no host saw them.", JSON.stringify(second));
check("no evidence under Kleros's case number", (await evidenceOf(1000)).length === 0);
check("evidence form cleared", (await page.inputValue("#evTitle")) === "" && (await page.inputValue("#evLink")) === "");
await page.fill("#evTitle", "Door list (gateway link)"); await page.fill("#evText", "The same list, as a PDF.");
await page.fill("#evLink", `https://cdn.kleros.link/ipfs/${doorCid}/door-list.pdf?filename=door-list.pdf`);
await clearLog();
check("submit evidence with a gateway link to an IPFS file", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
check("gateway link attached by its /ipfs/ path (no https), description as typed",
  lastEvidence().fileURI === `/ipfs/${doorCid}/door-list.pdf` && lastEvidence().description === "The same list, as a PDF." &&
  lastDialog().includes(`File on IPFS: /ipfs/${doorCid}/door-list.pdf (shown to jurors as an attachment)`), JSON.stringify(lastEvidence()) + "\n" + lastDialog());
await page.fill("#evTitle", "Host statement"); await page.fill("#evText", "What the host at the door wrote.");
await page.fill("#evLink", "https://example.org/statement");
await clearLog();
check("submit evidence with another link", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
check("another link: no attachment, the link goes into the description as text",
  !("fileURI" in lastEvidence()) && lastEvidence().description === "What the host at the door wrote.\n\nLink: https://example.org/statement", JSON.stringify(lastEvidence()));
check("another link: the confirm says so, and to attach photos and documents as files",
  /this link goes into the description as text, for jurors to copy into their browser\. For a photo or a document, attach the file instead\./.test(lastDialog()), lastDialog());
evs = await evidenceOf(localID);
check("three link evidences on Kleros", evs.length === 4, String(evs.length));
await page.fill("#evTitle", "Door list"); await page.fill("#evText", "Broken link.");
await page.fill("#evLink", "ipfs://QmDoorList");
n0 = await nonce();
check("an incomplete IPFS link is refused", await click("submitEvidence", /ipfs:\/\/QmDoorList is not a complete IPFS address/) && (await nonce()) === n0, await logText());
await page.fill("#evLink", "");
// more link forms (subdomain gateway, trailing slash, old ipfs://ipfs/, a path that is not an IPFS file)
const V1 = "bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi";
const forms = await page.evaluate(([cid, v1]) => [
  `https://${v1}.ipfs.dweb.link/door.png`, `https://ipfs.io/ipfs/${cid}/`, `ipfs://ipfs/${cid}#top`, `/ipfs/${cid}/a.pdf`, "https://example.org/ipfs/notacid", "https://example.org/photo.png",
].map((l) => window.ipfsPathOfLink(l)), [doorCid, V1]);
check("IPFS link forms converted, other links not",
  JSON.stringify(forms) === JSON.stringify([`/ipfs/${V1}/door.png`, `/ipfs/${doorCid}`, `/ipfs/${doorCid}`, `/ipfs/${doorCid}/a.pdf`, null, null]), JSON.stringify(forms));
await page.fill("#evTitle", "Door photo"); await page.fill("#evText", "Photo of the door list at 21:30.");
await page.setInputFiles("#evFile", { name: "door-list.png", mimeType: "image/png", buffer: Buffer.from("PNG door list photo bytes") });
await page.fill("#evLink", "https://example.org/x");
n0 = await nonce();
check("a file and a link together are refused", await click("submitEvidence", /Attach a file or paste a link, not both/) && (await nonce()) === n0, await logText());
await page.fill("#evLink", "");
await clearLog();
check("submit evidence with a file", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
const fileUp = uploads[uploads.length - 2], third = lastEvidence();
evs = await evidenceOf(localID);
check("file uploaded first, then the evidence pointing to it", fileUp?.file === "door-list.png" && fileUp.body.includes("PNG door list photo bytes") && third.fileURI === fileUp.path &&
  evs.length === 5 && evs[4].args._evidence === uploads[uploads.length - 1].path, JSON.stringify(third));
answers.push(false);
await clearLog();
n0 = await nonce();
check("send challenge details again asks first", await click("sendDetails", /Challenge details not sent/) && (await nonce()) === n0, await logText());

// round 1: jurors say Cai did not attend. Cai's side appeals, the owner defends; both funded → round 2.
// The owner funds both sides here, straight on Kleros's Dispute Resolver.
await (await liquid.startAppealPeriod(1000, 2, 3 * DAY, KGAS)).wait();
await page.click("#refresh"); await page.waitForTimeout(800);
check("appeal window shown", /Round 1: jurors voted No, did not attend\. Appeal window until/.test(await txt("challenges")), await txt("challenges"));
check("settle refused before the final ruling", await click("resolveOne", /has not ruled yet/), await logText());
const kickEth = await bal(kAddr);
const sentBefore = sent.length;
// finding 15: no answer is chosen in advance, and funding is refused until one is
n0 = await nonce();
check("fund appeal: no answer chosen at first", (await page.inputValue("#apSide")) === "", await page.inputValue("#apSide"));
check("fund appeal refused until an answer is chosen", await click("fundAppeal", /Choose which answer to fund first\. If you disputed this challenge, your side is "No, did not attend"/) && (await nonce()) === n0, await logText());
await page.selectOption("#apSide", "1");
check("fund the losing side's appeal", await click("fundAppeal", /Appeal funding sent to Kleros for "Yes, attended"/), await logText());
check("appeal prompt names the Dispute Resolver and the amount (fee + 2x)", lastDialog().includes(proxy.target.slice(0, 6)) && /You send 0\.1134 ETH/.test(lastDialog()), lastDialog());
check("appeal prompt starts with the chosen answer, and says it is the other side's for the wallet that disputed",
  lastDialog().startsWith("You are funding: YES, ATTENDED (the challenger's side)\n⚠ You disputed this challenge: this is the OTHER side's answer."), lastDialog());
check("answer cleared after funding", (await page.inputValue("#apSide")) === "", await page.inputValue("#apSide"));
await page.waitForTimeout(800);
check("losing side shown fully funded, with the warning (in the warning colour)", /Yes, attended: fully funded/.test(await txt("challenges")) && /"Yes, attended" wins the case/.test(await txt("challenges")) &&
  (await page.locator("#challenges .warn", { hasText: '"Yes, attended" wins the case' }).count()) === 1, await txt("challenges"));
// finding 12: reading the Dispute Resolver's logs. A search over more than one block fails: the console
// splits the range down to single blocks and still reads the funding.
for (let i = 0; i < 3; i++) await prov.send("evm_mine", []);
logsServed.length = 0;
logsFail = (from, to) => to > from;
await page.click("#refresh"); await idle();
check("a log search that keeps failing is split (down to single blocks); the funding is still read",
  logsServed.some(([f, t]) => f === t) && /Yes, attended: fully funded/.test(await txt("challenges")) && !/Could not read the appeal funding/.test(await txt("challenges")),
  JSON.stringify(logsServed) + "\n" + await txt("challenges"));
// every search fails: the list says so in the warning colour, with the Kleros case page and the deadlines; the log says it once
await clearLog();
logsFail = () => true;
await prov.send("evm_mine", []);
await page.click("#refresh"); await idle();
const unknownRe = /Could not read the appeal funding from Kleros right now\. Check https:\/\/court\.kleros\.io\/cases\/1000 now: if one answer is being funded and yours is not, fund yours in time \("Yes, attended" until [^"]+, "No, did not attend" until [^)]+\), or the other answer wins the case/;
check("funding unreadable: warning in the challenge list", unknownRe.test(await txt("challenges")) && /Yes, attended: \? of 0\.1134 ETH/.test(await txt("challenges")) &&
  (await page.locator("#challenges .warn", { hasText: "Could not read the appeal funding" }).count()) === 1, await txt("challenges"));
check("funding unreadable: warning in the log", unknownRe.test(await logText()) && /Kleros case #1000 \(challenge of 0x\w+…\w+\)/.test(await logText()), await logText());
await prov.send("evm_mine", []);
await page.click("#refresh"); await idle();
check("funding unreadable: logged once only", (await logText()).match(/Could not read the appeal funding/g)?.length === 1 && unknownRe.test(await txt("challenges")), await logText());
logsFail = null;
await page.click("#refresh"); await idle();
check("funding readable again: shown, no warning", /Yes, attended: fully funded/.test(await txt("challenges")) && !/Could not read/.test(await txt("challenges")), await txt("challenges"));
await page.selectOption("#apSide", "2");
await page.fill("#apAmt", "0.01");
check("chip in part of the other side", await click("fundAppeal", /Appeal funding sent to Kleros for "No, did not attend"/), await logText());
check("funding your own side: no 'other side' line", lastDialog().startsWith("You are funding: NO, DID NOT ATTEND (the side of whoever disputed the challenge)\n\n"), lastDialog());
await page.waitForTimeout(800);
check("partial funding shown (from the Dispute Resolver's events)", /No, did not attend: 0\.01 of 0\.0756 ETH/.test(await txt("challenges")), await txt("challenges"));
await clearLog(); // fresh log for the next checks
await page.selectOption("#apSide", "2");
check("fund the rest of the other side", await click("fundAppeal", /Appeal funding sent to Kleros for "No, did not attend"/), await logText());
check("both funded: round 2", (await liquid.rounds(1000)) === 2n);
const fundTxs = sent.slice(sentBefore);
check("appeal transactions went straight to the Dispute Resolver with ETH", fundTxs.length === 3 && fundTxs.every((t) => t.to?.toLowerCase() === proxy.target.toLowerCase() && BigInt(t.value ?? 0) > 0n),
  fundTxs.map((t) => `${t.to} ${t.value}`).join("; "));
const contribs = await proxy.queryFilter(proxy.filters.Contribution(localID));
check("Kleros records the owner wallet as the contributor", contribs.length === 3 && contribs.every((e) => e.args.contributor === me), contribs.map((e) => e.args.contributor).join(","));
check("deposit contract got no appeal ETH", (await bal(kAddr)) === kickEth, String(await bal(kAddr)));
await page.waitForTimeout(800);
check("round 2 shown as in progress", /Round 2: evidence period/.test(await txt("challenges")), await txt("challenges"));
check("collect refused before the final ruling", await click("collectAppeal", /only be collected once the case has its final ruling/), await logText());
// round 2: jurors say Cai attended; nobody appeals; anyone delivers the final ruling
await (await liquid.startAppealPeriod(1000, 1, DAY, KGAS)).wait();
// findings 20/22: someone else (not a guest) chips in for "refuse to arbitrate" (0) on the Dispute Resolver directly (never fully funded here)
await (await proxy.connect(stranger).fundAppeal(localID, 0, { value: E("0.01") })).wait();
await page.click("#refresh"); await idle();
check("'refuse to arbitrate' funding shown", /Round 2: jurors voted Yes, attended\./.test(await txt("challenges")) &&
  /Refuse to arbitrate: 0\.01 of [\d.]+ ETH, until [^(]+\(counts as "did not attend"; the challenge money is then split in half\)/.test(await txt("challenges")), await txt("challenges"));
check("'refuse to arbitrate' warning: it wins unless another answer is fully funded (warning colour)",
  /⚠ "Refuse to arbitrate" is being funded \(it counts as "did not attend", and the challenge money is then split in half\)\. If neither "Yes, attended" \(until [^)]+\) nor "No, did not attend" \(until [^)]+\) is fully funded, "Refuse to arbitrate" wins the case\./.test(await txt("challenges")) &&
  (await page.locator("#challenges .warn", { hasText: '"Refuse to arbitrate" wins the case' }).count()) === 1, await txt("challenges"));
await skew(DAY + 60);
await page.click("#refresh"); await page.waitForTimeout(800);
check("appeal window over shown", /appeal window is over/.test(await txt("challenges")), await txt("challenges"));
n0 = await nonce();
check("deliver the final ruling", await click("deliverRuling", /Final ruling delivered/), await logText());
const delivered = sent.slice(-2);
check("passPeriod then executeRuling, sent to Kleros Court", (await nonce()) === n0 + 2 && delivered.every((t) => t.to?.toLowerCase() === liquid.target.toLowerCase()), delivered.map((t) => t.to).join(","));
await page.click("#refresh"); await page.waitForTimeout(800);
check("final ruling shown", /Final ruling: Yes, attended\. Press Settle/.test(await txt("challenges")), await txt("challenges"));
// final: Cai attended → settle (Cai gets the set-aside 0.01 and what is left of the challenge deposits) → collect appeal rewards
check("settle after ruling", await click("resolveOne", /Challenge of \S+ settled/), await logText());
check("challenger got the set-aside share and the challenge money", (await bal(cai)) - mid[2] === E("0.01") + FEE, String((await bal(cai)) - mid[2]));
// F15: "Yes, attended" (won) pays out; "No, did not attend" (lost) owes 0 and is skipped, not sent
const eOwner = await bal(me);
n0 = await nonce();
check("collect appeal rewards", await click("collectAppeal", /Appeal money collected from Kleros: /), await logText());
check("zero-amount answer skipped, one transaction", /Nothing due for No, did not attend/.test(await logText()) && (await nonce()) === n0 + 1, `${await nonce()} vs ${n0}\n${await logText()}`);
check("owner got the 'attended' side's rewards back", (await bal(me)) > eOwner, String((await bal(me)) - eOwner));
const wds = await proxy.queryFilter(proxy.filters.Withdrawal(localID));
check("one Kleros withdrawal, to the owner", wds.length === 1 && wds[0].args.contributor === me && wds[0].args.ruling === 1n, wds.map((e) => `${e.args.ruling} ${e.args.contributor}`).join("; "));
check("withdrawal sent to the Dispute Resolver for the funded answers", sent[sent.length - 1].to?.toLowerCase() === proxy.target.toLowerCase());
await clearLog();
n0 = await nonce();
check("collecting again sends nothing", await click("collectAppeal", /Nothing to collect from Kleros case #1000/) && (await nonce()) === n0, await logText());
check("evidence buttons locked once the case is settled", (await page.isDisabled("#submitEvidence")) && (await page.isDisabled("#sendDetails")) && (await page.isDisabled("#fundAppeal")));
const after = await Promise.all([g1, g2, g3].map((g) => bal(g)));
check("each of 3 attendees got 0.01 in the end (Cai also got the challenge money back)",
  after[0] - before[0] === E("0.01") && after[1] - before[1] === E("0.01") && after[2] - before[2] === E("0.01") + FEE, after.map(String).join(","));

// F32: 0.005 ETH of Ana's is still spare: more than rounding dust → typed warning (declined here)
answers.push(false);
check("leftovers above rounding dust are not swept without typing SWEEP", await click("sweep", /Collect leftovers stopped/), await logText());
check("leftover warning names guests' money", /0\.005 ETH is spare\. That is more than rounding dust/.test(lastDialog()) && /Return guests' money first/.test(lastDialog()), lastDialog());
// return it (typing RETURN after seeing the earlier return), then nothing is left over
await clearLog();
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "0.005");
anaBal = await bal(ana);
check("return the second stray transfer", await click("refundOne", /Sent 0\.005 ETH to/) && /Type RETURN/.test(lastDialog()), lastDialog());
check("second stray returned", (await bal(ana)) - anaBal === E("0.005"));
check("nothing left over", await click("sweep", /Nothing left over/), await logText());
check("contract holds no ETH", (await bal(kAddr)) === 0n, String(await bal(kAddr)));
await page.waitForTimeout(1000);
check("phase shows paid out", await waitStatus(/Paid out/), await txt("status"));
check("staked pool shown as paid out", await waitStatus(/Staked pool\s*paid out/), await txt("status"));

// A second contract (deployed here, not from the console). Ana is on the list; Ben and Cai challenge.
// In a rehearsal the dispute prompt says the Kleros case is real; the dispute saves Cai's case description
// on IPFS itself. Nobody matches Ben: his challenge counts as attended, and the payout settles it inline.
// Finding 0: when that payout would be too big for one transaction (simulated), the console settles it first.
const k2 = await dep("TruthPaysKickback", ...deployArgs(loadConfig(cfgPath), me));
const k2Addr = k2.target;
for (const g of [g1, g2, g3]) await (await g.sendTransaction({ to: k2Addr, value: E("0.01") })).wait();
await (await k2.registerStakers([ana, ben, cai])).wait();
await (await k2.postAttendance([ana], E("0.03"))).wait();
for (const g of [g2, g3]) await (await k2.connect(g).challenge({ value: await k2.challengeDeposit() })).wait();
const benDeposit = (await k2.challenges(ben)).deposit;
const [, k2CaseUri] = await k2.caseMetaEvidence(cai);
write("config.json", { ...config, mode: "rehearsal" });
await open();
await page.click("#connect"); await idle();
await page.fill("#addr", k2Addr);
await page.click("#refresh"); await idle();
check("rehearsal banner", /^REHEARSAL/.test(await txt("banner")), await txt("banner"));
const row = (w) => page.locator("#challenges div", { hasText: w });
await row(cai).locator("a", { hasText: "use this wallet" }).click();
check("'use this wallet' in a list of two fills the right wallet", (await page.inputValue("#chAddr")) === cai, await page.inputValue("#chAddr"));
await clearLog();
uploads.length = 0;
n0 = await nonce();
const dialogs2 = dialogs.length;
check("rehearsal: dispute", await click("matchOne", /Sent to Kleros: case #1001/), await logText());
check("rehearsal: the dispute prompt says it opens a real Kleros case", /REHEARSAL: this still opens a REAL Kleros case on Ethereum mainnet/.test(dialogs[dialogs2] ?? ""), dialogs.slice(dialogs2).join(" | "));
check("dispute saved the case description on IPFS first, then one transaction",
  uploads.length === 1 && uploads[0].file === "metaevidence.json" && uploads[0].path === k2CaseUri && /saved on IPFS/.test(await logText()) && (await nonce()) === n0 + 1, JSON.stringify(uploads[0] ?? {}).slice(0, 300) + "\n" + await logText());
check("second Kleros case created with its own description",
  (await proxy.queryFilter(proxy.filters.MetaEvidence((await k2.challenges(cai)).localDisputeID)))[0]?.args._evidence === k2CaseUri);
write("config.json", config);
await open();
await page.click("#connect"); await idle();
await page.fill("#addr", k2Addr);
await skew(2 * DAY);
await page.click("#refresh"); await idle();
check("expired unmatched challenge: counts as attended, no case description", /nobody matched in time: counts as attended/.test(await row(ben).innerText()) &&
  !/case description/.test(await row(ben).innerText()) && /case description ↗ \(on IPFS ✓\)/.test(await row(cai).innerText()), await txt("challenges"));
const releaseSel = k2.interface.getFunction("releasePayouts").selector;
// the payout's gas estimate fails: offer to settle Ben first; Cancel sends nothing
failEstimate = releaseSel;
answers.push(false);
await clearLog();
n0 = await nonce();
check("release: estimate fails → offer to settle first; Cancel sends nothing", await click("release", /Payout not sent\. Settle the unmatched challenges first/) && (await nonce()) === n0, await logText());
check("release: the offer says why", /1 challenge\(s\) nobody matched in time count as attended/.test(lastDialog()) && /could not work out the fee for that payout/.test(lastDialog()) &&
  /Settle them first, one transaction each \(1 confirmation\(s\)/.test(lastDialog()), lastDialog());
failEstimate = null;
// the payout would need 13.6 million gas (over 2^24 with the 30% margin): settle Ben, then pay
bigEstimate = releaseSel;
const before2 = await Promise.all([ana, ben, cai].map((w) => bal(w)));
const sent2 = sent.length;
await clearLog();
n0 = await nonce();
const dialogs3 = dialogs.length;
check("release: settle first, then pay", await click("release", /Paid out/), await logText());
bigEstimate = false;
check("release: the offer names the gas", /that payout would need about 13,631,488 gas, too close to the 16,777,216 one Ethereum transaction may use/.test(dialogs[dialogs3] ?? ""), dialogs.slice(dialogs3).join(" | "));
check("release: two transactions, settle Ben then release", (await nonce()) === n0 + 2 && sent.length === sent2 + 2 &&
  sent[sent2].data === k2.interface.encodeFunctionData("resolveChallenge", [ben]) && sent[sent2 + 1].data === releaseSel && BigInt(sent[sent2 + 1].gas) === 16_777_216n,
  sent.slice(sent2).map((t) => `${t.data.slice(0, 10)} ${t.gas}`).join("; "));
check("release prompt after settling: 2 attendees, Cai's share set aside", /Pay 2 attendees 0\.01 ETH each/.test(lastDialog()) && /0\.01 ETH is set aside/.test(lastDialog()), lastDialog());
const after2 = await Promise.all([ana, ben, cai].map((w) => bal(w)));
check("Ana paid, Ben got his challenge deposit and his share, Cai's share set aside",
  after2[0] - before2[0] === E("0.01") && after2[1] - before2[1] === benDeposit + E("0.01") && after2[2] === before2[2] && (await k2.heldBack()) === E("0.01"), after2.map((x, i) => x - before2[i]).join(","));
// The jurors give no ruling (0) in Cai's case and nobody appeals: it stands. For this contract that keeps
// Cai off the list and splits what is left of the challenge deposits in half; the console says so.
const NO_RULING = 'no ruling (counts as "did not attend"; the challenge money is split in half)';
await (await liquid.startAppealPeriod(1001, 0, DAY, KGAS)).wait();
await page.click("#refresh"); await idle();
check("a 0 vote is labelled as counting as 'did not attend', and stands if no answer is funded",
  (await row(cai).innerText()).includes(`jurors voted ${NO_RULING}. Appeal window until`) &&
  (await page.locator("#challenges .warn", { hasText: "The jurors gave no ruling. If no answer is fully funded in time, it stands: the challenger stays off the list and the challenge money is split in half." }).count()) === 1,
  await row(cai).innerText());
await skew(DAY + 60);
await row(cai).locator("a", { hasText: "use this wallet" }).click();
await clearLog();
check("deliver the final ruling 0", await click("deliverRuling", /Final ruling delivered/), await logText());
await page.click("#refresh"); await idle();
check("final ruling 0 labelled", (await row(cai).innerText()).includes(`Final ruling: ${NO_RULING}. Press Settle.`), await row(cai).innerText());
const before0 = await Promise.all([ana, ben, cai].map((w) => bal(w)));
check("settle the 0 ruling", await click("resolveOne", /Challenge of \S+ settled/), await logText());
const after0 = await Promise.all([ana, ben, cai].map((w) => bal(w)));
const caiCh = await k2.challenges(cai);
check("0 ruling: Cai stays off the list with half the challenge money; the set-aside share goes to Ana and Ben",
  !(await k2.attended(cai)) && after0[2] - before0[2] === (2n * caiCh.deposit - caiCh.arbitrationPaid) / 2n &&
  after0[0] - before0[0] === E("0.005") && after0[1] - before0[1] === E("0.005") && (await k2.heldBack()) === 0n, after0.map((x, i) => x - before0[i]).join(","));
// The shared core (scripts/core.mjs) runs in the browser as an ES module, "ethers" mapped to the ethers
// ESM build with an import map, both served by the console: same results as the scripts in Node.
const corePage = await browser.newPage();
const coreErrs = []; corePage.on("pageerror", (e) => coreErrs.push(e.message));
await corePage.route(`http://localhost:${WEB}/core-check.html`, (route) => route.fulfill({ contentType: "text/html", body:
  '<!doctype html><script type="importmap">{ "imports": { "ethers": "/node_modules/ethers/dist/ethers.min.js" } }</script>' +
  '<script type="module">import * as core from "/scripts/core.mjs"; window.core = core;</script>' }));
const served = await Promise.all(["/scripts/core.mjs", "/node_modules/ethers/dist/ethers.min.js"].map(async (p) => (await fetch(`http://localhost:${WEB}${p}`)).headers.get("content-type")));
check("the console serves the shared core and the ethers ESM build as JavaScript", served.every((t) => t === "text/javascript"), served.join(", "));
await corePage.goto(`http://localhost:${WEB}/core-check.html`);
await corePage.waitForFunction(() => !!window.core, null, { timeout: 10000 }).catch(() => {});
const tplText = fs.readFileSync(path.join(proj, "docs/metaevidence.template.json"), "utf8");
const lumaCsv = '﻿name,email,eth_address,"Deposit tx link, etherscan.io"\r\n"Ana ""A""",ana@x.io,0xab,"line 1\nline 2"\r\nBen,ben@x.io\r\n';
const inBrowser = await corePage.evaluate(async ({ cfgText, tplText, me, lumaCsv }) => {
  const core = window.core;
  if (!core) return null;
  const cfg = core.normalizeConfig(JSON.parse(cfgText), "config.json");
  const args = core.deployArgs(cfg, me, tplText, { name: "metaevidence.template.json" });
  const t = core.caseTemplate(tplText, core.templateValues(cfg, me));
  return { args: JSON.stringify(args, (_, x) => (typeof x === "bigint" ? x.toString() : x)), cid: core.ipfsPathOf(t.sample), rows: core.parseCsv(lumaCsv) };
}, { cfgText: fs.readFileSync(cfgPath, "utf8"), tplText, me, lumaCsv });
const nodeArgs = JSON.stringify(deployArgs(loadConfig(cfgPath), me), (_, x) => (typeof x === "bigint" ? x.toString() : x));
const { caseTemplate: nodeTemplate } = await import(path.join(proj, "scripts/lib.mjs"));
const { parse: csvParse } = req("csv-parse/sync");
check("the core runs in the browser with an import map: same constructor arguments, case description path and CSV rows as the scripts",
  !!inBrowser && inBrowser.args === nodeArgs && inBrowser.cid === `/ipfs/${ipfsCidV0(nodeTemplate(loadConfig(cfgPath), me).sample)}` &&
  JSON.stringify(inBrowser.rows) === JSON.stringify(csvParse(lumaCsv, { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true })) && !coreErrs.length,
  JSON.stringify(inBrowser).slice(0, 300) + coreErrs.join("; "));
await corePage.close();
// a console started before its files were updated refuses the new page's code (here: /scripts/core.mjs answers 404):
// the page says so and how to restart, instead of buttons that do nothing
const deadPage = await browser.newPage();
await deadPage.route(/\/scripts\/core\.mjs/, (route) => route.fulfill({ status: 404, body: "not found" }));
await deadPage.goto(`http://localhost:${WEB}/`);
await deadPage.waitForFunction(() => window.__pageFailed === true, null, { timeout: 15000 }).catch(() => {});
const deadText = `${await deadPage.locator("#banner").innerText()} | ${await deadPage.locator("#log").innerText()}`;
check("console code that did not load: the page says to restart the console",
  /The console's code did not load, so its buttons do nothing\. Stop the console \(press Ctrl\+C in its terminal window\) and start it again with: npm run console\. Then reload this page\./.test(deadText) &&
  (await deadPage.locator("#log .err").count()) === 1, deadText);
await deadPage.close();
check("every transaction carried the network's chainId", sent.length > 0 && sent.every((t) => t.chainId === "0x539"), sent.map((t) => t.chainId).join(","));
check("no page errors", errs.length === 0, errs.join("; "));

await browser.close(); web.kill(); await server.close();
fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
