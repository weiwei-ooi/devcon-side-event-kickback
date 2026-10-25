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
const keys = Array.from({ length: 6 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const RPC = 18647, WEB = 18888;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true });
const [owner, g1, g2, g3, poor] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const addr = async (w) => w.getAddress();
const { abi: uabi, bytecode: ubc } = load("MockUSDC");
const { abi: kabi, bytecode: kbc } = load("GroundTruthKickback");
const usdc = await (await new ethers.ContractFactory(uabi, ubc, owner).deploy()).waitForDeployment();
for (const g of [g1, g2, g3]) await (await usdc.mint(await addr(g), U(100))).wait();
const now = (await prov.getBlock("latest")).timestamp;
const deployBlock = await prov.getBlockNumber();
const arbitrator = await (await new ethers.ContractFactory(load("MockArbitrator").abi, load("MockArbitrator").bytecode, owner).deploy()).waitForDeployment();
const resolver = await (await new ethers.ContractFactory(load("MockDisputeResolver").abi, load("MockDisputeResolver").bytecode, owner).deploy(arbitrator.target)).waitForDeployment();
await (await arbitrator.setResolver(resolver.target)).wait();
const kleros = [resolver.target, ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [1, 3, 1]), "/ipfs/QmE2E/policy.md"];
const deploy = async (dep) => (await new ethers.ContractFactory(kabi, kbc, owner).deploy(await usdc.getAddress(), U(dep), "E2E", await addr(owner), now + 86400, now + 86400 * 9, kleros)).waitForDeployment();
const kick = await deploy(25), bad = await deploy(15);

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-site-"));
const build = (contract, name) => {
  const cfg = path.join(outDir, `${name}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ eventName: "E2E", chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${RPC}`, token: usdc.target, explorer: "https://arbiscan.io", deposit: "25", receiver: contract || "0x0000000000000000000000000000000000000001", contract, eventStart: new Date((now + 86400) * 1000).toISOString(), claimDeadline: new Date((now + 86400 * 9) * 1000).toISOString(), owner: "0x0000000000000000000000000000000000000001", deployBlock, kleros: { disputeResolver: resolver.target } }));
  execFileSync("node", ["scripts/build-site.mjs", "--config", cfg, "--out", path.join(outDir, name), ...(contract ? [] : ["--preview"])], { cwd: proj });
};
build(kick.target, "live"); build(bad.target, "bad"); build("", "preview");
http.createServer((rq, rs) => { if (!/^\/(live|bad|preview)?$/.test(rq.url)) { rs.writeHead(404); return rs.end(); } const f = path.join(outDir, rq.url.split("/")[1] || "live", "index.html"); rs.writeHead(200, { "content-type": "text/html" }); rs.end(fs.readFileSync(f)); }).listen(WEB);

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };
const browser = await chromium.launch();
async function open(site, wallet, startChain = 1337) {
  const page = await browser.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  let chain = startChain;
  const signer = wallet;
  const me = wallet ? await addr(wallet) : null;
  await page.exposeFunction("__rpc", async (method, params) => {
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
    if (method === "eth_chainId") return "0x" + chain.toString(16);
    if (method === "wallet_switchEthereumChain") { chain = parseInt(params[0].chainId, 16); return null; }
    if (method === "eth_sendTransaction") { const t = params[0]; const r = await signer.sendTransaction({ to: t.to, data: t.data, value: t.value ? BigInt(t.value) : 0n }); return r.hash; }
    return prov.send(method, params ?? []);
  });
  if (wallet) await page.addInitScript(() => { window.ethereum = { request: ({ method, params }) => window.__rpc(method, params), on() {}, removeListener() {} }; });
  await page.goto(`http://localhost:${WEB}/${site}`);
  await page.waitForTimeout(800);
  page.errs = errs;
  return page;
}
const txt = (p, id) => p.locator("#" + id).innerText();
const vis = (p, id) => p.locator("#" + id).isVisible();
const dis = (p, id) => p.locator("#" + id).isDisabled();

// 1. preview
let p = await open("preview", null);
check("preview: 'opens soon' shown", await vis(p, "preview"));
check("preview: connect disabled", await dis(p, "connect"));
await p.close();

// 2. wrong deposit contract
p = await open("bad", g1);
check("bad contract: amount check fails", /not 25 USDC/.test(await txt(p, "checks")), await txt(p, "checks"));
await p.click("#connect"); await p.waitForTimeout(800);
check("bad contract: send disabled", await dis(p, "send"));
await p.close();

// 3. happy path from wrong network
p = await open("live", g1, 1);
check("live: all checks pass", (await p.locator("#checks .mark.ok").count()) === 4, await txt(p, "checks"));
await p.click("#connect"); await p.waitForTimeout(800);
check("wrong network warning", /Ethereum mainnet/.test(await txt(p, "net-wrong")));
check("send disabled on wrong network", await dis(p, "send"));
await p.click("#switch"); await p.waitForTimeout(1000);
check("switched: pill says Arbitrum One", /Arbitrum One|network 1337/.test(await txt(p, "net-pill")), await txt(p, "net-pill"));
check("balance shown", /100 USDC/.test(await txt(p, "bal-usdc")), await txt(p, "bal-usdc"));
check("send enabled", !(await dis(p, "send")));
await p.click("#send"); await p.waitForTimeout(3000);
check("send success message", /Done/.test(await txt(p, "send-msg")), await txt(p, "send-msg"));
check("tx link shown for Luma", /arbiscan\.io\/tx\/0x[0-9a-f]{64}/.test(await txt(p, "tx-link")), await txt(p, "tx-link"));
check("contract holds 25", (await usdc.balanceOf(kick.target)) === U(25));
check("guest paid exactly 25", (await usdc.balanceOf(await addr(g1))) === U(75));
check("send button now disabled (no double send)", await dis(p, "send"));
check("no page errors", p.errs.length === 0, p.errs.join("; "));
await p.close();

// 4. revisit: prior deposit detected
p = await open("live", g1);
await p.click("#connect"); await p.waitForTimeout(1200);
check("revisit: warns already deposited", /already see a deposit/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("revisit: send disabled", await dis(p, "send"));
check("revisit: Luma link offered", await vis(p, "luma-box"));
await p.fill("#lookup-addr", await addr(g1)); await p.click("#lookup"); await p.waitForTimeout(800);
check("lookup: deposit received, waiting review", /Waiting for the hosts/.test(await txt(p, "lookup-out")), await txt(p, "lookup-out"));
await p.close();

// 5. no USDC
p = await open("live", poor);
await p.click("#connect"); await p.waitForTimeout(1000);
check("poor: needs 25 USDC message", /You need 25 USDC/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("poor: send disabled", await dis(p, "send"));
await p.close();

// 6. register g1, reject g2 after deposit
await (await usdc.connect(g2).transfer(kick.target, U(25))).wait();
const k = kick.connect(owner);
await (await k.registerStakers([await addr(g1)])).wait();
await (await k.rejectAndRefund([await addr(g2)])).wait();
p = await open("live", g1);
await p.click("#connect"); await p.waitForTimeout(1000);
check("registered: confirmed spot message", /confirmed spot/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("registered: send disabled", await dis(p, "send"));
await p.fill("#lookup-addr", await addr(g1)); await p.click("#lookup"); await p.waitForTimeout(800);
check("lookup registered: spot confirmed", /Spot confirmed/.test(await txt(p, "lookup-out")), await txt(p, "lookup-out"));
await p.fill("#lookup-addr", await addr(g2)); await p.click("#lookup"); await p.waitForTimeout(800);
check("lookup rejected: refunded", /Refunded/.test(await txt(p, "lookup-out")), await txt(p, "lookup-out"));
await p.fill("#lookup-addr", "0x123"); await p.click("#lookup"); await p.waitForTimeout(300);
check("lookup bad address error", /isn't a wallet address/.test(await txt(p, "lookup-out")));
check("stats count 1 spot", /1 spot confirmed/.test(await txt(p, "stats")), await txt(p, "stats"));
await p.close();

// 7. refunded guest: allowed but warned
p = await open("live", g2);
await p.click("#connect"); await p.waitForTimeout(1000);
check("refunded guest: warned, send allowed", /refunded before/.test(await txt(p, "check-msg")) && !(await dis(p, "send")), await txt(p, "check-msg"));
check("refunded guest: old refunded tx not offered for Luma", !(await vis(p, "luma-box")));
await p.setViewportSize({ width: 390, height: 800 }); await p.emulateMedia({ colorScheme: "dark" });
check("phone width: no horizontal scroll", await p.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
await p.screenshot({ path: path.join(outDir, "shot-phone.png"), fullPage: false });
await p.close();

// 8. after the event: list posted (g1 only), g3 challenges, g2 disputes it, Kleros rules, anyone settles
await (await usdc.connect(g3).transfer(kick.target, U(25))).wait();
await (await k.registerStakers([await addr(g3)])).wait();
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
await (await k.postAttendance([await addr(g1)], U(50))).wait();
const waitText = async (pg, id, re) => { for (let i = 0; i < 40 && !re.test(await txt(pg, id)); i++) await pg.waitForTimeout(250); return txt(pg, id); };
const lookupAs = async (pg, who) => { await pg.fill("#lookup-addr", who); await pg.click("#lookup"); await pg.waitForTimeout(900); return txt(pg, "lookup-out"); };
p = await open("live", g3);
check("listed: checks say list published", /attendance list is published/.test(await txt(p, "checks")), await txt(p, "checks"));
await p.click("#connect"); await p.waitForTimeout(1000);
check("listed: lookup off-list offers challenge", /Not on the attendance list/.test(await lookupAs(p, await addr(g3))) && /Challenge \(0\.015 ETH\)/.test(await txt(p, "ch-action")), await txt(p, "lookup-out"));
await p.click("#ch-action"); await p.waitForTimeout(1500);
check("challenge sent", /Challenge sent/.test(await waitText(p, "lookup-out", /Challenge sent|didn't go through|cancelled/)), await txt(p, "lookup-out"));
check("challenge recorded on-chain", Number((await kick.challenges(await addr(g3))).state) === 1);
check("listed: attendee sees on the list", /On the attendance list/.test(await lookupAs(p, await addr(g1))), await txt(p, "lookup-out"));
await p.close();
p = await open("live", g2);
check("open challenges list shows challenger", (await vis(p, "open-ch")) && (await txt(p, "open-ch-list")).toLowerCase().includes((await addr(g3)).toLowerCase()), await txt(p, "open-ch-list"));
await p.click("#connect"); await p.waitForTimeout(1000);
check("challenge open: dispute offered", /Challenge open/.test(await lookupAs(p, await addr(g3))) && /Dispute this claim/.test(await txt(p, "ch-action")), await txt(p, "lookup-out"));
await p.click("#ch-action"); await p.waitForTimeout(1500);
check("dispute created", /Dispute created on Kleros/.test(await waitText(p, "lookup-out", /Dispute created on Kleros|didn't go through|cancelled/)), await txt(p, "lookup-out"));
check("in dispute: Kleros case link", /In a Kleros dispute/.test(await lookupAs(p, await addr(g3))) && /Kleros case #1000/.test(await txt(p, "lookup-out")), await txt(p, "lookup-out"));
// round 1: jurors say g3 did not attend; anyone can fund an appeal from the page, one side at a time
await (await arbitrator.startAppealPeriod(1000, 2, 3 * 86400, { gasLimit: 500000 })).wait();
check("appeal window shown", /Round 1: jurors voted No, did not attend/.test(await lookupAs(p, await addr(g3))) && /Appeal: fund "Yes, attended" \(0\.105 ETH\)/.test(await txt(p, "ch-action")) && /Appeal: fund "No, did not attend" \(0\.07 ETH\)/.test(await txt(p, "ch-action2")), await txt(p, "lookup-out"));
await p.click("#ch-action"); await p.waitForTimeout(1500);
check("appeal funded (losing side)", /Appeal funding sent/.test(await waitText(p, "lookup-out", /Appeal funding sent|didn't go through|cancelled/)), await txt(p, "lookup-out"));
check("losing side shown funded, other side offered", /"Yes, attended": fully funded/.test(await lookupAs(p, await addr(g3))) && /fund "No, did not attend"/.test(await txt(p, "ch-action")) && !(await vis(p, "ch-action2")), await txt(p, "lookup-out"));
await p.click("#ch-action"); await p.waitForTimeout(1500);
check("appeal funded (other side)", /Appeal funding sent/.test(await waitText(p, "lookup-out", /Appeal funding sent|didn't go through|cancelled/)), await txt(p, "lookup-out"));
check("both funded: round 2 on Kleros", (await arbitrator.getNumberOfRounds(1000)) === 2n);
check("round 2 shown", /Round 2: jurors are being drawn/.test(await lookupAs(p, await addr(g3))) && !(await vis(p, "ch-box")), await txt(p, "lookup-out"));
// round 2: jurors say attended; nobody appeals; Kleros delivers the final ruling
await (await arbitrator.startAppealPeriod(1000, 1, 86400, { gasLimit: 500000 })).wait();
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
await (await arbitrator.passPeriod(1000)).wait(); await (await arbitrator.executeRuling(1000)).wait();
check("final ruling shown", /Final ruling: Yes, attended/.test(await lookupAs(p, await addr(g3))), await txt(p, "lookup-out"));
await p.click("#ch-action"); await p.waitForTimeout(1500);
check("settled after ruling", /Settled according to the Kleros ruling/.test(await waitText(p, "lookup-out", /Settled according to the Kleros ruling|didn't go through|cancelled/)), await txt(p, "lookup-out"));
check("challenger now on the list", /Challenge settled: on the attendance list/.test(await lookupAs(p, await addr(g3))), await txt(p, "lookup-out"));
check("no page errors (challenges)", p.errs.length === 0, p.errs.join("; "));
await p.close();

await browser.close(); await server.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
