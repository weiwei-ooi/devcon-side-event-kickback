// Browser test of the owner console (console/index.html) against ganache with a fake injected wallet,
// stand-ins for Kleros Court v1 (KlerosLiquid and the Dispute Resolver, test/MockKleros.sol) and a
// stand-in for Kleros's IPFS upload service (the page's requests are intercepted, never sent):
// deploy (constructor arguments from the scripts' own settings) → register → post attendance list →
// a guest challenges → the owner disputes it and sends the "Challenge details" in one click →
// evidence (text, link, file) → Kleros rules; appeals are funded and collected on the Dispute
// Resolver from the owner wallet (never through the deposit contract) → deliver the final ruling →
// settle → release payouts. Also: deploy refuses a changed config and a live config without the
// pinned files, and asks before a second deploy; single refunds only for registered stakers; stray
// returns list earlier returns; leftover warning above rounding dust.
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
const E = (x) => ethers.parseEther(String(x));
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const keys = Array.from({ length: 5 }, (_, i) => "0x" + (i + 7).toString(16).padStart(64, "0"));
const RPC = 18747, WEB = 18787, DAY = 86400;
const KGAS = { gasLimit: 500000 }; // the Kleros stand-ins' test hooks: ganache under-estimates them
const POLICY = "/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/attendance-policy.md";
const META = "/ipfs/QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o/metaevidence.json";
const EXTRA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 3]);
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true, cacheTimeout: -1 });
const [owner, g1, g2, g3] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
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
  kleros: { court: 0, jurors: 3, disputeResolver: proxy.target, arbitrator: liquid.target, policyURI: POLICY, metaEvidenceURI: META },
};
write("config.json", config);
const web = spawn("node", ["scripts/console.mjs", "--config", `${dir}/config.json`, "--out", dir], { cwd: proj, env: { ...process.env, PORT: String(WEB) }, stdio: "ignore" });
await new Promise((r) => setTimeout(r, 1200));

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
// Kleros's IPFS upload service, simulated: each upload gets a new CID and answers like the real one
// ({ cids: ["ipfs://<cid>/<file name>"] }). `ipfsFail` makes the next uploads fail with an HTTP 500.
const uploads = [];
let ipfsFail = false;
const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const fakeCid = (n) => "Qm" + Array.from({ length: 44 }, (_, i) => B58[(n * 7 + i * 13 + 5) % 58]).join("");
await page.route(/kleros-api\.netlify\.app/, async (route) => {
  const r = route.request();
  const body = r.postDataBuffer()?.toString("utf8") ?? "";
  const cors = { "access-control-allow-origin": "*" };
  if (ipfsFail) return route.fulfill({ status: 500, headers: cors, body: "upstream error" });
  const file = body.match(/filename="([^"]+)"/)?.[1] ?? "file";
  const p = `/ipfs/${fakeCid(uploads.length)}/${file}`;
  uploads.push({ url: r.url(), method: r.method(), body, file, path: p });
  return route.fulfill({ status: 200, headers: { ...cors, "content-type": "application/json" }, body: JSON.stringify({ message: "File has been stored successfully", cids: ["ipfs:/" + p.slice(5)] }) });
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
const click = async (id, re) => { await page.click("#" + id); return waitLog(re); };
const skew = async (secs) => { await prov.send("evm_increaseTime", [secs]); await prov.send("evm_mine", []); await page.evaluate((s) => (window.__skew = (window.__skew || 0) + s * 1000), secs); };
const nonce = () => prov.getTransactionCount(me);
const open = async () => { await page.goto(`http://localhost:${WEB}/`); await page.waitForTimeout(800); };

// a live config without the pinned case description (metaevidence) cannot be deployed
const cfgPath = path.join(proj, dir, "config.json");
write("config.json", { ...config, kleros: { ...config.kleros, metaEvidenceURI: "" } });
await open();
check("missing metaevidence shown before the deploy", /Ready to deploy\?\s*No: Set "kleros\.metaEvidenceURI"/.test(await txt("deployInfo")), await txt("deployInfo"));
await page.click("#connect"); await page.waitForTimeout(500);
let n0 = await nonce();
check("live deploy refused without the pinned metaevidence", await click("deploy", /Not deployed: Set "kleros\.metaEvidenceURI"/), await logText());
check("nothing deployed without the metaevidence", (await nonce()) === n0);
write("config.json", config);

await open();
check("config shows Kleros Court, ETH deposit and the pinned files",
  /Kleros Court \(General Court\), 3 jurors/.test(await txt("deployInfo")) && /0\.01 ETH per guest/.test(await txt("deployInfo")) &&
  (await txt("deployInfo")).includes(POLICY) && (await txt("deployInfo")).includes(META) && !/Ready to deploy/.test(await txt("deployInfo")), await txt("deployInfo"));
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
  deployMsg.includes(`Juror policy: ${POLICY}`) && deployMsg.includes(`Case description for jurors: ${META}`) && /Kleros Court, General Court, 3 jurors/.test(deployMsg) &&
  /Deposit: 0\.01 ETH per guest/.test(deployMsg) && /Attendance list from: .+ IST/.test(deployMsg) && /List by: .+ IST/.test(deployMsg), deployMsg);
const kAddr = await page.inputValue("#addr");
const kick = new ethers.Contract(kAddr, load("TruthPaysKickback").abi, owner);
check("deployed with the configured Dispute Resolver and its court", (await kick.disputeResolver()) === proxy.target && (await kick.arbitrator()) === liquid.target);
check("deployed with the policy, the metaevidence and court 0 / 3 jurors",
  (await kick.policyURI()) === POLICY && (await kick.metaEvidenceURI()) === META && (await kick.arbitratorExtraData()) === EXTRA);
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
write("new-stakers.json", { contract: kAddr, chainId: 1337, items });
check("register", await click("register", /Registered 3 stakers/), await logText());
check("status shows the ETH pool", /Staked pool\s*0\.03 ETH/.test(await txt("status")) && /ETH in contract\s*0\.03 ETH/.test(await txt("status")), await txt("status"));

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

// after the event: Ana and Ben checked in; Cai was missed at the door
write("payout-plan.json", { contract: kAddr, chainId: 1337, stakers: 3, attendees: [await addr(g1), await addr(g2)], share: E("0.015").toString() });
await page.click("#refresh"); await page.waitForTimeout(800);
check("post button unlocked", !(await page.isDisabled("#postList")), await txt("postList"));
check("post attendance list", await click("postList", /Attendance list posted/), await logText());
check("post prompt in ETH", /Each would get 0\.015 ETH \(pool 0\.03 ETH\)/.test(lastDialog()), lastDialog());
await page.waitForTimeout(1000);
check("phase shows challenge window", /challenge window/.test(await txt("status")), await txt("status"));
check("release locked during window", (await page.isDisabled("#release")) && /locked until/.test(await txt("release")), await txt("release"));

// Cai challenges from their own wallet; the owner disputes it from the console and sends the challenge details
const cai = await addr(g3);
const challengeTx = (await (await kick.connect(g3).challenge({ value: await kick.challengeDeposit() })).wait()).hash;
await page.click("#refresh"); await page.waitForTimeout(800);
check("challenge listed with the Kleros fee as deposit", /waiting for a match/.test(await txt("challenges")) && /Challenge deposit\s*0\.0162 ETH \(the Kleros fee\)/.test(await txt("challenges")), await txt("challenges"));
await page.fill("#chAddr", cai);
n0 = await nonce();
check("dispute (match) from console, then the challenge details in one click", await click("matchOne", /Challenge details sent to Kleros case #1000/), await logText());
check("dispute prompt shows the ETH deposit (and no missing-description warning)", /You send 0\.0162 ETH/.test(dialogs.find((m) => /Dispute the claim of/.test(m)) ?? "") && !/no case description/.test(dialogs.find((m) => /Dispute the claim of/.test(m)) ?? "x no case description"), dialogs.join(" | "));
check("details offered right after the dispute", dialogs.some((m) => /Send the "Challenge details" to the jurors of Kleros case #1000 now\?/.test(m) && m.includes(cai)));
check("two transactions: the dispute, then the evidence", (await nonce()) === n0 + 2);
const localID = (await kick.challenges(cai)).localDisputeID;
const evidenceOf = async (group) => proxy.queryFilter(proxy.filters.Evidence(null, group));
let evs = await evidenceOf(localID);
const details = uploads[0] ? JSON.parse(uploads[0].body.slice(uploads[0].body.indexOf("{"), uploads[0].body.lastIndexOf("}") + 1)) : {};
check("challenge details uploaded through Kleros's service as an evidence JSON",
  uploads.length === 1 && uploads[0].method === "POST" && /operation=evidence/.test(uploads[0].url) && /name="data"/.test(uploads[0].body) && uploads[0].file === "evidence.json", JSON.stringify(uploads[0] ?? {}).slice(0, 300));
check("challenge details name the staker, the contract and where to check",
  /Challenge details/.test(details.name) && details.description?.includes(`This case is about the wallet ${cai}`) && details.description.includes(kAddr) &&
  /Challenged and ChallengeMatched events/.test(details.description) && details.description.includes(me) && details.description.includes(`/tx/${challengeTx}`), JSON.stringify(details));
check("challenge details on Kleros under the local ID, from the owner", localID !== 1000n && evs.length === 1 && evs[0].args._party === me && evs[0].args._evidence === uploads[0].path,
  `local ${localID}: ` + evs.map((e) => `${e.args._party} ${e.args._evidence}`).join("; "));
check("Kleros case created with the metaevidence", (await proxy.queryFilter(proxy.filters.MetaEvidence(localID)))[0]?.args._evidence === META);
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

// evidence: uploads that fail send nothing; a link; a file from this computer
await page.fill("#evTitle", "Door list"); await page.fill("#evText", "Cai is not on the door list and no host saw them.");
ipfsFail = true;
n0 = await nonce();
check("failed upload: clear error", await click("submitEvidence", /Could not upload "evidence\.json" to IPFS through Kleros's upload service \(error 500\)\. Nothing was sent to Kleros/), await logText());
check("failed upload: nothing sent", (await nonce()) === n0 && (await evidenceOf(localID)).length === 1);
ipfsFail = false;
await page.fill("#evLink", "ipfs://QmDoorList");
check("submit evidence with a link", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
evs = await evidenceOf(localID);
const second = JSON.parse(uploads[1].body.slice(uploads[1].body.indexOf("{"), uploads[1].body.lastIndexOf("}") + 1));
check("evidence JSON (ERC-1497) on Kleros under the local ID", evs.length === 2 && evs[1].args._party === me && evs[1].args._evidence === uploads[1].path &&
  second.name === "Door list" && second.fileURI === "ipfs://QmDoorList" && /door list/.test(second.description), JSON.stringify(second));
check("no evidence under Kleros's case number", (await evidenceOf(1000)).length === 0);
check("evidence form cleared", (await page.inputValue("#evTitle")) === "" && (await page.inputValue("#evLink")) === "");
await page.fill("#evTitle", "Door photo"); await page.fill("#evText", "Photo of the door list at 21:30.");
await page.setInputFiles("#evFile", { name: "door-list.png", mimeType: "image/png", buffer: Buffer.from("PNG door list photo bytes") });
await page.fill("#evLink", "https://example.org/x");
n0 = await nonce();
check("a file and a link together are refused", await click("submitEvidence", /Attach a file or paste a link, not both/) && (await nonce()) === n0, await logText());
await page.fill("#evLink", "");
await clearLog();
check("submit evidence with a file", await click("submitEvidence", /Evidence sent to Kleros case #1000/), await logText());
const fileUp = uploads[2], third = uploads[3] ? JSON.parse(uploads[3].body.slice(uploads[3].body.indexOf("{"), uploads[3].body.lastIndexOf("}") + 1)) : {};
evs = await evidenceOf(localID);
check("file uploaded first, then the evidence pointing to it", fileUp?.file === "door-list.png" && fileUp.body.includes("PNG door list photo bytes") && third.fileURI === fileUp.path &&
  evs.length === 3 && evs[2].args._evidence === uploads[3].path, JSON.stringify(third));
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
await page.selectOption("#apSide", "1");
check("fund the losing side's appeal", await click("fundAppeal", /Appeal funding sent to Kleros for "Yes, attended"/), await logText());
check("appeal prompt names the Dispute Resolver and the amount (fee + 2x)", lastDialog().includes(proxy.target.slice(0, 6)) && /You send 0\.1134 ETH/.test(lastDialog()), lastDialog());
await page.waitForTimeout(800);
check("losing side shown fully funded, with the warning", /Yes, attended: fully funded/.test(await txt("challenges")) && /"Yes, attended" wins the case/.test(await txt("challenges")), await txt("challenges"));
await page.selectOption("#apSide", "2");
await page.fill("#apAmt", "0.01");
check("chip in part of the other side", await click("fundAppeal", /Appeal funding sent to Kleros for "No, did not attend"/), await logText());
await page.waitForTimeout(800);
check("partial funding shown (from the Dispute Resolver's events)", /No, did not attend: 0\.01 of 0\.0756 ETH/.test(await txt("challenges")), await txt("challenges"));
await clearLog(); // fresh log for the next checks
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
check("phase shows paid out", /Paid out/.test(await txt("status")), await txt("status"));
check("every transaction carried the network's chainId", sent.length > 0 && sent.every((t) => t.chainId === "0x539"), sent.map((t) => t.chainId).join(","));
check("no page errors", errs.length === 0, errs.join("; "));

await browser.close(); web.kill(); await server.close();
fs.rmSync(path.join(proj, dir), { recursive: true, force: true });
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
