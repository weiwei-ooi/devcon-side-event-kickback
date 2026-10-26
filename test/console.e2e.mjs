// Browser test of the owner console (console/index.html) against ganache with a fake injected wallet:
// deploy (with the Kleros settings) → register → post attendance list → a guest challenges →
// the owner disputes it → Kleros rules → settle → release payouts. Appeals are funded and collected
// straight on Kleros's dispute kit from the owner wallet (never through the deposit contract).
// Also: deploy refuses a changed config and asks before a second deploy; single refunds only for
// registered stakers; stray returns list earlier returns; leftover warning above rounding dust.
// Needs Playwright with Chromium (see test/site.e2e.mjs).
//   node test/console.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
const proj = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const req = createRequire(path.join(proj, "package.json"));
const ganache = req("ganache");
const { ethers } = req("ethers");
let chromium;
try { ({ chromium } = req("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/node_modules/")("playwright")); }
const U = (x) => ethers.parseUnits(String(x), 6);
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const keys = Array.from({ length: 5 }, (_, i) => "0x" + (i + 7).toString(16).padStart(64, "0"));
const RPC = 18747, WEB = 18787, DAY = 86400;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true });
const [owner, g1, g2, g3] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const addr = (w) => w.getAddress();
const dep = async (n, ...a) => (await new ethers.ContractFactory(load(n).abi, load(n).bytecode, owner).deploy(...a)).waitForDeployment();
const usdc = await dep("MockUSDC");
const arbitrator = await dep("MockArbitrator");
const resolver = await dep("MockDisputeResolver", arbitrator.target);
await (await arbitrator.setResolver(resolver.target)).wait();
const evidence = await dep("MockEvidenceModule");
const kit = new ethers.Contract(await arbitrator.kit(), load("MockDisputeKit").abi, prov);
for (const g of [g1, g2, g3]) await (await usdc.mint(await addr(g), U(100))).wait();
const now = (await prov.getBlock("latest")).timestamp;

// config and lists live in a gitignored out-* folder inside the project (the console serves from there)
const dir = "out-console-e2e";
fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
fs.mkdirSync(path.join(proj, dir));
const write = (f, d) => fs.writeFileSync(path.join(proj, dir, f), JSON.stringify(d, null, 2));
write("config.json", {
  eventName: "Console E2E", chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${RPC}`, token: usdc.target, deposit: "25",
  eventStart: new Date((now - 60) * 1000).toISOString(), claimDeadline: new Date((now + 9 * DAY) * 1000).toISOString(),
  owner: await addr(owner), mode: "live", kleros: { disputeResolver: resolver.target, evidenceModule: evidence.target, policyURI: "/ipfs/QmConsoleE2E/policy.md" },
});
const web = spawn("node", ["scripts/console.mjs", "--config", `${dir}/config.json`, "--out", dir], { cwd: proj, env: { ...process.env, PORT: String(WEB) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 800));

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
const waitLog = async (re) => { for (let i = 0; i < 60 && !re.test(await logText()); i++) await page.waitForTimeout(250); return re.test(await logText()); };
const click = async (id, re) => { await page.click("#" + id); return waitLog(re); };
const skew = async (secs) => { await prov.send("evm_increaseTime", [secs]); await prov.send("evm_mine", []); await page.evaluate((s) => (window.__skew = (window.__skew || 0) + s * 1000), secs); };
const nonce = () => prov.getTransactionCount(me);

await page.goto(`http://localhost:${WEB}/`);
await page.waitForTimeout(800);
check("config shows Kleros", /Kleros, 3 jurors/.test(await txt("deployInfo")), await txt("deployInfo"));
check("connect", await click("connect", /ETH on/) || /ETH on/.test(await txt("who")), await txt("who"));

// F12: the config changed on disk after the page loaded (e.g. another console on the same port) → refuse
const cfgPath = path.join(proj, dir, "config.json"), cfgOrig = fs.readFileSync(cfgPath, "utf8");
fs.writeFileSync(cfgPath, cfgOrig.replace('"Console E2E"', '"Console E2E: REHEARSAL"'));
let n0 = await nonce();
check("deploy refused when the config changed", await click("deploy", /settings changed since this page was opened/), await logText());
check("nothing deployed with the changed config", (await nonce()) === n0);
fs.writeFileSync(cfgPath, cfgOrig);

check("deploy", await click("deploy", /Deployed at/), await logText());
const deployMsg = dialogs.find((m) => /Deploy a new deposit contract/.test(m)) ?? "";
// (a local chain always shows as a test network, like the banner; config.json shows LIVE, the rehearsal REHEARSAL)
check("deploy confirm shows mode, event name, policy, deposit and IST times",
  /Mode: TEST NETWORK/.test(deployMsg) && /TEST NETWORK/.test(await txt("banner")) && /Event name: Console E2E\n/.test(deployMsg) && /Juror policy: \/ipfs\/QmConsoleE2E\/policy\.md/.test(deployMsg) &&
  /Deposit: 25 USDC/.test(deployMsg) && /Attendance list from: .+ IST/.test(deployMsg) && /List by: .+ IST/.test(deployMsg), deployMsg);
const kAddr = await page.inputValue("#addr");
const kick = new ethers.Contract(kAddr, load("TruthPaysKickback").abi, owner);
check("deployed with the configured DisputeResolver", (await kick.disputeResolver()) === resolver.target);
check("deployed with the policy", (await kick.policyURI()) === "/ipfs/QmConsoleE2E/policy.md");
const stored = await page.evaluate(() => Object.entries(localStorage).map(([k, v]) => k + "=" + v).join(";"));
check("deploy remembered in this browser", stored.includes("truthpays.deploys.testnet.1337") && stored.includes(kAddr), stored);
// a second Deploy click asks to type SECOND; not typing it creates nothing
answers.push("no");
n0 = await nonce();
check("second deploy asks first", await click("deploy", /Not deployed: no second contract was created/), await logText());
check("second deploy prompt names the first contract", /SECOND, separate contract/.test(lastDialog()) && lastDialog().includes(kAddr), lastDialog());
check("no second contract", (await nonce()) === n0);

// three guests deposit, all approved
for (const g of [g1, g2, g3]) await (await usdc.connect(g).transfer(kAddr, U(25))).wait();
const items = [];
for (const [g, name] of [[g1, "Ana"], [g2, "Ben"], [g3, "Cai"]]) items.push({ wallet: await addr(g), name, status: 0 });
write("new-stakers.json", { contract: kAddr, chainId: 1337, items });
check("register", await click("register", /Registered 3 stakers/), await logText());

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
  /REGISTERED stakers only/.test(lastDialog()) && /NOT refunded by this/.test(lastDialog()) && /decline each of them on Luma/.test(lastDialog()) &&
  /Refund declined guests/.test(lastDialog()) && /Return a stray transfer/.test(lastDialog()), lastDialog());

// F13: Ana sends 5 USDC by mistake; it is returned; she sends 5 more: the second return lists the first
const ana = await addr(g1);
await (await usdc.connect(g1).transfer(kAddr, U(5))).wait();
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "5");
let anaBal = await usdc.balanceOf(ana);
check("return a stray transfer", await click("refundOne", /Sent 5 USDC to/), await logText());
check("first return: nothing returned before", /Nothing was returned or refunded to this address before/.test(lastDialog()), lastDialog());
check("stray returned", (await usdc.balanceOf(ana)) - anaBal === U(5));
const firstReturn = (await kick.queryFilter(kick.filters.Refunded(ana)))[0]?.transactionHash ?? "none";
await (await usdc.connect(g1).transfer(kAddr, U(5))).wait();
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "5");
answers.push("no");
check("second return can be stopped", await click("refundOne", /Nothing returned\./), await logText());
check("second return lists the earlier return (amount + tx)", /Already sent back to this address/.test(lastDialog()) && /5\.0 USDC returned with/.test(lastDialog()) && lastDialog().includes(firstReturn), lastDialog());
await page.fill("#rfTo", ""); await page.fill("#rfAmt", ""); // these 5 USDC stay in the contract (for the leftover test)

// after the event: Ana and Ben checked in; Cai was missed at the door
write("payout-plan.json", { contract: kAddr, chainId: 1337, stakers: 3, attendees: [await addr(g1), await addr(g2)], share: U("37.5").toString(), shareUsdc: "37.5" });
await page.click("#refresh"); await page.waitForTimeout(800);
check("post button unlocked", !(await page.isDisabled("#postList")), await txt("postList"));
check("post attendance list", await click("postList", /Attendance list posted/), await logText());
await page.waitForTimeout(1000);
check("phase shows challenge window", /challenge window/.test(await txt("status")), await txt("status"));
check("release locked during window", (await page.isDisabled("#release")) && /locked until/.test(await txt("release")), await txt("release"));

// Cai challenges from their own wallet; the owner disputes it from the console
const cai = await addr(g3);
await (await kick.connect(g3).challenge({ value: await kick.challengeDeposit() })).wait();
await page.click("#refresh"); await page.waitForTimeout(800);
check("challenge listed", /waiting for a match/.test(await txt("challenges")), await txt("challenges"));
await page.fill("#chAddr", cai);
check("dispute (match) from console", await click("matchOne", /Sent to Kleros/), await logText());
await page.waitForTimeout(1000);
check("Kleros case link shown", /Kleros case #1000/.test(await txt("challenges")), await txt("challenges"));
await skew(DAY + 60);
await page.click("#refresh"); await page.waitForTimeout(800);
check("release not held by the Kleros case", !(await page.isDisabled("#release")) && (await txt("release")) === "Release payouts", await txt("release"));
// payout now: Ana and Ben get 75 / 3 = 25 each; Cai's 25 is set aside until the final ruling
const before = await Promise.all([g1, g2, g3].map(async (g) => usdc.balanceOf(await addr(g))));
check("release payouts during the case", await click("release", /Paid out/), await logText());
const mid = await Promise.all([g1, g2, g3].map(async (g) => usdc.balanceOf(await addr(g))));
check("attendees paid 25, challenger's share set aside", mid[0] - before[0] === U(25) && mid[1] - before[1] === U(25) && mid[2] === before[2], mid.map(String).join(","));
await page.waitForTimeout(800);
check("set-aside share shown", /Set aside for open Kleros cases\s*25\.0 USDC/.test(await txt("challenges")), await txt("challenges"));

// F14: evidence is filed under the DisputeResolver's local ID (Kleros's externalDisputeID), not the core ID
await page.fill("#evTitle", "Door list"); await page.fill("#evText", "Cai is not on the door list and no host saw them."); await page.fill("#evLink", "ipfs://QmDoorList");
check("submit evidence", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
const localID = (await kick.challenges(cai)).localDisputeID;
const evs = await evidence.queryFilter(evidence.filters.Evidence(localID));
check("evidence on Kleros under the local ID, from the owner", localID !== 1000n && evs.length === 1 && evs[0].args._party === me && JSON.parse(evs[0].args._evidence).fileURI === "ipfs://QmDoorList",
  `local ${localID}: ` + evs.map((e) => `${e.args._party} ${e.args._evidence}`).join("; "));
check("no evidence under the core dispute ID", (await evidence.queryFilter(evidence.filters.Evidence(1000))).length === 0);

// (mock hooks get an explicit gas limit: ganache under-estimates them)
// round 1: jurors say Cai did not attend. Cai's side appeals, the owner defends; both funded → round 2.
// The owner funds both sides here, straight on Kleros's dispute kit.
await (await arbitrator.startAppealPeriod(1000, 2, 3 * DAY, { gasLimit: 500000 })).wait();
await page.click("#refresh"); await page.waitForTimeout(800);
check("appeal window shown", /Round 1: jurors voted No, did not attend\. Appeal window until/.test(await txt("challenges")), await txt("challenges"));
check("settle refused before the final ruling", await click("resolveOne", /has not ruled yet/), await logText());
const kickEth = await prov.getBalance(kAddr);
const sentBefore = sent.length;
await page.selectOption("#apSide", "1");
check("fund the losing side's appeal", await click("fundAppeal", /Appeal funding sent to Kleros for "Yes, attended"/), await logText());
await page.waitForTimeout(800);
check("losing side shown fully funded", /Yes, attended: fully funded/.test(await txt("challenges")), await txt("challenges"));
await page.selectOption("#apSide", "2");
await page.fill("#apAmt", "0.01");
check("chip in part of the other side", await click("fundAppeal", /Appeal funding sent to Kleros for "No, did not attend"/), await logText());
await page.waitForTimeout(800);
check("partial funding shown", /No, did not attend: 0\.01 of 0\.07 ETH/.test(await txt("challenges")), await txt("challenges"));
await clearLog(); // fresh log for the next checks
check("fund the rest of the other side", await click("fundAppeal", /Appeal funding sent to Kleros for "No, did not attend"/), await logText());
check("both funded: round 2", (await arbitrator.getNumberOfRounds(1000)) === 2n);
const fundTxs = sent.slice(sentBefore);
check("appeal transactions went straight to the Kleros kit with ETH", fundTxs.length === 3 && fundTxs.every((t) => t.to?.toLowerCase() === kit.target.toLowerCase() && BigInt(t.value ?? 0) > 0n),
  fundTxs.map((t) => `${t.to} ${t.value}`).join("; "));
const contribs = await kit.queryFilter(kit.filters.Contribution(1000));
check("Kleros records the owner wallet as the contributor", contribs.length === 3 && contribs.every((e) => e.args._contributor === me), contribs.map((e) => e.args._contributor).join(","));
check("deposit contract got no appeal ETH", (await prov.getBalance(kAddr)) === kickEth, String(await prov.getBalance(kAddr)));
await page.waitForTimeout(800);
check("round 2 shown as in progress", /Round 2: evidence period/.test(await txt("challenges")), await txt("challenges"));
check("collect refused before the final ruling", await click("collectAppeal", /only be collected once the case has its final ruling/), await logText());
// round 2: jurors say Cai attended; nobody appeals; anyone delivers the final ruling
await (await arbitrator.startAppealPeriod(1000, 1, DAY, { gasLimit: 500000 })).wait();
await skew(DAY + 60);
await page.click("#refresh"); await page.waitForTimeout(800);
check("appeal window over shown", /appeal window is over/.test(await txt("challenges")), await txt("challenges"));
check("deliver the final ruling", await click("deliverRuling", /Final ruling delivered/), await logText());
// final: Cai attended → settle (Cai gets the set-aside 25) → collect appeal rewards
check("settle after ruling", await click("resolveOne", /Challenge of \S+ settled/), await logText());
check("challenger got the set-aside share", (await usdc.balanceOf(cai)) - mid[2] === U(25));
// F15: "Yes, attended" (won) pays out; "No, did not attend" (lost) owes 0 and is skipped, not sent
const eOwner = await prov.getBalance(me);
n0 = await nonce();
check("collect appeal rewards", await click("collectAppeal", /Appeal money collected from Kleros: /), await logText());
check("zero-amount pair skipped", /Nothing due for round 1, No, did not attend/.test(await logText()) && (await nonce()) === n0 + 1, `${await nonce()} vs ${n0}\n${await logText()}`);
check("owner got the 'attended' side's rewards back", (await prov.getBalance(me)) > eOwner, String((await prov.getBalance(me)) - eOwner));
const wds = await kit.queryFilter(kit.filters.Withdrawal(1000));
check("one Kleros withdrawal, to the owner", wds.length === 1 && wds[0].args._contributor === me && wds[0].args._choice === 1n, wds.map((e) => `${e.args._choice} ${e.args._contributor}`).join("; "));
await clearLog();
n0 = await nonce();
check("collecting again sends nothing", await click("collectAppeal", /Nothing to collect from Kleros case #1000/) && (await nonce()) === n0, await logText());
check("deposit contract holds no ETH", (await prov.getBalance(kAddr)) === 0n, String(await prov.getBalance(kAddr)));
const after = await Promise.all([g1, g2, g3].map(async (g) => usdc.balanceOf(await addr(g))));
check("each of 3 attendees got 25 in the end", after.every((b, i) => b - before[i] === U(25)), after.map(String).join(","));

// F32: 5 USDC of Ana's is still spare: more than rounding dust → typed warning (declined here)
answers.push(false);
check("leftovers above rounding dust are not swept without typing SWEEP", await click("sweep", /Collect leftovers stopped/), await logText());
check("leftover warning names guests' money", /5\.0 USDC is spare\. That is more than rounding dust/.test(lastDialog()) && /Return guests' money first/.test(lastDialog()), lastDialog());
// return it (typing RETURN after seeing the earlier return), then nothing is left over
await clearLog();
await page.fill("#rfTo", ana); await page.fill("#rfAmt", "5");
anaBal = await usdc.balanceOf(ana);
check("return the second stray transfer", await click("refundOne", /Sent 5 USDC to/) && /Type RETURN/.test(lastDialog()), lastDialog());
check("second stray returned", (await usdc.balanceOf(ana)) - anaBal === U(5));
check("nothing left over", await click("sweep", /Nothing left over/), await logText());
check("contract holds no USDC", (await usdc.balanceOf(kAddr)) === 0n);
await page.waitForTimeout(1000);
check("phase shows paid out", /Paid out/.test(await txt("status")), await txt("status"));
check("every transaction carried the network's chainId", sent.length > 0 && sent.every((t) => t.chainId === "0x539"), sent.map((t) => t.chainId).join(","));
check("no page errors", errs.length === 0, errs.join("; "));

await browser.close(); web.kill(); await server.close();
fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
