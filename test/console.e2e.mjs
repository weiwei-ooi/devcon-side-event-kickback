// Browser test of the owner console (console/index.html) against ganache with a fake injected wallet:
// deploy (with the Kleros settings) → register → post attendance list → a guest challenges →
// the owner disputes it → Kleros rules → settle → release payouts.
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
await page.exposeFunction("__rpc", async (method, params) => {
  if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
  if (method === "eth_chainId") return "0x539";
  if (method === "eth_sendTransaction") {
    const t = params[0];
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
// confirm() → yes; prompt() → the word it asks for
page.on("dialog", (d) => { const m = d.message().match(/Type (\w+)/); d.accept(m ? m[1] : undefined); });
const txt = (id) => page.locator("#" + id).innerText();
const logText = () => txt("log");
const waitLog = async (re) => { for (let i = 0; i < 60 && !re.test(await logText()); i++) await page.waitForTimeout(250); return re.test(await logText()); };
const click = async (id, re) => { await page.click("#" + id); return waitLog(re); };
const skew = async (secs) => { await prov.send("evm_increaseTime", [secs]); await prov.send("evm_mine", []); await page.evaluate((s) => (window.__skew = (window.__skew || 0) + s * 1000), secs); };

await page.goto(`http://localhost:${WEB}/`);
await page.waitForTimeout(800);
check("config shows Kleros", /Kleros, 3 jurors/.test(await txt("deployInfo")), await txt("deployInfo"));
check("connect", await click("connect", /ETH on/) || /ETH on/.test(await txt("who")), await txt("who"));
check("deploy", await click("deploy", /Deployed at/), await logText());
const kAddr = await page.inputValue("#addr");
const kick = new ethers.Contract(kAddr, load("TruthPaysKickback").abi, owner);
check("deployed with the configured DisputeResolver", (await kick.disputeResolver()) === resolver.target);
check("deployed with the policy", (await kick.policyURI()) === "/ipfs/QmConsoleE2E/policy.md");

// three guests deposit, all approved
for (const g of [g1, g2, g3]) await (await usdc.connect(g).transfer(kAddr, U(25))).wait();
const items = [];
for (const [g, name] of [[g1, "Ana"], [g2, "Ben"], [g3, "Cai"]]) items.push({ wallet: await addr(g), name, status: 0 });
write("new-stakers.json", { contract: kAddr, chainId: 1337, items });
check("register", await click("register", /Registered 3 stakers/), await logText());

// after the event: Ana and Ben checked in; Cai was missed at the door
write("payout-plan.json", { contract: kAddr, chainId: 1337, stakers: 3, attendees: [await addr(g1), await addr(g2)], share: U("37.5").toString(), shareUsdc: "37.5" });
await page.click("#refresh"); await page.waitForTimeout(800);
check("post button unlocked", !(await page.isDisabled("#postList")), await txt("postList"));
check("post attendance list", await click("postList", /Attendance list posted/), await logText());
await page.waitForTimeout(1000);
check("phase shows challenge window", /challenge window/.test(await txt("status")), await txt("status"));
check("release locked during window", (await page.isDisabled("#release")) && /locked until/.test(await txt("release")), await txt("release"));

// Cai challenges from their own wallet; the owner disputes it from the console
await (await kick.connect(g3).challenge({ value: await kick.challengeDeposit() })).wait();
await page.click("#refresh"); await page.waitForTimeout(800);
check("challenge listed", /waiting for a match/.test(await txt("challenges")), await txt("challenges"));
await page.fill("#chAddr", await addr(g3));
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
await page.fill("#evTitle", "Door list"); await page.fill("#evText", "Cai is not on the door list and no host saw them."); await page.fill("#evLink", "ipfs://QmDoorList");
check("submit evidence", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
const evs = await evidence.queryFilter(evidence.filters.Evidence(1000));
check("evidence on Kleros, from the owner", evs.length === 1 && evs[0].args._party === me && JSON.parse(evs[0].args._evidence).fileURI === "ipfs://QmDoorList", evs.map((e) => `${e.args._party} ${e.args._evidence}`).join("; "));

// (mock hooks get an explicit gas limit: ganache under-estimates them)
// round 1: jurors say Cai did not attend. Cai's side appeals, the owner defends; both funded → round 2
await (await arbitrator.startAppealPeriod(1000, 2, 3 * DAY, { gasLimit: 500000 })).wait();
await page.click("#refresh"); await page.waitForTimeout(800);
check("appeal window shown", /Round 1: jurors voted No, did not attend\. Appeal window until/.test(await txt("challenges")), await txt("challenges"));
check("settle refused before the final ruling", await click("resolveOne", /has not ruled yet/), await logText());
await page.selectOption("#apSide", "1");
check("fund the losing side's appeal", await click("fundAppeal", /Appeal funding sent for "Yes, attended"/), await logText());
await page.waitForTimeout(800);
check("losing side shown fully funded", /Yes, attended: fully funded/.test(await txt("challenges")), await txt("challenges"));
await page.selectOption("#apSide", "2");
await page.fill("#apAmt", "0.01");
check("chip in part of the other side", await click("fundAppeal", /Appeal funding sent for "No, did not attend"/), await logText());
await page.waitForTimeout(800);
check("partial funding shown", /No, did not attend: 0\.01 of 0\.07 ETH/.test(await txt("challenges")), await txt("challenges"));
await (await page.locator("#log").evaluate((el) => (el.textContent = ""))); // fresh log for the next checks
check("fund the rest of the other side", await click("fundAppeal", /Appeal funding sent for "No, did not attend"/), await logText());
check("both funded: round 2", (await arbitrator.getNumberOfRounds(1000)) === 2n);
await page.waitForTimeout(800);
check("round 2 shown as in progress", /Round 2: evidence period/.test(await txt("challenges")), await txt("challenges"));
// round 2: jurors say Cai attended; nobody appeals; anyone delivers the final ruling
await (await arbitrator.startAppealPeriod(1000, 1, DAY, { gasLimit: 500000 })).wait();
await skew(DAY + 60);
await page.click("#refresh"); await page.waitForTimeout(800);
check("appeal window over shown", /appeal window is over/.test(await txt("challenges")), await txt("challenges"));
check("deliver the final ruling", await click("deliverRuling", /Final ruling delivered/), await logText());
check("appeal money waits for the settlement", await click("collectAppeal", /not settled yet/), await logText());
// final: Cai attended → settle (Cai gets the set-aside 25) → collect appeal rewards
check("settle after ruling", await click("resolveOne", /Challenge of \S+ settled/), await logText());
check("challenger got the set-aside share", (await usdc.balanceOf(await addr(g3))) - mid[2] === U(25));
const eOwner = await prov.getBalance(me);
check("collect appeal rewards", await click("collectAppeal", /Appeal money collected/), await logText());
check("owner got the 'attended' side's rewards back", (await prov.getBalance(me)) > eOwner, String((await prov.getBalance(me)) - eOwner));
check("deposit contract holds no appeal money", (await prov.getBalance(kAddr)) < 10n, String(await prov.getBalance(kAddr)));
const after = await Promise.all([g1, g2, g3].map(async (g) => usdc.balanceOf(await addr(g))));
check("each of 3 attendees got 25 in the end", after.every((b, i) => b - before[i] === U(25)), after.map(String).join(","));
check("contract holds no USDC", (await usdc.balanceOf(kAddr)) === 0n);
await page.waitForTimeout(1000);
check("phase shows paid out", /Paid out/.test(await txt("status")), await txt("status"));
check("no page errors", errs.length === 0, errs.join("; "));

await browser.close(); web.kill(); await server.close();
fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
