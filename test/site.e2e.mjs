// Browser test of the guest deposit page (site/index.html) against ganache with a fake injected wallet: ETH deposits
// on "Ethereum mainnet" (a local chain) and attendance challenges on Kleros Court v1 through the Dispute Resolver
// (MockKlerosLiquid + MockArbitrableProxy). Each case's own description (metaevidence) comes from the contract, built
// from docs/metaevidence.template.json. Kleros's IPFS upload service and gateway are mocked in the browser, never reached.
// Needs Playwright with Chromium: npm i --no-save playwright && npx playwright install chromium
//   node test/site.e2e.mjs
import fs from "node:fs";
import path from "node:path";
import http from "node:http";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";
import { caseTemplate, ipfsCidV0 } from "../scripts/lib.mjs";
const proj = path.resolve(path.dirname(new URL(import.meta.url).pathname), "..");
const req = createRequire(path.join(proj, "package.json"));
const ganache = req("ganache");
const { ethers } = req("ethers");
let chromium;
try { ({ chromium } = req("playwright")); } catch { ({ chromium } = createRequire("/opt/node-tools/node_modules/")("playwright")); }
const E = (x) => ethers.parseEther(String(x));
const D = E("0.01"); // the deposit
const load = (n) => JSON.parse(fs.readFileSync(path.join(proj, "build", `${n}.json`), "utf8"));
const keys = Array.from({ length: 10 }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));
const RPC = 18647, WEB = 18888;
const server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
await server.listen(RPC);
const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${RPC}`, 1337, { staticNetwork: true, cacheTimeout: -1 });
// ganache's gas estimate is the exact gas used, with no margin; real wallets add one, so the fake wallet does too
const estimate = prov.estimateGas.bind(prov);
prov.estimateGas = async (tx) => ((await estimate(tx)) * 12n) / 10n;
// ga: deposits in two tabs; gx: stray deposit returned, then a real one
const [owner, g1, g2, g3, ga, gx] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const addr = async (w) => (typeof w === "string" ? w : w.target ?? w.getAddress());
const g1a = await addr(g1), g2a = await addr(g2), g3a = await addr(g3);
// poor: less than the deposit; nofee: exactly the deposit, nothing left for the network fee
const poor = new ethers.NonceManager(ethers.Wallet.createRandom().connect(prov)), nofee = new ethers.NonceManager(ethers.Wallet.createRandom().connect(prov));
await (await owner.sendTransaction({ to: await addr(poor), value: E("0.005") })).wait();
await (await owner.sendTransaction({ to: await addr(nofee), value: D })).wait();
const bal = async (w) => prov.getBalance(await addr(w));
const deployC = async (name, ...a) => (await new ethers.ContractFactory(load(name).abi, load(name).bytecode, owner).deploy(...a)).waitForDeployment();

const now = (await prov.getBlock("latest")).timestamp;
const deployBlock = await prov.getBlockNumber();
const liquid = await deployC("MockKlerosLiquid");
const proxy = await deployC("MockArbitrableProxy", liquid.target);
const otherProxy = await deployC("MockArbitrableProxy", liquid.target);
const EXTRA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 3]); // General Court, 3 jurors
const POLICY = "/ipfs/QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG/attendance-policy.md";
const FEE = await liquid.arbitrationCost(EXTRA); // 0.0162 ETH: the challenge deposit
// each Kleros case gets its own description, written by the contract from this template (docs/metaevidence.template.json)
const deploy = async (dep, resolver = proxy) => {
  const t = caseTemplate({ eventName: "E2E", depositUnits: E(dep), explorer: "https://etherscan.io", owner: await addr(owner), kleros: { policyURI: POLICY } });
  return deployC("TruthPaysKickback", E(dep), "E2E", await addr(owner), now + 86400, now + 86400 * 9, [resolver.target, EXTRA, t.pieces, t.slots, POLICY]);
};
const kick = await deploy("0.01"), bad = await deploy("0.015"), late = await deploy("0.01"), otherKleros = await deploy("0.01", otherProxy);
// someone else's case on the same Dispute Resolver first, with an appeal contribution: our case gets local ID 1 and
// arbitrator ID 1001, and the page must not mix the two up
await (await proxy.createDispute(EXTRA, "/ipfs/QmSomeoneElse", 2, { value: FEE })).wait();
await (await liquid.startAppealPeriod(1000, 1, 30 * 86400)).wait();
await (await proxy.connect(g3).fundAppeal(0, 1, { value: E("0.01") })).wait();

const outDir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-site-"));
const build = (contract, name, extra = {}) => {
  const cfg = path.join(outDir, `${name}.json`);
  fs.mkdirSync(outDir, { recursive: true });
  // logChunk 7: the page reads the history in many small chunks, like 5,000-block chunks on mainnet
  fs.writeFileSync(cfg, JSON.stringify({ eventName: "E2E", chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${RPC}`, logChunk: 7, explorer: "https://etherscan.io", deposit: "0.01", receiver: contract || "0x0000000000000000000000000000000000000001", contract, eventStart: new Date((now + 86400) * 1000).toISOString(), claimDeadline: new Date((now + 86400 * 9) * 1000).toISOString(), owner: "0x0000000000000000000000000000000000000001", deployBlock, kleros: { disputeResolver: proxy.target, arbitrator: liquid.target, policyURI: POLICY }, ...extra }));
  execFileSync("node", ["scripts/build-site.mjs", "--config", cfg, "--out", path.join(outDir, name), ...(contract ? [] : ["--preview"])], { cwd: proj, stdio: "pipe" });
};
build(kick.target, "live"); build(bad.target, "bad"); build(late.target, "late"); build(otherKleros.target, "otherkleros"); build("", "preview");
http.createServer((rq, rs) => { if (!/^\/(live|bad|preview|late|otherkleros|case2|case3)?$/.test(rq.url)) { rs.writeHead(404); return rs.end(); } const f = path.join(outDir, rq.url.split("/")[1] || "live", "index.html"); rs.writeHead(200, { "content-type": "text/html" }); rs.end(fs.readFileSync(f)); }).listen(WEB);

const results = [];
const check = (name, ok, extra = "") => { results.push(ok); console.log(`${ok ? "PASS" : "FAIL"} ${name} ${ok ? "" : extra}`); };
const browser = await chromium.launch();
const allSent = []; // every transaction any page asked the wallet to send
const order = []; // uploads and transactions of every page, in the order they happened
// Kleros's IPFS upload service, mocked: every upload is recorded, and answers like the real one ({ cids: [...] })
// unless ipfs.mode says "fail" (HTTP 500), "odd" (no IPFS address in the answer), "other" (a case description
// saved at another address than the one the contract computed) or "hang" (no answer for 5 s, then HTTP 500; ipfs.hung
// counts them). A case description ("metaevidence.json") gets the real CIDv0 of its bytes, as a bare "/ipfs/<cid>"
// like the real service; other files a made-up CID and their name.
// Kleros's IPFS gateway (cdn.kleros.link), mocked: it serves what was uploaded, by path, and 404 for anything else.
const ipfs = { mode: "ok", uploads: [], store: new Map(), hung: 0 };
const cidFor = (n) => "Qm" + `TestCid${"abcdefghijkmnpqrstuvwxyz"[n % 24]}`.padEnd(44, "Z");
const CORS = { "access-control-allow-origin": "*" };
// opts: failLogs (every log query fails, on the public RPC and in the wallet), logRange (log queries over more blocks
// are refused, like a range-limited RPC), clockAt (the browser's clock, in unix seconds: the chain's clock after
// evm_increaseTime), smart (a TestWallet: the page sees its address and transactions go through its exec, like a
// smart-account wallet), invalidOpcode (an address: the Dispute Resolver read through a geth node. It is built with
// Solidity 0.7, where a read past the end of a list (disputeIDtoRoundArray) or a Panic-type failure hits the INVALID
// opcode, which geth reports as {code: -32000, message: "invalid opcode: INVALID"} with no data; on the public RPC and
// in the wallet; page.invalidOps counts them), rateLimit (the public RPC refuses the first n log queries as a busy
// RPC does: HTTP 429, or a "rate limit exceeded" error; page.logRanges lists every log query), holdTx (the wallet
// signs a transaction and returns its hash without sending it, as if it were still waiting in the mempool; the signed
// transactions are in page.held), rejectConnect (the wallet refuses the first n connection requests), lateWallet (the
// wallet is only added when the test calls window.__inject(), like a wallet app's browser that adds it late),
// confirmDelay (ms the wallet takes before sending a transaction, like a guest reading the prompt), clockInstall (the
// browser's timers are Playwright's fake clock, running at normal speed until the test calls page.clock.fastForward).
// page.bigEstimate = true: every gas estimate the page asks the public RPC for answers 13.6 million gas.
const asSolc07 = (data, e) => { let s = ""; try { s = JSON.stringify(e); } catch {} return /^0x3ef40ba7/.test(String(data)) || /4e487b71/.test(s + String(e && e.message)); };
async function open(site, wallet, startChain = 1337, opts = {}) {
  const page = await browser.newPage();
  const errs = []; page.on("pageerror", (e) => errs.push(e.message));
  let chain = startChain, signer = wallet, me = opts.smart ? await addr(opts.smart) : wallet ? await addr(wallet) : null;
  let rejects = opts.rejectConnect || 0, limited = opts.rateLimit || 0;
  Object.assign(page, { sent: [], held: [], invalidOps: 0, logRanges: [], limited: 0 });
  const refused = (f) => opts.failLogs || (opts.logRange && parseInt(f.toBlock, 16) - parseInt(f.fromBlock, 16) > opts.logRange);
  await page.exposeFunction("__rpc", async (method, params) => {
    if (method === "eth_requestAccounts" && rejects > 0) { rejects--; throw new Error("User rejected the request."); }
    if (method === "eth_requestAccounts" || method === "eth_accounts") return [me];
    if (method === "eth_chainId") return "0x" + chain.toString(16);
    if (method === "wallet_switchEthereumChain") { chain = parseInt(params[0].chainId, 16); return null; }
    if (method === "eth_sendTransaction") {
      const t = params[0]; page.sent.push(t); allSent.push(t); order.push({ tx: t.data.slice(0, 10), to: t.to.toLowerCase() });
      // like MetaMask: a request pinned to another network than the wallet's is refused
      if (t.chainId !== undefined && parseInt(t.chainId, 16) !== chain) throw new Error("Invalid chainId for the current network");
      if (opts.confirmDelay) await new Promise((r) => setTimeout(r, opts.confirmDelay));
      const value = t.value ? BigInt(t.value) : 0n;
      if (opts.smart) return (await opts.smart.connect(signer).exec(t.to, t.data, { value })).hash;
      if (opts.holdTx) { const raw = await signer.signTransaction(await signer.populateTransaction({ to: t.to, data: t.data, value })); page.held.push(raw); return ethers.keccak256(raw); }
      // a gas limit set by the page is used as it is, like real wallets do
      return (await signer.sendTransaction({ to: t.to, data: t.data, value, ...(t.gas ? { gasLimit: BigInt(t.gas) } : {}) })).hash;
    }
    if (method === "eth_getLogs" && refused(params[0])) throw new Error("wallet RPC: log range not allowed");
    if (method === "eth_call" && opts.invalidOpcode && String(params[0].to).toLowerCase() === opts.invalidOpcode.toLowerCase())
      try { return await prov.send(method, params); } catch (e) { if (asSolc07(params[0].data, e)) { page.invalidOps++; throw new Error("invalid opcode: INVALID"); } throw e; }
    return prov.send(method, params ?? []);
  });
  await page.route((u) => u.port === String(RPC), async (route) => {
    let body = null;
    try { body = JSON.parse(route.request().postData() || "null"); } catch {}
    const fail = (error) => route.fulfill({ status: 200, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, error }) });
    if (body && body.method === "eth_getLogs") {
      const [a, b] = [parseInt(body.params[0].fromBlock, 16), parseInt(body.params[0].toBlock, 16)];
      page.logQueries = (page.logQueries || 0) + 1; page.maxLogRange = Math.max(page.maxLogRange || 0, b - a + 1); page.logRanges.push([a, b]);
      if (limited > 0) {
        page.limited++;
        if (limited-- % 2) return route.fulfill({ status: 429, headers: { "content-type": "text/plain", ...CORS }, body: "Too Many Requests" });
        return fail({ code: -32005, message: "rate limit exceeded, retry later" });
      }
    }
    if (body && body.method === "eth_getLogs" && refused(body.params[0])) return fail({ code: -32005, message: "block range too large" });
    if (body && body.method === "eth_estimateGas" && page.bigEstimate)
      return route.fulfill({ status: 200, headers: { "content-type": "application/json", ...CORS }, body: JSON.stringify({ jsonrpc: "2.0", id: body.id, result: "0xd00000" }) });
    if (body && body.method === "eth_call" && opts.invalidOpcode && String(body.params[0].to).toLowerCase() === opts.invalidOpcode.toLowerCase()) {
      const res = await route.fetch(), j = await res.json();
      if (j.error && asSolc07(body.params[0].data, j.error)) { page.invalidOps++; return fail({ code: -32000, message: "invalid opcode: INVALID" }); }
      return route.fulfill({ response: res, body: JSON.stringify(j) });
    }
    return route.continue();
  });
  await page.route("https://kleros-api.netlify.app/**", async (route) => {
    const rq = route.request(), url = new URL(rq.url());
    const headers = { "content-type": "application/json", ...CORS };
    if (ipfs.mode === "fail") return route.fulfill({ status: 500, headers, body: JSON.stringify({ message: "Pinning failed" }) });
    if (ipfs.mode === "hang") { ipfs.hung++; await new Promise((r) => setTimeout(r, 5000)); return route.fulfill({ status: 500, headers, body: "{}" }).catch(() => {}); }
    const raw = rq.postDataBuffer() || Buffer.alloc(0), body = raw.toString("latin1");
    const file = (body.match(/filename="([^"]*)"/) || [])[1] || "";
    // the file's own bytes: the first part of the multipart body, between its headers and the next boundary
    const boundary = ((rq.headers()["content-type"] || "").match(/boundary=(.+)$/) || [])[1];
    const from = body.indexOf("\r\n\r\n") + 4, to = boundary ? body.indexOf(`\r\n--${boundary}`, from) : -1;
    const data = to > from ? Buffer.from(body.slice(from, to), "latin1") : Buffer.alloc(0);
    const n = ipfs.uploads.length, meta = file === "metaevidence.json";
    const at = meta ? (ipfs.mode === "other" ? `/ipfs/${cidFor(n)}` : `/ipfs/${ipfsCidV0(data)}`) : `/ipfs/${cidFor(n)}/${file}`;
    ipfs.uploads.push({ operation: url.searchParams.get("operation"), pinToGraph: url.searchParams.get("pinToGraph"), method: rq.method(), field: (body.match(/name="([^"]*)"/) || [])[1], file, body, data, cid: cidFor(n), path: at });
    order.push({ upload: file });
    if (ipfs.mode === "odd") return route.fulfill({ status: 200, headers, body: JSON.stringify({ message: "File has been stored successfully" }) });
    ipfs.store.set(at, data);
    return route.fulfill({ status: 200, headers, body: JSON.stringify({ message: "File has been stored successfully", cids: [meta ? at : `ipfs://${cidFor(n)}/${file}`], inconsistentCids: [] }) });
  });
  await page.route("https://cdn.kleros.link/**", (route) => {
    const data = ipfs.store.get(new URL(route.request().url()).pathname);
    return data ? route.fulfill({ status: 200, headers: { "content-type": "application/octet-stream", ...CORS }, body: data }) : route.fulfill({ status: 404, headers: CORS, body: "not found" });
  });
  if (wallet) await page.addInitScript((late) => {
    const listeners = {};
    const provider = { request: ({ method, params }) => window.__rpc(method, params), on(ev, f) { (listeners[ev] = listeners[ev] || []).push(f); }, removeListener() {} };
    window.__emit = (ev, arg) => (listeners[ev] || []).forEach((f) => f(arg));
    if (late) window.__inject = () => { window.ethereum = provider; dispatchEvent(new Event("ethereum#initialized")); };
    else window.ethereum = provider;
  }, !!opts.lateWallet);
  if (opts.clockAt) await page.clock.setFixedTime(new Date(opts.clockAt * 1000));
  if (opts.clockInstall) await page.clock.install();
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
const waitText = async (pg, id, re) => { for (let i = 0; i < 60 && !re.test(await txt(pg, id)); i++) await pg.waitForTimeout(250); return txt(pg, id); };
// waits until step 3 is done checking the wallet (balance and earlier deposits)
const settle = async (pg) => { for (let i = 0; i < 80; i++) { await pg.waitForTimeout(200); if (!/^Checking/.test(await txt(pg, "check-msg"))) break; } await pg.waitForTimeout(200); };
const connect = async (pg) => { await pg.click("#connect"); await settle(pg); };
const lookupAs = async (pg, who) => {
  await toStatus(pg); await pg.fill("#lookup-addr", who); await pg.click("#lookup");
  for (let i = 0; i < 80; i++) { await pg.waitForTimeout(150); if (!/^Checking/.test(await txt(pg, "lookup-out"))) break; }
  await pg.waitForTimeout(300);
  return txt(pg, "lookup-out");
};
const ENDED = /Done|failed|cancelled|Nothing was sent|Couldn't|didn't go through|would fail/;
const sendDeposit = async (pg) => { await toDeposit(pg); await pg.click("#send"); return waitText(pg, "send-msg", ENDED); };
const linkHref = (pg) => pg.locator("#lookup-out a").first().getAttribute("href");
const deposits = async (c, who) => (await c.queryFilter(c.filters.Deposited(who))).map((e) => e.args.amount);

// 1. preview, and no live page without a deploy block
let p = await open("preview", null);
check("preview: 'opens soon' shown", await vis(p, "preview"));
check("preview: connect disabled", await dis(p, "connect"));
check("preview: the deposit amount comes from the config", /Send exactly 0\.01 ETH/.test(await p.locator("#s-send h2").innerText()) && /get your 0\.01 ETH back/.test(await p.locator("footer").innerText()));
check("preview: warns Ethereum mainnet only, not Arbitrum, Base or Optimism", /Ethereum mainnet only\..*not on Arbitrum, Base, Optimism or any other network.*would be lost/s.test(await p.locator(".network").innerText()));
check("preview: ETH only, a token (USDC) sent there is not a deposit", /ETH only: USDC or any other token sent to this address is not a deposit and books no spot/.test(await p.locator(".network").innerText()), await p.locator(".network").innerText());
await p.close();
let refusedBuild = false;
try { build(kick.target, "nodeploy", { deployBlock: "" }); } catch (e) { refusedBuild = /deployBlock/.test(String(e.stderr)); }
check("build-site refuses a live page without deployBlock", refusedBuild);
let refusedUsdc = false;
try { build(kick.target, "usdc", { token: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831" }); } catch (e) { refusedUsdc = /token/.test(String(e.stderr)); }
check("build-site refuses an old USDC config", refusedUsdc);
const baked = fs.readFileSync(path.join(outDir, "live", "index.html"), "utf8");
check("built page: ETH deposit in wei, Kleros v1 addresses and IPFS service baked in, no USDC", baked.includes(`"depositWei": "${D}"`) && baked.includes(`"klerosResolver": "${proxy.target}"`) && baked.includes(`"klerosArbitrator": "${liquid.target}"`)
  && baked.includes('"ipfsUpload": "https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs"') && baked.includes('"logChunk": 7') && !/"usdc"|"decimals"|klerosDisputeKit|klerosEvidenceModule/.test(baked));

// 2. wrong deposit contract, and a contract wired to another Dispute Resolver
p = await open("bad", g1);
check("bad contract: amount check fails", /deposit amount is 0\.015 ETH, not 0\.01 ETH/.test(await txt(p, "checks")), await txt(p, "checks"));
await connect(p);
check("bad contract: send disabled", await dis(p, "send"));
await p.close();
p = await open("otherkleros", g1);
check("contract with another dispute service: check fails", /different dispute service/.test(await txt(p, "checks")), await txt(p, "checks"));
await connect(p);
check("contract with another dispute service: send disabled", await dis(p, "send"));
await p.close();

// 3. happy path from the wrong network (Arbitrum One)
p = await open("live", g1, 42161);
check("live: all checks pass", (await p.locator("#checks .mark.ok").count()) === 4, await txt(p, "checks"));
check("live: Kleros check and Etherscan link", /disputes go to Kleros Court/.test(await txt(p, "checks")) && (await p.locator("#contract-link").getAttribute("href")) === `https://etherscan.io/address/${kick.target}`);
await connect(p);
check("wrong network warning names Arbitrum One", /You're on Arbitrum One.*would be lost.*Switch to Ethereum mainnet/.test(await txt(p, "net-wrong")), await txt(p, "net-wrong"));
check("send disabled on wrong network", await dis(p, "send"));
await p.click("#switch"); await settle(p);
check("switched: pill shows the page's network", /network 1337/.test(await txt(p, "net-pill")), await txt(p, "net-pill"));
check("balance shown in ETH", (await txt(p, "bal-eth")) === "100 ETH", await txt(p, "bal-eth"));
check("network fee estimate shown", /^about 0\.0001 ETH$/.test(await txt(p, "fee-eth")), await txt(p, "fee-eth"));
check("send enabled", !(await dis(p, "send")));
const g1Before = await bal(g1);
check("send success message", /Done\. 0\.01 ETH received/.test(await sendDeposit(p)), await txt(p, "send-msg"));
check("tx link shown for Luma", /^https:\/\/etherscan\.io\/tx\/0x[0-9a-f]{64}$/.test(await txt(p, "tx-link")), await txt(p, "tx-link"));
check("contract holds exactly 0.01 ETH", (await bal(kick)) === D);
const depTx = p.sent[0], depRcpt = await prov.getTransactionReceipt(depTx ? (await txt(p, "tx-link")).split("/").pop() : ethers.ZeroHash);
check("guest paid exactly 0.01 ETH plus the network fee", (await bal(g1)) === g1Before - D - depRcpt.fee);
check("deposit is a deposit() call with exactly the deposit, pinned to the network (chainId)", p.sent.length === 1 && depTx.to.toLowerCase() === kick.target.toLowerCase() && depTx.data === "0xd0e30db0" && BigInt(depTx.value) === D && depTx.chainId === "0x539", JSON.stringify(p.sent));
check("contract logged the deposit", (await deposits(kick, g1a)).join() === String(D));
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

// 3b. connecting: the wallet refuses the first request, then connects (the error goes away); a wallet app's browser
// that adds its wallet after the page loaded (the "no wallet" note goes away)
const gaa = await addr(ga);
p = await open("live", ga, 1337, { rejectConnect: 1 });
await p.click("#connect"); await p.waitForTimeout(300);
const refusedNote = (await vis(p, "no-wallet")) ? await txt(p, "no-wallet") : "";
await connect(p);
check("wallet refused, then connected: the error note is gone", /The wallet didn't connect: User rejected the request/.test(refusedNote) && !(await vis(p, "no-wallet")) && (await txt(p, "who")).toLowerCase() === gaa.toLowerCase(), refusedNote);
await p.close();
p = await open("live", ga, 1337, { lateWallet: true });
const noWalletNote = (await vis(p, "no-wallet")) && /No wallet found in this browser/.test(await txt(p, "no-wallet"));
await p.evaluate(() => window.__inject()); await p.waitForTimeout(200);
const goneOnceAdded = !(await vis(p, "no-wallet"));
await connect(p);
check("wallet added late by the wallet app: 'no wallet' shown, gone once it appears, and connecting works", noWalletNote && goneOnceAdded && (await txt(p, "who")).toLowerCase() === gaa.toLowerCase() && !(await vis(p, "no-wallet")), `${noWalletNote} ${goneOnceAdded}`);
check("no page errors (connecting)", p.errs.length === 0, p.errs.join("; "));
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
check("status page: today's Kleros fee and the jurors' policy linked", /0\.0162 ETH today/.test(await txt(p, "fee-now")) && (await p.locator("#policy-link a").getAttribute("href")) === `https://cdn.kleros.link${POLICY}`, await txt(p, "fee-now"));
check("lookup: deposit received, waiting review", /Waiting for the hosts/.test(await lookupAs(p, g1a)), await txt(p, "lookup-out"));
check("no page errors (range-limited RPC)", p.errs.length === 0, p.errs.join("; "));
await p.close();
// the history is read in chunks of logChunk blocks (7 here), never in one long range
p = await open("live", g1);
await connect(p);
const span = (await prov.getBlockNumber()) - deployBlock + 1;
check("history read in logChunk-sized ranges", /already see a deposit/.test(await txt(p, "check-msg")) && p.logQueries >= Math.ceil(span / 7) && span > 7 && p.maxLogRange <= 7, `${p.logQueries} queries over ${span} blocks, longest ${p.maxLogRange} blocks`);
await p.close();
// 4a. a busy public RPC (HTTP 429, "rate limit exceeded") and no wallet to fall back on: the same chunk is asked again
// after a pause, never split into smaller ranges (that would only send more requests), and the history is read
p = await open("live", null, 1337, { rateLimit: 6 });
const busyOut = await lookupAs(p, g1a);
const unsplit = p.logRanges.length > 0 && p.logRanges.every(([a, b]) => (a - deployBlock) % 7 === 0 && b - a <= 6);
check("busy RPC: asked again after a pause, chunks not split, history read", /Waiting for the hosts/.test(busyOut) && p.limited === 6 && unsplit, `${busyOut} | ${JSON.stringify(p.logRanges)}`);
check("no page errors (busy RPC)", p.errs.length === 0, p.errs.join("; "));
await p.close();

// 4b. the deposit history can't be read: unknown, never "no deposit"
p = await open("live", g3, 1337, { failLogs: true });
await connect(p);
check("history unreadable: send blocked, asks to reload", /Couldn't check for an earlier deposit\. Reload the page\./.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
let out = await lookupAs(p, g3a);
check("history unreadable: lookup says it couldn't check", /Couldn't check this wallet's deposits/.test(out) && !/No deposit found/.test(out), out);
await p.close();

// 4c. the same wallet in two tabs: the second tab re-checks right before the wallet prompt
const pA = await open("live", ga), pB = await open("live", ga);
await connect(pA); await connect(pB);
check("two tabs: both offer Send at first", !(await dis(pA, "send")) && !(await dis(pB, "send")));
const held = await bal(kick);
check("two tabs: first deposit sent", /Done/.test(await sendDeposit(pA)), await txt(pA, "send-msg"));
const second = await sendDeposit(pB);
check("two tabs: second tab refuses a second deposit", /already see a deposit/.test(second) && /Nothing was sent/.test(second) && pB.sent.length === 0 && (await bal(kick)) === held + D, second);
await pB.close();
// 4d. switching accounts in the wallet: nothing of the previous account's deposit carries over
const gaLink = await txt(pA, "tx-link");
await pA.switchAccount(g3); await settle(pA);
check("account switch: old link and send note cleared", !(await vis(pA, "luma-box")) && !(await vis(pA, "send-msg")) && (await txt(pA, "who")).toLowerCase() === g3a.toLowerCase(), await txt(pA, "check-msg"));
check("account switch: the new wallet can send", !(await dis(pA, "send")), await txt(pA, "check-msg"));
await pA.switchAccount(ga); await settle(pA);
check("account switch back: its deposit found again", /already see a deposit/.test(await txt(pA, "check-msg")) && (await txt(pA, "tx-link")) === gaLink && (await dis(pA, "send")), await txt(pA, "check-msg"));
check("no page errors (two tabs, account switch)", pA.errs.length === 0, pA.errs.join("; "));
await pA.close();

// 5. not enough ETH: less than the deposit, or the deposit but nothing for the network fee
p = await open("live", poor);
await connect(p);
check("poor: needs 0.01 ETH on Ethereum mainnet", /You need 0\.01 ETH on Ethereum mainnet.*Arbitrum, Base, Optimism/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("poor: send disabled", await dis(p, "send"));
await p.close();
p = await open("live", nofee);
await connect(p);
check("deposit but no fee money: asks for a little more ETH", /not enough left for the network fee/.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
await p.close();

// 6. register g1, reject g2 after a plain-transfer deposit
await (await g2.sendTransaction({ to: kick.target, value: D })).wait();
const k = kick.connect(owner);
await (await k.registerStakers([g1a])).wait();
await (await k.rejectAndRefund([g2a])).wait();
p = await open("live", g1);
await connect(p);
check("registered: confirmed spot message", /confirmed spot/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
check("registered: send disabled", await dis(p, "send"));
check("lookup registered: spot confirmed", /Spot confirmed/.test(await lookupAs(p, g1a)), await txt(p, "lookup-out"));
check("lookup rejected: refunded", /Refunded/.test(await lookupAs(p, g2a)), await txt(p, "lookup-out"));
await toStatus(p); await p.fill("#lookup-addr", "0x123"); await p.click("#lookup"); await p.waitForTimeout(300);
check("lookup bad address error", /isn't a wallet address/.test(await txt(p, "lookup-out")));
check("stats: 1 spot, ETH held", /1 spot confirmed/.test(await txt(p, "stats")) && /0\.02 ETH held in the contract/.test(await txt(p, "stats")), await txt(p, "stats"));
await p.close();

// 6b. a stray deposit returned with refund() ("Return a stray transfer"), then a real deposit
const stray = await (await gx.sendTransaction({ to: kick.target, value: D })).wait();
await (await k.refund(await addr(gx), D)).wait();
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

// 6c. a payment below the deposit: the page says so (not "no deposit found") and asks for a full deposit
const fundNew = async () => { const w = ethers.Wallet.createRandom().connect(prov); await (await owner.sendTransaction({ to: w.address, value: E("1") })).wait(); return w; };
const gs = new ethers.NonceManager(await fundNew()), gsa = await addr(gs);
await (await gs.sendTransaction({ to: kick.target, value: E("0.005") })).wait();
p = await open("live", gs);
await connect(p);
const shortRe = /We see 0\.005 ETH from this wallet, less than the 0\.01 ETH deposit: send a full 0\.01 ETH deposit; the hosts return the short payment\./;
check("short payment: the deposit step says so, and a full deposit can be sent", shortRe.test(await txt(p, "check-msg")) && !(await dis(p, "send")) && !(await vis(p, "luma-box")), await txt(p, "check-msg"));
out = await lookupAs(p, gsa);
check("short payment: the lookup says so, not 'no deposit found'", shortRe.test(out) && !/No deposit found/.test(out), out);
await p.close();
// a full deposit, then a stray 0.004 ETH transfer the hosts return ("Return a stray transfer"): the return covers the
// stray transfer, not the older deposit (as the verify script pairs them), so the deposit still counts
const gr = new ethers.NonceManager(await fundNew()), gra = await addr(gr);
const grDep = await (await gr.sendTransaction({ to: kick.target, data: "0xd0e30db0", value: D })).wait();
await (await gr.sendTransaction({ to: kick.target, value: E("0.004") })).wait();
await (await k.refund(gra, E("0.004"))).wait();
const grLink = `https://etherscan.io/tx/${grDep.hash}`;
p = await open("live", gr);
await connect(p);
check("deposit, then a stray transfer returned: the deposit still counts, Send blocked, its link offered", /already see a deposit/.test(await txt(p, "check-msg")) && !/less than the/.test(await txt(p, "check-msg"))
  && (await dis(p, "send")) && (await vis(p, "luma-box")) && (await txt(p, "tx-link")) === grLink, await txt(p, "check-msg"));
out = await lookupAs(p, gra);
check("deposit, then a stray transfer returned: lookup says deposit received and links it", /Deposit received/.test(out) && !/less than the/.test(out) && (await linkHref(p)) === grLink, out);
await p.close();

// 6d. a deposit still waiting for confirmation when the page reloads: Send stays blocked and its link is offered, and
// the page keeps checking: once it is confirmed the deposit history takes over, without a reload. A saved deposit that
// failed, that the wallet replaced (sped up or cancelled), or that the network never saw (30 minutes on), is forgotten.
const gp = await fundNew();
p = await open("live", gp, 1337, { holdTx: true });
await connect(p);
await toDeposit(p); await p.click("#send");
await waitText(p, "send-msg", /Waiting for Ethereum mainnet to confirm|failed|cancelled|Nothing was sent/);
const heldHash = p.held.length === 1 ? ethers.keccak256(p.held[0]) : "none";
const savedTx = await p.evaluate(() => JSON.parse(localStorage.getItem("gt-last-tx") || "{}"));
check("deposit sent: saved in the browser (with its nonce) as soon as the wallet gives its hash", savedTx.hash === heldHash && String(savedTx.account).toLowerCase() === gp.address.toLowerCase() && savedTx.contract === kick.target
  && savedTx.nonce === 0 && !(await prov.getTransactionReceipt(heldHash)), JSON.stringify(savedTx));
await p.reload(); await p.waitForTimeout(800); await connect(p);
check("reloaded while it is waiting for confirmation: Send blocked, its link offered for Luma", /Your deposit .+ is waiting for Ethereum mainnet to confirm it\. Don't send another one/.test(await txt(p, "check-msg")) && (await dis(p, "send"))
  && (await txt(p, "tx-link")) === `https://etherscan.io/tx/${heldHash}` && p.sent.length === 1, await txt(p, "check-msg"));
await (await prov.broadcastTransaction(p.held[0])).wait();
out = await waitText(p, "check-msg", /already see a deposit/);
check("confirmed while the page is open: it updates by itself, Send blocked, same link", /already see a deposit/.test(out) && (await dis(p, "send")) && (await txt(p, "tx-link")) === `https://etherscan.io/tx/${heldHash}`, out);
await p.reload(); await p.waitForTimeout(800); await connect(p);
check("confirmed: the deposit history shows it, Send blocked, same link", /already see a deposit/.test(await txt(p, "check-msg")) && (await dis(p, "send")) && (await txt(p, "tx-link")) === `https://etherscan.io/tx/${heldHash}`, await txt(p, "check-msg"));
check("no page errors (deposit waiting for confirmation)", p.errs.length === 0, p.errs.join("; "));
await p.close();
const gf = await fundNew();
const failedDep = await gf.sendTransaction({ to: kick.target, data: "0xd0e30db0", value: 0, gasLimit: 100000 }); // deposit() of nothing: fails
await failedDep.wait().catch(() => {});
p = await open("live", gf);
const saveTx = (hash, at) => p.evaluate(([h, a, c, t]) => localStorage.setItem("gt-last-tx", JSON.stringify({ hash: h, account: a, contract: c, at: Date.now() - t })), [hash, gf.address, kick.target, at]);
await saveTx(failedDep.hash, 0); await p.reload(); await p.waitForTimeout(800); await connect(p);
check("a saved deposit that failed on-chain is forgotten: Send allowed", (await prov.getTransactionReceipt(failedDep.hash)).status === 0 && /All set/.test(await txt(p, "check-msg")) && !(await dis(p, "send"))
  && (await p.evaluate(() => localStorage.getItem("gt-last-tx"))) === null, await txt(p, "check-msg"));
await saveTx("0x" + "ab".repeat(32), 31 * 60e3); await p.reload(); await p.waitForTimeout(800); await connect(p);
check("a saved deposit the network still doesn't know 30 minutes on is forgotten: Send allowed", !(await dis(p, "send")) && (await p.evaluate(() => localStorage.getItem("gt-last-tx"))) === null, await txt(p, "check-msg"));
await saveTx("0x" + "cd".repeat(32), 60e3); await p.reload(); await p.waitForTimeout(800); await connect(p);
check("... but a minute on it may still be on its way: Send blocked", (await dis(p, "send")) && /waiting for Ethereum mainnet to confirm/.test(await txt(p, "check-msg")), await txt(p, "check-msg"));
await p.evaluate(() => localStorage.removeItem("gt-last-tx"));
await p.close();
// the wallet sped the deposit up (same nonce, higher fee, new hash): once the faster one is in, the page notices by
// itself, shows that one and forgets the first; the same after a reload
const sendHeld = async (w) => {
  const pg = await open("live", w, 1337, { holdTx: true });
  await connect(pg); await toDeposit(pg); await pg.click("#send");
  await waitText(pg, "send-msg", /Waiting for Ethereum mainnet to confirm|failed|cancelled|Nothing was sent/);
  await pg.reload(); await pg.waitForTimeout(800); await connect(pg);
  return pg;
};
const gq = await fundNew();
p = await sendHeld(gq);
const slow = ethers.Transaction.from(p.held[0]);
const fast = await gq.signTransaction({ type: slow.type, chainId: slow.chainId, nonce: slow.nonce, to: slow.to, data: slow.data, value: slow.value, gasLimit: slow.gasLimit,
  ...(slow.type === 2 ? { maxFeePerGas: slow.maxFeePerGas * 2n, maxPriorityFeePerGas: slow.maxPriorityFeePerGas * 2n + 1n } : { gasPrice: slow.gasPrice * 2n }) });
const fastLink = `https://etherscan.io/tx/${ethers.keccak256(fast)}`;
check("sped up: the first one waits for confirmation at first", /is waiting for Ethereum mainnet to confirm it/.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
await (await prov.broadcastTransaction(fast)).wait();
out = await waitText(p, "check-msg", /already see a deposit/);
check("sped up in the wallet: the page notices by itself, shows the faster deposit, forgets the first", /already see a deposit/.test(out) && (await txt(p, "tx-link")) === fastLink && (await dis(p, "send"))
  && (await p.evaluate(() => localStorage.getItem("gt-last-tx"))) === null, `${out} | ${await txt(p, "tx-link")}`);
await p.reload(); await p.waitForTimeout(800); await connect(p);
check("sped up, after a reload: the faster deposit only", /already see a deposit/.test(await txt(p, "check-msg")) && (await txt(p, "tx-link")) === fastLink && (await dis(p, "send")), await txt(p, "check-msg"));
check("no page errors (sped up)", p.errs.length === 0, p.errs.join("; "));
await p.close();
// the wallet cancelled it (another transaction, an empty one to itself, used its nonce): forgotten, Send allowed
const gk = await fundNew();
p = await sendHeld(gk);
const keptTx = await p.evaluate(() => JSON.parse(localStorage.getItem("gt-last-tx") || "{}"));
await (await gk.sendTransaction({ to: gk.address, value: 0, nonce: 0 })).wait();
await p.reload(); await p.waitForTimeout(800); await connect(p);
check("cancelled in the wallet (a later transaction used its nonce): forgotten, Send allowed", keptTx.nonce === 0 && /All set/.test(await txt(p, "check-msg")) && !(await dis(p, "send")) && !(await vis(p, "luma-box"))
  && (await p.evaluate(() => localStorage.getItem("gt-last-tx"))) === null, await txt(p, "check-msg"));
await p.close();
// the history can't be read: a confirmed deposit saved in this browser isn't taken for granted (the hosts declined
// and refunded this one), so the page doesn't say it was sent and Send stays blocked
const g2Dep = (await kick.queryFilter(kick.filters.Deposited(g2a)))[0].transactionHash;
p = await open("live", g2, 1337, { failLogs: true });
await p.evaluate(([h, a, c]) => localStorage.setItem("gt-last-tx", JSON.stringify({ hash: h, account: a, contract: c, at: Date.now(), nonce: 0 })), [g2Dep, g2a, kick.target]);
await p.reload(); await p.waitForTimeout(800); await connect(p);
check("history unreadable, a refunded deposit saved in the browser: not shown as sent, Send blocked", /Couldn't check for an earlier deposit/.test(await txt(p, "check-msg")) && !/Deposit sent/.test(await txt(p, "check-msg"))
  && (await dis(p, "send")) && !(await vis(p, "luma-box")), await txt(p, "check-msg"));
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
out = await lookupAs(p, g2a);
check("lookup refunded + new deposit: waiting for review", /Refunded earlier\. A new deposit/.test(out) && (await linkHref(p)) === g2Link, out);
await p.close();

// 7b. a declined guest whose wallet contract refuses ETH: the refund waits in the contract, claimed to another address
const smart = await deployC("TestWallet");
await (await smart.exec(kick.target, kick.interface.encodeFunctionData("deposit"), { value: D })).wait();
await (await smart.setMode(1)).wait(); // refuse ETH
await (await k.rejectAndRefund([smart.target], { gasLimit: 500000 })).wait();
check("undelivered refund kept for the guest", (await kick.owed(smart.target)) === D);
p = await open("live", owner, 1337, { smart, failLogs: true });
await connect(p);
check("undelivered refund, history unreadable: the deposit page still points to the claim", /0\.01 ETH refund couldn't be delivered/.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
await p.close();
p = await open("live", owner, 1337, { smart });
await connect(p);
check("undelivered refund: deposit page points to the claim, Send blocked", /0\.01 ETH refund couldn't be delivered/.test(await txt(p, "check-msg")) && (await dis(p, "send")), await txt(p, "check-msg"));
out = await lookupAs(p, smart.target);
check("lookup declined + owed: waiting to be claimed, claim offered", /waiting to be claimed/.test(out) && !/went back to this wallet/.test(out) && (await vis(p, "claim-owed")) && !(await vis(p, "claim-emergency")), out);
const drop = ethers.Wallet.createRandom().address;
await p.fill("#claim-to", drop); await p.click("#claim-owed");
check("undelivered refund claimed to another address", /Done/.test(await waitText(p, "lookup-out", /Done|didn't go through|cancelled|would fail/)) && (await bal(drop)) === D && (await kick.owed(smart.target)) === 0n && p.sent.at(-1).data === "0x1e83409a" + drop.slice(2).toLowerCase().padStart(64, "0"), await txt(p, "lookup-out"));
await p.close();

// 8. after the event: list posted (g1 only), g3 challenges, g2 disputes it, evidence via IPFS, appeals funded on the
// Dispute Resolver, payouts released while the case is open, the ruling delivered from the page, anyone settles,
// funders collect from Kleros
await (await g3.sendTransaction({ to: kick.target, value: D })).wait();
await (await k.registerStakers([g3a])).wait();
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
await (await k.postAttendance([g1a], 2n * D)).wait();
p = await open("live", g3);
check("listed: checks say list published", /attendance list is published/.test(await txt(p, "checks")), await txt(p, "checks"));
await connect(p);
check("listed: lookup off-list offers challenge", /Not on the attendance list/.test(await lookupAs(p, g3a)) && /^Challenge \(0\.0162 ETH\)$/.test(await txt(p, "ch-action")), `${await txt(p, "lookup-out")} | ${await txt(p, "ch-action")}`);
check("listed, window running: no Release payouts button", !(await vis(p, "release-box")));
await p.click("#ch-action");
check("challenge sent", /Challenge sent/.test(await waitText(p, "lookup-out", /Challenge sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("challenge recorded on-chain with the Kleros fee", Number((await kick.challenges(g3a)).state) === 1 && (await kick.challenges(g3a)).deposit === FEE && BigInt(p.sent.at(-1).value) === FEE);
check("an ordinary transaction leaves the gas limit to the wallet", p.sent.at(-1).gas === undefined, JSON.stringify(p.sent.at(-1)));
// right after the challenge, the page saves the jurors' case description on IPFS: exactly the text the contract
// writes for this wallet, at the IPFS address the contract computed (and sends to Kleros when the challenge is matched)
out = await waitText(p, "lookup-out", /saved on IPFS|Couldn't save the case description/);
const [g3Case, g3CaseUri] = await kick.caseMetaEvidence(g3a);
const metaUps = () => ipfs.uploads.filter((u) => u.file === "metaevidence.json");
const caseLink = (pg) => pg.locator("#lookup-out a", { hasText: "case description" }).first().getAttribute("href");
check("contract: the case description names the wallet and the deposit contract, at its CIDv0 address", g3Case.includes(g3a) && g3Case.includes(kick.target) && JSON.parse(g3Case).fileURI === POLICY && g3CaseUri === `/ipfs/${ipfsCidV0(g3Case)}`, g3CaseUri);
check("challenge: case description saved on IPFS (operation=file), byte for byte the contract's text, at the contract's address",
  /The case description jurors would read is saved on IPFS/.test(out) && (await caseLink(p)) === `https://cdn.kleros.link${g3CaseUri}` && metaUps().length === 1 && metaUps()[0].operation === "file" && metaUps()[0].field === "data"
  && metaUps()[0].pinToGraph === "false" && metaUps()[0].data.equals(Buffer.from(g3Case, "utf8")) && metaUps()[0].path === g3CaseUri && order.findIndex((o) => o.upload === "metaevidence.json") > order.findIndex((o) => o.tx === "0xd2ef7398"), out);
check("listed: attendee sees on the list", /On the attendance list/.test(await lookupAs(p, g1a)), await txt(p, "lookup-out"));
await p.close();
// g2's page reads Kleros through a geth node: the Dispute Resolver (Solidity 0.7) fails a check with an invalid opcode
p = await open("live", g2, 1337, { invalidOpcode: proxy.target }); await toStatus(p);
// one row per challenge: the mark, then one line with the wallet and where it stands (the list is a 2-column grid)
const chRows = (pg) => pg.locator("#open-ch-list li").evaluateAll((lis) => lis.map((li) => (li.children.length === 2 ? li.children[1].innerText.trim() : `${li.children.length} columns`)));
let rows = await chRows(p);
check("open challenges list: the challenger's wallet and 'waiting for a match until … IST' on one line", (await vis(p, "open-ch")) && (await txt(p, "open-ch-h")) === "Open challenges" && rows.length === 1 && new RegExp(`^${g3a.toLowerCase()} waiting for a match until .+ IST$`).test(rows[0]), JSON.stringify(rows));
await connect(p);
out = await lookupAs(p, g3a);
check("challenge open: dispute offered, the jurors' case description linked", /Challenge open/.test(out) && /Jurors read this case description\./.test(out) && (await caseLink(p)) === `https://cdn.kleros.link${g3CaseUri}` && /Dispute this claim \(0\.0162 ETH\)/.test(await txt(p, "ch-action")), out);
await p.click("#ch-action");
check("dispute created", /Dispute created on Kleros/.test(await waitText(p, "lookup-out", /Dispute created on Kleros|didn't go through|cancelled|would fail|Couldn't save/)), await txt(p, "lookup-out"));
const chg = await kick.challenges(g3a);
check("Kleros case opened through the Dispute Resolver (arbitrator ID 1001, local ID 1)", chg.arbitratorDisputeID === 1001n && chg.localDisputeID === 1n);
check("dispute: the case description was already on IPFS (found on the gateway), so it wasn't uploaded again", metaUps().length === 1, JSON.stringify(metaUps().map((u) => u.path)));
const metaEv = async (local) => (await proxy.queryFilter(proxy.filters.MetaEvidence(local))).map((e) => e.args._evidence);
check("the Kleros case carries the contract's case description address (MetaEvidence event)", (await metaEv(1n)).join() === g3CaseUri, (await metaEv(1n)).join());
await p.waitForTimeout(300);
rows = await chRows(p);
check("open challenges list: the case number once disputed", rows.length === 1 && rows[0] === `${g3a.toLowerCase()} Kleros case #1001`, JSON.stringify(rows));
out = await lookupAs(p, g3a);
check("in dispute: Kleros case link on court.kleros.io", /In a Kleros dispute/.test(out) && /Kleros case #1001/.test(out) && (await linkHref(p)) === "https://court.kleros.io/cases/1001" && /Jurors read this case description/.test(out), out);
check("evidence form shown, and the round", (await vis(p, "ev-box")) && /Round 1: jurors are being drawn and evidence is open/.test(out), out);
// the upload service fails: clear error, nothing sent to Kleros
ipfs.mode = "fail";
const nEv = p.sent.length;
await p.fill("#ev-title", "Photo at the venue"); await p.fill("#ev-text", "Cai at the bar at 19:30, with the Truth Pays banner.");
await p.click("#ev-send");
out = await waitText(p, "lookup-out", /Couldn't save|Evidence sent|would fail/);
check("IPFS upload fails: clear error, nothing sent", /Couldn't save your evidence on IPFS, so nothing was sent to Kleros: the upload service answered with error 500/.test(out) && p.sent.length === nEv && (await p.locator("#ev-title").inputValue()) === "Photo at the venue", out);
ipfs.mode = "odd";
await p.click("#ev-send");
out = await waitText(p, "lookup-out", /Couldn't save|Evidence sent|would fail/);
check("IPFS answer without an address: clear error, nothing sent", /didn't return an IPFS address/.test(out) && p.sent.length === nEv, out);
// the upload works: the photo first, then the ERC-1497 JSON pointing at it; the evidence URI goes to the Dispute Resolver
ipfs.mode = "ok"; ipfs.uploads.length = 0;
await p.setInputFiles("#ev-file", { name: "bar photo.jpg", mimeType: "image/jpeg", buffer: Buffer.from("fake jpeg bytes") });
await p.click("#ev-send");
out = await waitText(p, "lookup-out", /Couldn't save|Evidence sent|would fail|didn't go through/);
check("evidence sent", /Evidence sent to Kleros case #1001/.test(out), out);
const [upFile, upJson] = ipfs.uploads;
const evJson = upJson ? JSON.parse(upJson.body.slice(upJson.body.indexOf("{"), upJson.body.lastIndexOf("}") + 1)) : {};
check("photo and evidence JSON uploaded to Kleros's IPFS service (field 'data', pinToGraph=false)",
  ipfs.uploads.length === 2 && upFile.operation === "file" && upFile.file === "bar_photo.jpg" && upFile.body.includes("fake jpeg bytes") && upJson.operation === "evidence" && upJson.file === "evidence.json"
  && ipfs.uploads.every((u) => u.method === "POST" && u.field === "data" && u.pinToGraph === "false"), JSON.stringify(ipfs.uploads.map(({ body, ...u }) => u)));
check("evidence JSON: ERC-1497 name, description naming the staker, the photo as fileURI",
  evJson.name === "Photo at the venue" && evJson.description.startsWith("Cai at the bar at 19:30") && evJson.description.includes(g3a) && evJson.fileURI === `/ipfs/${upFile.cid}/bar_photo.jpg` && evJson.fileTypeExtension === "jpg", JSON.stringify(evJson));
const evs = await proxy.queryFilter(proxy.filters.Evidence(null, 1n));
check("evidence filed on the Dispute Resolver under the local ID, from the guest's wallet, as an IPFS path",
  evs.length === 1 && evs[0].args._party === g2a && evs[0].args._evidence === `/ipfs/${upJson.cid}/evidence.json` && (await proxy.queryFilter(proxy.filters.Evidence(null, 1001n))).length === 0
  && p.sent.at(-1).to.toLowerCase() === proxy.target.toLowerCase() && p.sent.at(-1).data.startsWith("0xa6a7f0eb"), evs.map((e) => e.args._evidence).join("; "));
check("evidence form cleared after sending", (await p.locator("#ev-title").inputValue()) === "" && (await p.locator("#ev-file").inputValue()) === "");
// links: Kleros Court only opens files at an IPFS address (any other link shows as "flagged as unsafe"). An IPFS link,
// also through a gateway, becomes the evidence file; any other link goes in the text, with no file
const linkCid = "QmYwAPJzv5CZsnA625s3Xf2nemtYgPpHdWEz79ojWnPbdG";
const linkEvidence = async (link) => {
  const n = ipfs.uploads.length;
  await p.evaluate(() => { document.getElementById("lookup-out").textContent = ""; });
  await p.fill("#ev-title", "Door list"); await p.fill("#ev-text", "The door list at 19:30."); await p.fill("#ev-link", link);
  await p.click("#ev-send");
  const said = await waitText(p, "lookup-out", /Couldn't save|Evidence sent|would fail|didn't go through|isn't complete/);
  const ups = ipfs.uploads.slice(n);
  return { said, ups, ev: ups.length === 1 ? JSON.parse(ups[0].data.toString("utf8")) : {} };
};
let le = await linkEvidence(`https://ipfs.io/ipfs/${linkCid}/door-list.jpg?filename=door-list.jpg`);
check("evidence link on an IPFS gateway: the file as an IPFS path", /Evidence sent/.test(le.said) && le.ups.length === 1 && le.ev.fileURI === `/ipfs/${linkCid}/door-list.jpg` && le.ev.fileTypeExtension === "jpg" && !le.ev.description.includes("ipfs.io"), JSON.stringify(le.ev));
le = await linkEvidence(`ipfs://${linkCid}`);
check("evidence link ipfs://: the file as an IPFS path", /Evidence sent/.test(le.said) && le.ev.fileURI === `/ipfs/${linkCid}` && !("fileTypeExtension" in le.ev), JSON.stringify(le.ev));
le = await linkEvidence("https://photos.example.com/album/door-list");
check("any other link: in the evidence text, no file", /Evidence sent/.test(le.said) && !("fileURI" in le.ev) && le.ev.description.startsWith("The door list at 19:30.") && le.ev.description.includes("https://photos.example.com/album/door-list") && le.ev.description.includes(g3a), JSON.stringify(le.ev));
// round 1: jurors say g3 did not attend. Someone already put 0.005 ETH on "Yes" directly on the Dispute Resolver.
await (await liquid.startAppealPeriod(1001, 2, 3 * 86400)).wait();
await (await proxy.connect(g1).fundAppeal(1, 1, { value: E("0.005") })).wait();
out = await lookupAs(p, g3a);
// appeal cost 0.0054 x 7 = 0.0378: "No" (the jurors' vote) needs 2x = 0.0756, "Yes" 3x = 0.1134
check("appeal window shown, with what is already raised (other cases ignored)", /Round 1: jurors voted No, did not attend/.test(out) && /"Yes, attended": 0\.005 ETH of 0\.1134 ETH raised/.test(out) && /"No, did not attend": 0 ETH of 0\.0756 ETH raised/.test(out)
  && (await txt(p, "ch-action")) === 'Appeal: fund "Yes, attended" (0.1084 ETH)' && (await txt(p, "ch-action2")) === 'Appeal: fund "No, did not attend" (0.0756 ETH)', out);
const kickEth = await bal(kick), n0 = p.sent.length;
await p.click("#ch-action");
check("appeal funded (losing side)", /Appeal funding sent to Kleros/.test(await waitText(p, "lookup-out", /Appeal funding sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
const contributions = async () => (await proxy.queryFilter(proxy.filters.Contribution(1n))).map((e) => e.args);
const fundTx = p.sent[n0];
check("appeal money went straight to the Dispute Resolver from the guest's wallet", fundTx && fundTx.to.toLowerCase() === proxy.target.toLowerCase() && fundTx.data === "0x4b2f0ea0" + "1".padStart(64, "0") + "1".padStart(64, "0") && fundTx.chainId === "0x539"
  && (await contributions()).some((c) => c.contributor === g2a && c.ruling === 1n && c.round === 0n && c.amount === E("0.1084")) && (await bal(kick)) === kickEth, JSON.stringify(fundTx));
out = await lookupAs(p, g3a);
check("losing side shown funded, warning that it wins unless the other side is funded, other side offered", /"Yes, attended": fully funded/.test(out) && /⚠ "Yes, attended" is being funded\. If "No, did not attend" is not fully funded by .+IST, "Yes, attended" wins the case/.test(out)
  && /fund "No, did not attend"/.test(await txt(p, "ch-action")) && !(await vis(p, "ch-action2")), out);
await p.click("#ch-action");
check("appeal funded (other side)", /Appeal funding sent to Kleros/.test(await waitText(p, "lookup-out", /Appeal funding sent|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("both funded: round 2 on Kleros", (await liquid.rounds(1001)) === 2n);
check("round 2 shown", /Round 2: jurors are being drawn/.test(await lookupAs(p, g3a)) && !(await vis(p, "ch-box")) && !(await vis(p, "reward-box")) && (await vis(p, "ev-box")), await txt(p, "lookup-out"));
await p.close();
// round 2: jurors say attended. The contribution logs can't be read, and Kleros is read through a geth node: the page
// counts the rounds by reading disputeIDtoRoundArray until it fails, which the Solidity 0.7 Dispute Resolver does with
// an invalid opcode (no revert data). It still finds round 2 and offers the full amounts.
await (await liquid.startAppealPeriod(1001, 1, 86400)).wait();
p = await open("live", g2, 1337, { failLogs: true, invalidOpcode: proxy.target }); await connect(p);
out = await lookupAs(p, g3a);
check("amounts raised unreadable: full amount offered, extra sent back by Kleros", /Round 2: jurors voted Yes, attended/.test(out) && /couldn't read how much is raised/.test(out) && (await txt(p, "ch-action")) === 'Appeal: fund "Yes, attended" (0.162 ETH)' && (await txt(p, "ch-action2")) === 'Appeal: fund "No, did not attend" (0.243 ETH)' && !/⚠/.test(out), `${out} | ${await txt(p, "ch-action")}`);
check("geth's invalid opcode (Solidity 0.7 Dispute Resolver) read as the end of the rounds", p.invalidOps > 0 && /Round 2/.test(out), `${p.invalidOps} invalid opcodes`);
await p.close();
// nobody appeals. Meanwhile the challenge window is over: anyone can release the payouts.
await prov.send("evm_increaseTime", [86400 + 10]); await prov.send("evm_mine", []);
const chainNow = async () => (await prov.getBlock("latest")).timestamp;
p = await open("live", g2, 1337, { clockAt: await chainNow() }); await connect(p);
await lookupAs(p, g1a); await p.waitForTimeout(500);
check("Release payouts offered once the challenge window is over", await vis(p, "release-box"));
const g1Eth = await bal(g1);
// a payout batch estimated at 13.6 million gas: a wallet's own margin (+50%) would pass the 2^24 cap (EIP-7825)
p.bigEstimate = true;
await p.click("#release");
check("payouts released from the guest page while the case is open (one share set aside)", /Payouts released/.test(await waitText(p, "release-msg", /Payouts released|didn't go through|cancelled|would fail/)) && Number(await kick.phase()) === 2
  && (await bal(g1)) === g1Eth + D && (await kick.challenges(g3a)).heldShare === D, await txt(p, "release-msg"));
p.bigEstimate = false;
check("big payout batch: the page sets the gas limit itself, at most 2^24 (EIP-7825)", p.sent.at(-1).gas === "0x1000000", JSON.stringify(p.sent.at(-1)));
check("Release payouts gone once released", !(await vis(p, "release-box")));
for (let i = 0; i < 20 && (await txt(p, "open-ch-h")) !== "Open Kleros cases"; i++) await p.waitForTimeout(250);
rows = await chRows(p);
check("after the payouts: the open Kleros case is still listed, as 'Open Kleros cases'", (await vis(p, "open-ch")) && (await txt(p, "open-ch-h")) === "Open Kleros cases" && /set aside until Kleros's final ruling/.test(await txt(p, "open-ch-p"))
  && rows.length === 1 && rows[0] === `${g3a.toLowerCase()} Kleros case #1001`, `${await txt(p, "open-ch-h")} | ${JSON.stringify(rows)}`);
// the appeal period is over but nobody delivered the ruling yet: anyone can, from the page
out = await lookupAs(p, g3a);
check("appeal window over: deliver the final ruling offered", /Jurors ruled Yes, attended and the appeal window is over/.test(out) && (await txt(p, "ch-action")) === "Deliver the final ruling", out);
const nDeliver = p.sent.length;
await p.click("#ch-action");
out = await waitText(p, "lookup-out", /Final ruling delivered|didn't go through|cancelled|would fail/);
const deliverTxs = p.sent.slice(nDeliver);
check("final ruling delivered: passPeriod then executeRuling on Kleros Court", /Final ruling delivered for Kleros case #1001/.test(out) && deliverTxs.length === 2 && deliverTxs.every((t) => t.to.toLowerCase() === liquid.target.toLowerCase())
  && deliverTxs[0].data === "0x115d5376" + "3e9".padStart(64, "0") && deliverTxs[1].data === "0x8bb04875" + "3e9".padStart(64, "0") && (await proxy.disputes(1)).isRuled, out);
out = await lookupAs(p, g3a);
check("final ruling shown, no more evidence, appeal money offered right away", /Final ruling: Yes, attended/.test(out) && (await txt(p, "ch-action")) === "Settle challenge" && !(await vis(p, "ev-box")) && (await vis(p, "collect")), out);
const g3Eth = await bal(g3);
await p.click("#ch-action");
check("settled after ruling", /Settled according to the Kleros ruling/.test(await waitText(p, "lookup-out", /Settled according to the Kleros ruling|didn't go through|cancelled|would fail/)), await txt(p, "lookup-out"));
check("challenger's held share and challenge money paid (status Paid)", Number(await kick.status(g3a)) === 2 && (await bal(g3)) === g3Eth + D + FEE);
out = await lookupAs(p, g3a);
// round 1 rewards: 0.1134 + 0.0756 - 0.0378 = 0.1512, shared by the "Yes" funders: g2 put 0.1084 of 0.1134
check("paid challenger: Kleros outcome shown, appeal rewards offered", /Paid out\. Kleros jurors ruled that this guest attended/.test(out) && (await vis(p, "collect")) && (await txt(p, "collect")) === "Collect my appeal rewards (0.1445 ETH)" && /goes straight to this wallet/.test(await txt(p, "reward-text")), `${out} | ${await txt(p, "collect")}`);
const g2Eth = await bal(g2), n1 = p.sent.length;
await p.click("#collect");
check("appeal rewards collected", /Appeal money collected/.test(await waitText(p, "lookup-out", /Appeal money collected|didn't go through|cancelled|would fail|Couldn't/)) && (await bal(g2)) > g2Eth, await txt(p, "lookup-out"));
const withdrawals = (await proxy.queryFilter(proxy.filters.Withdrawal(1n))).map((e) => e.args), collectTxs = p.sent.slice(n1);
check("collected from the Dispute Resolver for every round and both answers, to the funder's own wallet",
  collectTxs.length === 1 && collectTxs[0].to.toLowerCase() === proxy.target.toLowerCase() && collectTxs[0].data === "0x0e274e4c" + "1".padStart(64, "0") + g2a.slice(2).toLowerCase().padStart(64, "0") + ["60", "2", "1", "2"].map((x) => x.padStart(64, "0")).join("")
  && withdrawals.length === 1 && withdrawals[0].contributor === g2a && withdrawals[0].ruling === 1n && withdrawals[0].round === 0n, JSON.stringify(collectTxs));
await lookupAs(p, g3a);
check("nothing left to collect afterwards", /nothing left to collect/.test(await txt(p, "reward-text")) && !(await vis(p, "collect")), await txt(p, "reward-text"));
check("no page errors (challenges)", p.errs.length === 0, p.errs.join("; "));
await p.close();
// the other "Yes" funder (0.005 ETH) gets their part too; a wallet that never funded sees nothing
p = await open("live", g1); await connect(p);
await toStatus(p);
check("case settled: no open Kleros case listed any more", !(await vis(p, "open-ch")));
await lookupAs(p, g3a);
check("second funder: their own share offered", (await txt(p, "collect")) === "Collect my appeal rewards (0.0067 ETH)", await txt(p, "collect"));
await p.switchAccount(ga); await settle(p);
await lookupAs(p, g3a);
check("a wallet that never funded an appeal: no appeal money box", !(await vis(p, "reward-box")));
await p.close();
check("every transaction pinned to the network (chainId)", allSent.length >= 15 && allSent.every((t) => t.chainId === "0x539"), JSON.stringify(allSent.map((t) => t.chainId)));
check("no appeal or evidence call ever sent to the deposit contract", !allSent.some((t) => t.to.toLowerCase() === kick.target.toLowerCase() && /^0x(4b2f0ea0|0e274e4c|a6a7f0eb)/.test(t.data)));

// 8b. c2 and c4 challenge (outside the page), c3 disputes c2's claim from the page. The case description isn't on IPFS
// yet, so the page saves it first, and sends nothing while it can't (also when the upload service never answers).
// A double click on Dispute opens one wallet prompt, not two. Then jurors vote "No", only "Yes" gets fully funded
// for an appeal, and the window ends. Kleros's rule makes "Yes" win: the page says so instead of showing the jurors'
// vote as the outcome. Nobody matches c4's challenge: it counts as attended.
const [c1, c2, c3, c4] = keys.slice(6, 10).map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
const c1a = await addr(c1), c2a = await addr(c2), c4a = await addr(c4);
const kick2 = await deploy("0.01");
build(kick2.target, "case2");
for (const c of [c1, c2, c4]) await (await c.sendTransaction({ to: kick2.target, value: D })).wait();
await (await kick2.connect(owner).registerStakers([c1a, c2a, c4a])).wait();
await (await kick2.connect(owner).postAttendance([c1a], 3n * D)).wait();
for (const c of [c2, c4]) await (await kick2.connect(c).challenge({ value: await kick2.challengeDeposit() })).wait();
const [c2Case, c2CaseUri] = await kick2.caseMetaEvidence(c2a);
ipfs.mode = "fail";
p = await open("case2", c3, 1337, { clockInstall: true, confirmDelay: 1500 }); await connect(p);
out = await lookupAs(p, c2a);
check("lookup of an open challenge: the case description linked", /Challenge open/.test(out) && (await caseLink(p)) === `https://cdn.kleros.link${c2CaseUri}` && !ipfs.store.has(c2CaseUri), out);
const n2 = p.sent.length;
// the upload service never answers: after 30 seconds the page gives up, and nothing is sent
ipfs.mode = "hang";
const hung = ipfs.hung;
await p.click("#ch-action");
for (let i = 0; i < 40 && ipfs.hung === hung; i++) await p.waitForTimeout(100);
const greyed = (await dis(p, "ch-action")) && (await txt(p, "lookup-out")).includes("Saving the case description");
await p.clock.fastForward(31000);
out = await waitText(p, "lookup-out", /Couldn't save the case description|Dispute created|didn't go through/);
check("dispute: the upload service never answers: the page gives up after 30 s, nothing sent", ipfs.hung === hung + 1 && greyed && /Couldn't save the case description on IPFS, so nothing was sent: the upload service didn't answer in time/.test(out)
  && p.sent.length === n2 && !(await dis(p, "ch-action")), out);
ipfs.mode = "fail";
await p.click("#ch-action");
out = await waitText(p, "lookup-out", /Couldn't save the case description|Dispute created|didn't go through/);
check("dispute: the case description can't be saved on IPFS, so no transaction is sent", /Couldn't save the case description on IPFS, so nothing was sent: the upload service answered with error 500/.test(out) && p.sent.length === n2 && Number((await kick2.challenges(c2a)).state) === 1 && (await vis(p, "ch-action")), out);
ipfs.mode = "other";
await p.click("#ch-action");
out = await waitText(p, "lookup-out", /Couldn't save the case description|Dispute created|didn't go through/);
check("dispute: the upload service saves it at another address than the contract's: nothing sent", new RegExp(`Couldn't save the case description on IPFS, so nothing was sent: the upload service saved it at /ipfs/Qm\\w+, not at ${c2CaseUri}`).test(out) && p.sent.length === n2, out);
ipfs.mode = "ok";
const ups2 = ipfs.uploads.length, ord2 = order.length;
// a double click, both clicks on the button (the note above it changes on the first click, so a real double click
// may or may not land twice)
await p.locator("#ch-action").evaluate((b) => { b.click(); b.click(); });
out = await waitText(p, "lookup-out", /Couldn't save the case description|Dispute created|didn't go through/);
const saved2 = ipfs.uploads.slice(ups2).filter((u) => u.file === "metaevidence.json"), seq2 = order.slice(ord2);
const iUp = seq2.findIndex((o) => o.upload === "metaevidence.json"), iMatch = seq2.findIndex((o) => o.tx === "0x6d6df455");
check("dispute: the case description saved on IPFS first (exactly the contract's text, at its address), then the case opened",
  /Dispute created on Kleros/.test(out) && saved2.length === 1 && saved2[0].data.equals(Buffer.from(c2Case, "utf8")) && saved2[0].path === c2CaseUri && iUp >= 0 && iMatch > iUp && p.sent.length === n2 + 1 && p.sent.at(-1).data === "0x6d6df455" + c2a.slice(2).toLowerCase().padStart(64, "0"), `${out} | ${JSON.stringify(seq2)}`);
check("dispute double-clicked: one wallet prompt, one upload", p.sent.filter((t) => t.data.startsWith("0x6d6df455")).length === 1 && saved2.length === 1, JSON.stringify(seq2));
const { arbitratorDisputeID: case2, localDisputeID: local2 } = await kick2.challenges(c2a);
check("the Kleros case carries c2's own case description (MetaEvidence event)", (await metaEv(local2)).join() === c2CaseUri && c2CaseUri !== g3CaseUri, (await metaEv(local2)).join());
await p.waitForTimeout(300);
rows = await chRows(p);
check("open challenges list: a Kleros case and a challenge waiting for a match", rows.length === 2 && rows[0] === `${c2a.toLowerCase()} Kleros case #${case2}` && new RegExp(`^${c4a.toLowerCase()} waiting for a match until .+ IST$`).test(rows[1]), JSON.stringify(rows));
check("no page errors (dispute from the page)", p.errs.length === 0, p.errs.join("; "));
await p.close();
await (await liquid.startAppealPeriod(case2, 2, 2 * 86400)).wait();
await (await proxy.connect(c1).fundAppeal(local2, 1, { value: (await kick2.appealStatus(c2a)).costAttended })).wait();
await prov.send("evm_increaseTime", [2 * 86400 + 10]); await prov.send("evm_mine", []);
p = await open("case2", c1, 1337, { clockAt: await chainNow() }); await connect(p);
await toStatus(p);
rows = await chRows(p);
check("open challenges list: an unmatched challenge whose match window is over counts as attended", rows.length === 2 && rows[0] === `${c2a.toLowerCase()} Kleros case #${case2}` && rows[1] === `${c4a.toLowerCase()} nobody matched in time: counts as attended`, JSON.stringify(rows));
out = await lookupAs(p, c2a);
check("one answer funded, appeal window over: that answer is shown as the winner, not the jurors' vote",
  /Jurors voted No, did not attend, but only Yes, attended was fully funded for an appeal, so Yes, attended wins the case/.test(out) && !/Jurors ruled No/.test(out) && (await txt(p, "ch-action")) === "Deliver the final ruling", out);
check("no page errors (one-sided appeal)", p.errs.length === 0, p.errs.join("; "));
await p.close();
p = await open("case2", c1, 1337, { clockAt: await chainNow(), failLogs: true }); await connect(p);
out = await lookupAs(p, c2a);
check("appeal funding unreadable: the jurors' vote with a warning that a lone funded answer would win", /Jurors ruled No, did not attend and the appeal window is over\. \(Couldn't check the appeal funding right now: if only the other answer was fully funded for an appeal, that answer wins instead\.\)/.test(out), out);
await p.close();
await (await liquid.passPeriod(case2)).wait(); await (await liquid.executeRuling(case2)).wait();
check("and Kleros's final ruling is indeed the funded answer", (await proxy.disputes(local2)).ruling === 1n);

// 8c. answer 0 ("Refuse to arbitrate"): the Dispute Resolver takes appeal funding for it too, an answer funded alone wins,
// and a final 0 counts as "did not attend". d2's jurors voted "Yes" and someone funds 0; d3's jurors tied (0), so
// both answers can only be funded until the end of the first half of the appeal period.
const fresh = async () => new ethers.NonceManager(await fundNew());
const [d1, d2, d3, griefer] = [await fresh(), await fresh(), await fresh(), await fresh()];
const [d1a, d2a, d3a] = [await addr(d1), await addr(d2), await addr(d3)];
const kick3 = await deploy("0.01");
build(kick3.target, "case3");
for (const d of [d1, d2, d3]) await (await d.sendTransaction({ to: kick3.target, value: D })).wait();
await (await kick3.connect(owner).registerStakers([d1a, d2a, d3a])).wait();
await (await kick3.connect(owner).postAttendance([d1a], 3n * D)).wait();
for (const d of [d2, d3]) await (await kick3.connect(d).challenge({ value: await kick3.challengeDeposit() })).wait();
for (const a of [d2a, d3a]) await (await kick3.connect(griefer).matchChallenge(a, { value: (await kick3.challenges(a)).deposit })).wait();
const [cA, cB] = [await kick3.challenges(d2a), await kick3.challenges(d3a)];
await (await liquid.startAppealPeriod(cA.arbitratorDisputeID, 1, 2 * 86400)).wait();
await (await liquid.startAppealPeriod(cB.arbitratorDisputeID, 0, 2 * 86400)).wait();
await (await proxy.connect(griefer).fundAppeal(cA.localDisputeID, 0, { value: E("0.05") })).wait();
await (await proxy.connect(griefer).fundAppeal(cB.localDisputeID, 0, { value: E("0.01") })).wait();
p = await open("case3", d2, 1337, { clockAt: await chainNow() }); await connect(p);
out = await lookupAs(p, d2a);
// appeal cost 0.0378: the jurors' answer needs 0.0756 until the end, any other answer (0 included) 0.1134 until the half
const until = (re) => (out.match(re) || [])[1];
check("Yes vote, 'Refuse to arbitrate' being funded: shown, and the staker warned they count as a no-show unless Yes is funded",
  /Round 1: jurors voted Yes, attended/.test(out) && /"Refuse to arbitrate": 0\.05 ETH of 0\.1134 ETH raised/.test(out) && /counts as "No, did not attend" here/.test(out)
  && /⚠ "Refuse to arbitrate" is being funded\. If "Yes, attended" is not fully funded by .+ IST, you count as a no-show/.test(out) && until(/not fully funded by (.+? IST), you count/) === until(/Either side can appeal until (.+? IST)/), out);
await (await proxy.connect(griefer).fundAppeal(cA.localDisputeID, 0, { value: E("0.1") })).wait();
out = await lookupAs(p, d2a);
check("'Refuse to arbitrate' fully funded alone: shown, the warning stays, Yes still offered", /"Refuse to arbitrate": fully funded/.test(out) && /⚠ "Refuse to arbitrate" is being funded/.test(out) && (await txt(p, "ch-action")) === 'Appeal: fund "Yes, attended" (0.0756 ETH)', out);
out = await lookupAs(p, d3a);
check("tied vote: both answers only until the first half of the period, a refusal standing means a no-show",
  /Round 1: the jurors did not reach an answer \(a tie or a refusal to arbitrate\)\. Both answers can be funded for an appeal only until .+ IST\. If neither is fully funded, the refusal stands and this guest counts as a no-show\./.test(out) && !/Either side can appeal until/.test(out)
  && /"Refuse to arbitrate": 0\.01 ETH of 0\.0756 ETH raised/.test(out) && /⚠ "Refuse to arbitrate" is being funded\. If "Yes, attended" is not fully funded by .+ IST, this guest counts as a no-show/.test(out)
  && until(/not fully funded by (.+? IST), this guest/) === until(/only until (.+? IST)\./) && (await txt(p, "ch-action")) === 'Appeal: fund "Yes, attended" (0.1134 ETH)' && (await txt(p, "ch-action2")) === 'Appeal: fund "No, did not attend" (0.1134 ETH)', out);
check("no page errors (refuse to arbitrate)", p.errs.length === 0, p.errs.join("; "));
await p.close();
await prov.send("evm_increaseTime", [2 * 86400 + 10]); await prov.send("evm_mine", []);
p = await open("case3", d1, 1337, { clockAt: await chainNow() }); await connect(p);
out = await lookupAs(p, d2a);
check("appeal window over, only 'Refuse to arbitrate' funded: it wins, and the guest counts as a no-show",
  /Jurors voted Yes, attended, but only Refuse to arbitrate was fully funded for an appeal, so Refuse to arbitrate wins the case \(Kleros's rule when only one side funds an appeal\): this guest counts as a no-show\./.test(out), out);
await (await liquid.passPeriod(cA.arbitratorDisputeID)).wait(); await (await liquid.executeRuling(cA.arbitratorDisputeID)).wait();
out = await lookupAs(p, d2a);
check("final ruling 0 shown as a no-show", (await proxy.disputes(cA.localDisputeID)).ruling === 0n && /Final ruling: no ruling \(counts as did not attend\)\./.test(out) && (await txt(p, "ch-action")) === "Settle challenge", out);
await p.click("#ch-action");
await waitText(p, "lookup-out", /Settled according to the Kleros ruling|didn't go through|cancelled|would fail/);
check("settled: a final 0 keeps the guest off the list", Number((await kick3.challenges(d2a)).state) === 3 && !(await kick3.attended(d2a)), await txt(p, "lookup-out"));
check("no page errors (refusal wins)", p.errs.length === 0, p.errs.join("; "));
await p.close();

// 9. a list never published: after the claim deadline a staker withdraws their own deposit from the page
await (await g1.sendTransaction({ to: late.target, value: D })).wait();
await (await late.connect(owner).registerStakers([g1a])).wait();
await prov.send("evm_increaseTime", [8 * 86400]); await prov.send("evm_mine", []);
p = await open("late", g1, 1337, { clockAt: await chainNow() }); await connect(p);
check("footer: self-withdrawal only if the list is never published", /never publish the attendance list by the claim deadline \(.+IST\)/.test(await p.locator("footer").innerText()), await p.locator("footer").innerText());
out = await lookupAs(p, g1a);
check("deadline passed, no list: withdrawal offered", /never published before the deadline/.test(out) && (await vis(p, "claim-emergency")) && !(await vis(p, "claim-owed")), out);
const safe = ethers.Wallet.createRandom().address;
await p.fill("#claim-to", safe); await p.click("#claim-emergency");
check("deposit withdrawn from the page to the chosen address", /Done/.test(await waitText(p, "lookup-out", /Done|didn't go through|cancelled|would fail/)) && (await bal(safe)) === D && (await bal(late)) === 0n, await txt(p, "lookup-out"));
out = await lookupAs(p, g1a);
check("after the withdrawal: 'Withdrawn after the deadline', not 'checked in'", /Withdrawn after the deadline/.test(out) && !/checked in/.test(out), out);
check("no page errors (late)", p.errs.length === 0, p.errs.join("; "));
await p.close();

await browser.close(); await server.close();
const fails = results.filter((r) => !r).length;
console.log(`\n${results.length - fails}/${results.length} passed`);
process.exit(fails ? 1 : 0);
