#!/usr/bin/env node
// End-to-end test on a LOCAL ganache MAINNET FORK (never real mainnet): TruthPaysKickback deployed with the
// live console's exact constructor arguments, against the REAL Kleros Dispute Resolver
// (0x4b89e798b10478a839ea0abcf86c4b94a3c782a4) and the REAL KlerosLiquid (0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069)
// as they are on mainnet at the fork block. Rulings are delivered by impersonating KlerosLiquid (unlocked on the fork).
//
// Needs a fork already running (see the report):
//   node_modules/.bin/ganache --fork.url https://ethereum-rpc.publicnode.com --chain.chainId 1 \
//     --wallet.unlockedAccounts 0x259a1084C2043a7B3b5b288596E05C41b8EFa5d6 \
//     --wallet.unlockedAccounts 0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069 --wallet.totalAccounts 12 --server.port 8545
//   SETTINGS_URL=http://localhost:8787/settings.json node test/fork.e2e.mjs
//
// It snapshots the fork at the start and reverts to that snapshot at the end, so the chain is left as it was.
// Restart the fork right before a run: a public RPC that is not an archive node forgets old fork blocks.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { parse } from "csv-parse/sync";
import { ipfsPathOf } from "../scripts/lib.mjs";

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const RPC = process.env.FORK_RPC || "http://127.0.0.1:8545";
const SETTINGS_URL = process.env.SETTINGS_URL || "http://localhost:8787/settings.json";
const OUT = "out-fork-e2e";
const CFG = "config.fork-e2e.json";
const RESOLVER = "0x4B89e798B10478A839Ea0Abcf86C4B94A3C782A4";
const LIQUID = "0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069";
const OWNER = "0x259a1084C2043a7B3b5b288596E05C41b8EFa5d6";
const E = (x) => ethers.parseEther(String(x));
const q = (n) => ethers.toQuantity(n);

const prov = new ethers.JsonRpcProvider(RPC, 1, { staticNetwork: true, cacheTimeout: -1 });
prov.pollingInterval = 100;
const chainId = Number(await prov.send("eth_chainId", []));
assert.equal(chainId, 1, "the fork must report chain id 1");
// Safety: refuse to run against anything but a local ganache (evm_snapshot only exists there)
assert.ok(/^http:\/\/(127\.0\.0\.1|localhost):\d+$/.test(RPC), "FORK_RPC must be a local URL");
const node = await prov.send("web3_clientVersion", []);
assert.match(node, /Ganache/i, "the RPC must be a local ganache fork");

const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"));
const { abi: KABI, bytecode: KBYTECODE } = load("TruthPaysKickback");
const kIface = new ethers.Interface(KABI);
const resolver = new ethers.Contract(RESOLVER, [
  "function arbitrator() view returns (address)",
  "function disputes(uint256) view returns (bytes arbitratorExtraData, bool isRuled, uint256 ruling, uint256 disputeIDOnArbitratorSide)",
  "function externalIDtoLocalID(uint256) view returns (uint256)",
  "function submitEvidence(uint256 _localDisputeID, string _evidenceURI)",
  "function rule(uint256 _externalDisputeID, uint256 _ruling)",
  "event Evidence(address indexed _arbitrator, uint256 indexed _evidenceGroupID, address indexed _party, string _evidence)",
  "event Ruling(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _ruling)",
  "event Dispute(address indexed _arbitrator, uint256 indexed _disputeID, uint256 _metaEvidenceID, uint256 _evidenceGroupID)",
  "event MetaEvidence(uint256 indexed _metaEvidenceID, string _evidence)",
], prov);
const liquid = new ethers.Contract(LIQUID, [
  "function arbitrationCost(bytes) view returns (uint256)",
  "function disputes(uint256) view returns (uint96 subcourtID, address arbitrated, uint256 numberOfChoices, uint8 period, uint256 lastPeriodChange, uint256 drawsInRound, uint256 commitsInRound, bool ruled)",
  "event DisputeCreation(uint256 indexed _disputeID, address indexed _arbitrable)",
], prov);

// ------------------------------------------------------------------ reporting
const results = [];
const txLog = [];
let scenario = "";
async function step(name, fn) {
  const before = txLog.length;
  try {
    const extra = await fn();
    const hashes = txLog.slice(before).map((t) => `${t.label}=${t.hash}`);
    results.push({ scenario, name, ok: true });
    console.log(`PASS [${scenario}] ${name}${extra ? ` (${extra})` : ""}${hashes.length ? `\n     tx: ${hashes.join("\n         ")}` : ""}`);
    return true;
  } catch (e) {
    const hashes = txLog.slice(before).map((t) => `${t.label}=${t.hash}`);
    results.push({ scenario, name, ok: false, err: e.message });
    console.log(`FAIL [${scenario}] ${name}: ${e.message}${hashes.length ? `\n     tx: ${hashes.join("\n         ")}` : ""}`);
    throw e;
  }
}

// ------------------------------------------------------------------ chain helpers
// Expected balance of every account we touch, to the wei: start balance, minus gas and value sent, plus what
// the contract (or anyone) should have paid them.
const ledger = new Map();
const L = (a) => ethers.getAddress(a);
const track = async (a) => { if (!ledger.has(L(a))) ledger.set(L(a), await prov.getBalance(a)); };
const credit = (a, v) => ledger.set(L(a), ledger.get(L(a)) + v);
const debit = (a, v) => ledger.set(L(a), ledger.get(L(a)) - v);
async function assertLedger(list) {
  const bad = [];
  for (const [label, a] of list) {
    const want = ledger.get(L(a)), got = await prov.getBalance(a);
    if (want !== got) bad.push(`${label} ${a}: expected ${want} got ${got} (diff ${got - want})`);
  }
  assert.ok(!bad.length, bad.join("; "));
}

async function send(label, from, to, data = "0x", value = 0n, { expectFail = false } = {}) {
  const tx = { from, to, data, value: q(value) };
  let gas;
  try {
    gas = await prov.estimateGas(tx);
  } catch (e) {
    if (expectFail) return { reverted: true, reason: decodeErr(e) };
    throw new Error(`${label}: estimate failed: ${decodeErr(e)}`);
  }
  if (expectFail) throw new Error(`${label}: expected a revert, but it would succeed`);
  // like the console: estimate + 30% (ganache's estimate has no margin, and batch payments need their 40,000 gas)
  const hash = await prov.send("eth_sendTransaction", [{ ...tx, gas: q((gas * 13n) / 10n) }]);
  const r = await prov.waitForTransaction(hash);
  txLog.push({ label, hash, scenario });
  if (ledger.has(L(from))) debit(from, r.gasUsed * r.gasPrice + value);
  if (to && ledger.has(L(to))) credit(to, value);
  if (r.status !== 1) throw new Error(`${label}: tx ${hash} reverted`);
  return r;
}
const call = (label, from, contract, method, args = [], value = 0n, opts) =>
  send(label, from, contract.target ?? contract, (contract.interface ?? kIface).encodeFunctionData(method, args), value, opts);
function decodeErr(e) {
  const data = e?.data ?? e?.info?.error?.data ?? e?.error?.data;
  const hex = typeof data === "string" ? data : data?.data ?? data?.result;
  if (typeof hex === "string" && hex.startsWith("0x") && hex.length >= 10) {
    try { const p = kIface.parseError(hex); if (p) return `${p.name}(${p.args.join(",")})`; } catch {}
    return hex.slice(0, 10);
  }
  return e?.shortMessage || e?.message || String(e);
}
const warpTo = async (ts) => {
  const now = (await prov.getBlock("latest")).timestamp;
  if (ts > now) await prov.send("evm_increaseTime", [ts - now]);
  await prov.send("evm_mine", []);
  return (await prov.getBlock("latest")).timestamp;
};
const run = async (script, ...extra) => {
  const { stdout, stderr } = await execFileP("node", [path.join(root, "scripts", script), "--config", CFG, "--out", OUT, ...extra], { cwd: root, encoding: "utf8" });
  return stdout + stderr;
};
const readCsv = (f) => parse(fs.readFileSync(path.join(root, OUT, f), "utf8"), { columns: true, skip_empty_lines: true });
const readJson = (f) => JSON.parse(fs.readFileSync(path.join(root, OUT, f), "utf8"));

// ------------------------------------------------------------------ setup
const accounts = (await prov.send("eth_accounts", [])).map(L);
assert.ok(accounts.length >= 12, "need 12 funded ganache accounts (--wallet.totalAccounts 12)");
const [g1, g2, g3, g4, g5, g6, g7, g8, gW, gCopy, gStray, gHelper] = accounts;
const NAMES = { [g1]: "Ana", [g2]: "Ben", [g3]: "Cai", [g4]: "Dev", [g5]: "Eve(A)", [g6]: "Fay(B)", [g7]: "Gus(C)", [g8]: "Bot(declined)", [gW]: "Wim(wrong amount)", [gCopy]: "Cop(copycat)", [gStray]: "Stray", [OWNER]: "owner", [LIQUID]: "KlerosLiquid" };

const settings = await (await fetch(SETTINGS_URL)).json();
assert.ok(Array.isArray(settings.deployArgs), `no deployArgs in ${SETTINGS_URL}: ${settings.deployError ?? settings.error}`);
const live = settings.deployArgs;
const deployArgs = [BigInt(live[0]), live[1], OWNER, BigInt(live[3]), BigInt(live[4]), live[5]];
const DEP = deployArgs[0];
const EVENT_START = Number(deployArgs[3]), CLAIM_DEADLINE = Number(deployArgs[4]);
const EXTRA = live[5][1];

// fund the impersonated accounts on the fork only (gas for the owner, gas for KlerosLiquid's rule calls)
await prov.send("evm_setAccountBalance", [OWNER, q(E(10))]);
const liquidReal = await prov.getBalance(LIQUID);
await prov.send("evm_setAccountBalance", [LIQUID, q(liquidReal + E(1))]);
const S0 = await prov.send("evm_snapshot", []);
const forkBlock = await prov.getBlockNumber();
console.log(`Fork: ${node}, block ${forkBlock}, time ${new Date((await prov.getBlock("latest")).timestamp * 1000).toISOString()}`);
console.log(`Live deployArgs from ${SETTINGS_URL}: deposit ${DEP} wei, "${deployArgs[1]}", start ${EVENT_START}, deadline ${CLAIM_DEADLINE}, resolver ${live[5][0]}, extraData ${EXTRA}, case description template ${live[5][2].length} pieces, policy ${live[5][4]}`);

let K; // the deployed contract
const kc = () => new ethers.Contract(K, KABI, prov);
const H = "api_id,name,email,ticket_name,approval_status,checked_in_at,eth_address,Deposit tx link (Committed Spot only)";
const T = "Committed Spot (0.01 ETH)";
const writeConfig = (deployBlock) => {
  const base = JSON.parse(fs.readFileSync(path.join(root, "config.json"), "utf8"));
  fs.writeFileSync(path.join(root, CFG), JSON.stringify({ ...base, rpcUrl: RPC, receiver: K, contract: K, deployBlock: String(deployBlock) }, null, 2));
};

async function deployKick(label) {
  const data = ethers.concat([KBYTECODE, kIface.encodeDeploy(deployArgs)]);
  const r = await send(label, OWNER, null, data);
  K = L(r.contractAddress);
  return r;
}

let failed = false;
const tx = {};
let fee; // Kleros arbitration cost = challenge deposit
let S1;
let caseB, caseC;
try {
  // ================================================================ main lifecycle
  scenario = "lifecycle";
  for (const a of [g1, g2, g3, g4, g5, g6, g7, g8, gW, gCopy, gStray, OWNER, LIQUID]) await track(a);
  let deployBlock;
  await step("deploy TruthPaysKickback with the live console's deployArgs (owner 0x259a…a5d6)", async () => {
    const r = await deployKick("deploy");
    deployBlock = r.blockNumber;
    const c = kc();
    assert.equal(await c.depositAmount(), DEP);
    assert.equal(await c.owner(), OWNER);
    assert.equal(L(await c.disputeResolver()), RESOLVER);
    assert.equal(L(await c.arbitrator()), LIQUID);
    assert.equal(await c.arbitratorExtraData(), EXTRA);
    const [pieces, slots] = await c.metaEvidenceTemplate();
    assert.deepEqual([[...pieces], slots], [live[5][2], live[5][3]]);
    assert.equal(await c.policyURI(), live[5][4]);
    assert.equal(await c.eventName(), deployArgs[1]);
    assert.equal(await c.eventStart(), deployArgs[3]);
    assert.equal(await c.claimDeadline(), deployArgs[4]);
    fee = await c.challengeDeposit();
    assert.equal(fee, await liquid.arbitrationCost(EXTRA));
    writeConfig(deployBlock);
    return `contract ${K}, block ${deployBlock}, deploy gas ${r.gasUsed}, challengeDeposit ${ethers.formatEther(fee)} ETH`;
  });

  await step("guests deposit 0.01 ETH via deposit() and plain transfers (+ wrong amount, duplicate wallet, stray)", async () => {
    const depData = kIface.encodeFunctionData("deposit", []);
    tx.g1 = (await send("g1 deposit()", g1, K, depData, DEP)).hash;
    tx.g2 = (await send("g2 deposit()", g2, K, depData, DEP)).hash;
    tx.g3 = (await send("g3 transfer", g3, K, "0x", DEP)).hash;
    tx.g4 = (await send("g4 transfer", g4, K, "0x", DEP)).hash;
    tx.g5 = (await send("g5 deposit()", g5, K, depData, DEP)).hash;
    tx.g6 = (await send("g6 deposit()", g6, K, depData, DEP)).hash;
    tx.g6b = (await send("g6 2nd deposit (duplicate wallet)", g6, K, "0x", DEP)).hash;
    tx.g7 = (await send("g7 transfer", g7, K, "0x", DEP)).hash;
    tx.g8 = (await send("g8 deposit() (to be declined)", g8, K, depData, DEP)).hash;
    tx.gW = (await send("gW wrong amount 0.005", gW, K, "0x", E("0.005"))).hash;
    tx.stray = (await send("stray transfer (not on Luma)", gStray, K, "0x", DEP)).hash;
    // a plain transfer with a fixed 21,000 gas limit fails (README: TX_FAILED)
    let refused = false;
    try {
      const h = await prov.send("eth_sendTransaction", [{ from: gHelper, to: K, value: q(DEP), gas: q(21000) }]);
      const r = await prov.waitForTransaction(h);
      refused = r.status === 0;
    } catch { refused = true; }
    assert.ok(refused, "a 21,000-gas plain transfer must fail");
    const logs = await kc().queryFilter("Deposited", deployBlock);
    assert.equal(logs.length, 11);
    assert.equal(await prov.getBalance(K), DEP * 10n + E("0.005"));
  });

  const rows = (checkins = {}) => [
    H,
    `1,Ana,ana@x.io,${T},approved,${checkins.ana ?? ""},${g1},https://etherscan.io/tx/${tx.g1}`,
    `2,Ben,ben@x.io,${T},approved,${checkins.ben ?? ""},${g2},${tx.g2}`,
    `3,Cai,cai@x.io,${T},approved,${checkins.cai ?? ""},${g3},https://etherscan.io/tx/${tx.g3}`,
    `4,Dev,dev@x.io,${T},approved,${checkins.dev ?? ""},,https://etherscan.io/tx/${tx.g4}`, // wallet inferred from the tx
    `5,Eve,eve@x.io,${T},approved,,${g5},https://etherscan.io/tx/${tx.g5}`,
    `6,Fay,fay@x.io,${T},approved,,${g6},https://etherscan.io/tx/${tx.g6}`,
    `7,Fay again,fay+2@x.io,${T},declined,,${g6},https://etherscan.io/tx/${tx.g6b}`, // second sign-up, same wallet
    `8,Gus,gus@x.io,${T},approved,,${g7},https://etherscan.io/tx/${tx.g7}`,
    `9,Bot,bot@x.io,${T},declined,,${g8},https://etherscan.io/tx/${tx.g8}`,
    `10,Wim,wim@x.io,${T},approved,,${gW},https://etherscan.io/tx/${tx.gW}`,
    `11,Cop,cop@x.io,${T},approved,,${gCopy},https://etherscan.io/tx/${tx.g2}`, // copied Ben's tx link
    `12,Hal,hal@x.io,Request to Join (Free),approved,${checkins.hal ?? ""},,`,
  ].join("\n");
  fs.mkdirSync(path.join(root, OUT), { recursive: true });
  fs.writeFileSync(path.join(root, OUT, "luma-guests.csv"), rows());

  let verifyLog;
  await step("verify-deposits.mjs on the synthetic Luma CSV against the fork", async () => {
    verifyLog = await run("verify-deposits.mjs", "--guests", path.join(OUT, "luma-guests.csv"));
    const ns = readJson("new-stakers.json").items.map((i) => L(i.wallet));
    const rf = readJson("refunds.json").items.map((i) => L(i.wallet));
    assert.deepEqual(new Set(ns), new Set([g1, g2, g3, g4, g5, g6, g7]), `new-stakers: ${ns}`);
    assert.deepEqual(rf, [g8], `refunds: ${rf}`);
    const issues = readCsv("issues.csv");
    const codes = Object.fromEntries(issues.map((i) => [i.name, i.code]));
    assert.equal(codes.Wim, "AMOUNT_TOO_LOW");
    assert.equal(codes.Cop, "DUPLICATE_TX");
    assert.equal(codes["Fay again"], "DUPLICATE_WALLET");
    const returns = readCsv("returns.csv");
    const ret = Object.fromEntries(returns.map((r) => [L(r.wallet), r.to_return]));
    assert.equal(ret[gW], "0.005");
    assert.equal(ret[g6], "0.01");
    assert.equal(returns.length, 2, JSON.stringify(returns));
    const um = readCsv("unmatched.csv").filter((u) => u.status === "open");
    assert.equal(um.length, 1);
    assert.equal(L(um[0].from), gStray);
    assert.equal(um[0].to_return, "0.01");
    assert.equal(readJson("new-stakers.json").deposit, DEP.toString());
    return `issues ${JSON.stringify(codes)}; returns ${JSON.stringify(ret)}; unmatched ${um[0].from}`;
  });

  await step("registerStakers(new-stakers.json) from the owner", async () => {
    const ns = readJson("new-stakers.json").items.map((i) => i.wallet);
    await call("registerStakers", OWNER, { target: K }, "registerStakers", [ns]);
    assert.equal(await kc().stakerCount(), 7n);
  });
  await step("rejectAndRefund(refunds.json): the declined guest gets exactly 0.01 back", async () => {
    const rf = readJson("refunds.json").items.map((i) => i.wallet);
    await call("rejectAndRefund", OWNER, { target: K }, "rejectAndRefund", [rf]);
    credit(g8, DEP);
    await assertLedger([["g8", g8]]);
    assert.equal(await kc().status(g8), 3n);
  });
  await step("refund() returns.csv + unmatched.csv strays (short payment, 2nd deposit, stray)", async () => {
    const returns = readCsv("returns.csv");
    const um = readCsv("unmatched.csv").filter((u) => u.status === "open");
    for (const r of [...returns.map((x) => [x.wallet, x.to_return]), ...um.map((u) => [u.from, u.to_return])]) {
      await call(`refund ${NAMES[L(r[0])]}`, OWNER, { target: K }, "refund", [r[0], E(r[1])]);
      credit(r[0], E(r[1]));
    }
    // the pool itself can't be refunded
    const bad = await call("refund pool (must revert)", OWNER, { target: K }, "refund", [OWNER, 1n], 0n, { expectFail: true });
    assert.match(bad.reason, /InsufficientBalance/);
    await assertLedger([["gW", gW], ["g6", g6], ["stray", gStray]]);
    assert.equal(await prov.getBalance(K), DEP * 7n);
    assert.equal(await kc().spare(), 0n);
  });
  await step("verify-deposits re-run: nothing left to register, refund or return", async () => {
    await run("verify-deposits.mjs", "--guests", path.join(OUT, "luma-guests.csv"));
    assert.equal(readJson("new-stakers.json").items.length, 0);
    assert.equal(readJson("refunds.json").items.length, 0);
    assert.equal(readCsv("returns.csv").length, 0, fs.readFileSync(path.join(root, OUT, "returns.csv"), "utf8"));
    assert.equal(readCsv("unmatched.csv").filter((u) => u.status === "open").length, 0);
  });
  S1 = await prov.send("evm_snapshot", []);

  await step("postAttendance refused before eventStart (TooEarly)", async () => {
    const r = await call("postAttendance early", OWNER, { target: K }, "postAttendance", [[g1], DEP * 7n], 0n, { expectFail: true });
    assert.match(r.reason, /TooEarly/);
  });
  await step("warp past eventStart (evm_increaseTime + evm_mine)", async () => {
    const t = await warpTo(EVENT_START + 3600);
    assert.ok(t >= EVENT_START);
    return `chain time ${new Date(t * 1000).toISOString()}`;
  });
  let plan;
  await step("build-payout.mjs with a synthetic check-in export (Ana, Ben, Cai, Dev + free guest Hal)", async () => {
    const at = "2026-11-04T19:02:00+05:30";
    fs.writeFileSync(path.join(root, OUT, "luma-after.csv"), rows({ ana: at, ben: at, cai: at, dev: at, hal: at }));
    const log = await run("build-payout.mjs", "--checkins", path.join(OUT, "luma-after.csv"));
    plan = readJson("payout-plan.json");
    assert.deepEqual(new Set(plan.attendees.map(L)), new Set([g1, g2, g3, g4]));
    assert.equal(plan.stakers, 7);
    assert.equal(BigInt(plan.share), (DEP * 7n) / 4n);
    assert.match(log, /No-shows \| 3/);
    return `share ${plan.shareEth} ETH`;
  });
  await step("postAttendance(payout-plan) with A, B, C (Eve, Fay, Gus) left off", async () => {
    await call("postAttendance", OWNER, { target: K }, "postAttendance", [plan.attendees, BigInt(plan.share)]);
    assert.equal(await kc().phase(), 1n);
    assert.equal(await kc().attendeeCount(), 4n);
    // deposits are refused after the list
    const r = await send("late deposit (must revert)", gHelper, K, "0x", DEP, { expectFail: true });
    assert.match(r.reason, /NotOpen/);
  });

  await step("A (Eve) challenges with challengeDeposit()", async () => {
    await call("A challenge", g5, { target: K }, "challenge", [], fee);
    const c = await kc().challenges(g5);
    assert.equal(c.state, 1n);
    assert.equal(c.deposit, fee);
  });
  await step("B (Fay) challenges; owner matches with the real arbitrationCost → REAL KlerosLiquid dispute", async () => {
    await call("B challenge", g6, { target: K }, "challenge", [], fee + 12345n); // overpaid: the extra comes back
    credit(g6, 12345n);
    const r = await call("B matchChallenge", OWNER, { target: K }, "matchChallenge", [g6], fee);
    const c = await kc().challenges(g6);
    assert.equal(c.state, 2n);
    assert.equal(c.arbitrationPaid, fee);
    caseB = { id: c.arbitratorDisputeID, local: c.localDisputeID };
    const created = r.logs.filter((l) => L(l.address) === LIQUID).map((l) => { try { return liquid.interface.parseLog(l); } catch { return null; } }).filter((p) => p?.name === "DisputeCreation");
    assert.equal(created.length, 1, "KlerosLiquid DisputeCreation event");
    assert.equal(created[0].args._disputeID, caseB.id);
    assert.equal(L(created[0].args._arbitrable), RESOLVER);
    const d = await liquid.disputes(caseB.id);
    assert.equal(L(d.arbitrated), RESOLVER);
    assert.equal(d.subcourtID, 0n);
    assert.equal(d.numberOfChoices, 2n);
    assert.equal(d.period, 0n);
    assert.equal(d.ruled, false);
    assert.equal(await resolver.externalIDtoLocalID(caseB.id), caseB.local);
    const rd = await resolver.disputes(caseB.local);
    assert.equal(rd.disputeIDOnArbitratorSide, caseB.id);
    assert.equal(rd.isRuled, false);
    assert.equal(rd.arbitratorExtraData, EXTRA);
    const meta = r.logs.filter((l) => L(l.address) === RESOLVER).map((l) => { try { return resolver.interface.parseLog(l); } catch { return null; } }).filter(Boolean);
    const me = meta.find((p) => p.name === "MetaEvidence");
    // this case's own description: written by the contract, naming the wallet and the contract, linking the policy
    const [text, uri] = await kc().caseMetaEvidence(g6);
    assert.equal(uri, ipfsPathOf(text), "the contract's IPFS path is the one ipfs add gives for its text");
    const desc = JSON.parse(text);
    assert.ok(desc.title.includes(g6) && desc.question.includes(g6), "title and question name the wallet");
    assert.ok(desc.description.includes(g6) && desc.description.includes(K), "description names the wallet and the contract");
    assert.equal(desc.fileURI, live[5][4]);
    assert.ok(me && me.args._evidence === uri && me.args._metaEvidenceID === caseB.local, "MetaEvidence with this case's own description under the local ID");
    fs.writeFileSync(path.join(root, OUT, `case-${g6}.json`), text);
    return `KlerosLiquid case ${caseB.id}, Dispute Resolver local ${caseB.local}, period evidence, match gas ${r.gasUsed}, description ${uri}`;
  });
  await step("submitEvidence on the real Dispute Resolver (B's case)", async () => {
    const uri = "/ipfs/QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o/challenge-details.json";
    const r = await call("submitEvidence B", OWNER, resolver, "submitEvidence", [caseB.local, uri]);
    const ev = r.logs.map((l) => { try { return resolver.interface.parseLog(l); } catch { return null; } }).find((p) => p?.name === "Evidence");
    assert.ok(ev, "Evidence event");
    assert.equal(ev.args._evidence, uri);
    assert.equal(L(ev.args._party), OWNER);
    assert.equal(L(ev.args._arbitrator), LIQUID);
  });
  await step("C (Gus) challenges and is matched → second real Kleros case", async () => {
    await call("C challenge", g7, { target: K }, "challenge", [], fee);
    await call("C matchChallenge", OWNER, { target: K }, "matchChallenge", [g7], fee + 999n); // extra 999 wei comes back
    credit(OWNER, 999n);
    const c = await kc().challenges(g7);
    caseC = { id: c.arbitratorDisputeID, local: c.localDisputeID };
    assert.equal(caseC.id, caseB.id + 1n);
    assert.equal((await liquid.disputes(caseC.id)).arbitrated, RESOLVER);
    assert.equal(await resolver.externalIDtoLocalID(caseC.id), caseC.local);
    return `KlerosLiquid case ${caseC.id}, local ${caseC.local}`;
  });
  await step("addAttendees refused for a disputed challenger (InDispute); releasePayouts refused during the window", async () => {
    const r = await call("addAttendees B (must revert)", OWNER, { target: K }, "addAttendees", [[g6]], 0n, { expectFail: true });
    assert.match(r.reason, /InDispute/);
    const r2 = await call("releasePayouts early (must revert)", gHelper, { target: K }, "releasePayouts", [], 0n, { expectFail: true });
    assert.match(r2.reason, /TooEarly/);
  });
  await step("Kleros delivers B's ruling 1 (impersonated KlerosLiquid calls Resolver.rule)", async () => {
    await call("rule(B,1) from KlerosLiquid", LIQUID, resolver, "rule", [caseB.id, 1n]);
    const rd = await resolver.disputes(caseB.local);
    assert.equal(rd.isRuled, true);
    assert.equal(rd.ruling, 1n);
    // a non-arbitrator can't rule
    const bad = await call("rule from a stranger (must revert)", gHelper, resolver, "rule", [caseC.id, 1n], 0n, { expectFail: true });
    assert.ok(bad.reverted);
  });
  await step("Kleros delivers C's ruling 2", async () => {
    await call("rule(C,2) from KlerosLiquid", LIQUID, resolver, "rule", [caseC.id, 2n]);
    const rd = await resolver.disputes(caseC.local);
    assert.equal(rd.isRuled, true);
    assert.equal(rd.ruling, 2n);
  });
  await step("warp past the challenge window and A's match window", async () => {
    const c = await kc().challenges(g5);
    const t = await warpTo(Number(c.matchEndsAt) + 10);
    assert.ok(t > Number(await kc().challengeEndsAt()));
  });
  let share;
  await step("releasePayouts (anyone): A counted as attended, B and C still in a case → 2 shares held back", async () => {
    // payouts before settling the cases: the cases are ruled on the Dispute Resolver but not yet settled here
    await call("releasePayouts", gHelper, { target: K }, "releasePayouts", []);
    const c = kc();
    share = await c.payoutShare();
    assert.equal(share, (DEP * 7n) / 7n); // 5 attendees + 2 open cases
    assert.equal(await c.heldBack(), share * 2n);
    assert.equal(await c.phase(), 2n);
    for (const a of [g1, g2, g3, g4, g5]) credit(a, share);
    credit(g5, fee); // A's unmatched challenge deposit back
    assert.equal(await c.challengeEscrow(), fee * 2n * 2n - fee * 2n); // B and C: 2*fee in, fee spent each
    await assertLedger([["g1", g1], ["g2", g2], ["g3", g3], ["g4", g4], ["A", g5]]);
    return `share ${ethers.formatEther(share)} ETH, heldBack ${ethers.formatEther(share * 2n)}`;
  });
  await step("settle B (resolveChallenge): attended → held share + challenge money", async () => {
    await call("resolveChallenge B", gHelper, { target: K }, "resolveChallenge", [g6]);
    credit(g6, share + fee); // held share, and what is left of both deposits after the fee (2*fee - fee)
    await assertLedger([["B", g6]]);
    assert.equal(await kc().attended(g6), true);
  });
  let each;
  await step("settle C: ruled absent → held share split between the 6 attendees, matcher gets challenge money", async () => {
    const r = await call("resolveChallenge C", gHelper, { target: K }, "resolveChallenge", [g7]);
    each = share / 6n;
    const split = r.logs.map((l) => { try { return kIface.parseLog(l); } catch { return null; } }).find((p) => p?.name === "HeldShareSplit");
    assert.equal(split.args.each, each);
    for (const a of [g1, g2, g3, g4, g5, g6]) credit(a, each);
    credit(OWNER, fee);
    await assertLedger([["g1", g1], ["g2", g2], ["g3", g3], ["g4", g4], ["A", g5], ["B", g6], ["C", g7], ["owner", OWNER]]);
    assert.equal(await kc().attended(g7), false);
    return `each ${each} wei`;
  });
  await step("owed: nothing to claim (all EOAs), claim() refuses", async () => {
    assert.equal(await kc().owedTotal(), 0n);
    const r = await call("claim (must revert)", g1, { target: K }, "claim", [g1], 0n, { expectFail: true });
    assert.match(r.reason, /NothingToClaim/);
  });
  await step("sweep the rounding dust to the owner; contract ends at exactly 0 ETH", async () => {
    const dust = await prov.getBalance(K);
    assert.equal(dust, share - each * 6n);
    assert.equal(await kc().reserved(), 0n);
    await call("sweep", OWNER, { target: K }, "sweep", [OWNER]);
    credit(OWNER, dust);
    assert.equal(await prov.getBalance(K), 0n);
    return `dust ${dust} wei`;
  });
  await step("final balances to the wei (README: equal share of the whole pool for everyone on the final list)", async () => {
    // KlerosLiquid keeps the two arbitration fees (minus the gas we spent impersonating it)
    credit(LIQUID, fee * 2n);
    await assertLedger(Object.entries({ g1, g2, g3, g4, g5, g6, g7, g8, gW, gCopy, gStray, OWNER, LIQUID }));
    const total = share + each; // per person on the final list
    assert.equal(total, (DEP * 7n) / 6n, "everyone on the final list got pool / 6 (rounded down)");
    // net per wallet, excluding gas: attendees + B: +total - deposit; A also got its challenge deposit back; C: -deposit - fee
    return `per attendee ${ethers.formatEther(total)} ETH (deposit 0.01 + ${ethers.formatEther(total - DEP)} bonus); C lost 0.01 + fee; owner lost B's fee ${ethers.formatEther(fee)}`;
  });
} catch (e) {
  failed = true;
}

// ================================================================ cancel → full refunds
try {
  scenario = "cancel";
  assert.ok(S1, "no snapshot after registration (lifecycle failed early)");
  await prov.send("evm_revert", [S1]);
  const S2 = await prov.send("evm_snapshot", []);
  S1 = S2; // reuse for the emergency path
  for (const a of [g1, g2, g3, g4, g5, g6, g7, OWNER]) ledger.set(L(a), await prov.getBalance(a));
  await step("state back to after registration (7 stakers, 0.07 ETH)", async () => {
    assert.equal(await kc().stakerCount(), 7n);
    assert.equal(await prov.getBalance(K), DEP * 7n);
    assert.equal(await kc().phase(), 0n);
  });
  await step("cancel(): every registered staker gets exactly 0.01 back", async () => {
    await call("cancel", OWNER, { target: K }, "cancel", []);
    for (const a of [g1, g2, g3, g4, g5, g6, g7]) credit(a, DEP);
    await assertLedger(Object.entries({ g1, g2, g3, g4, g5, g6, g7, OWNER }));
    assert.equal(await kc().phase(), 3n);
    assert.equal(await prov.getBalance(K), 0n);
  });
  await step("after cancel: deposits refused, postAttendance refused, sweep of 0 works", async () => {
    assert.match((await send("deposit after cancel (must revert)", gHelper, K, "0x", DEP, { expectFail: true })).reason, /NotOpen/);
    assert.match((await call("post after cancel (must revert)", OWNER, { target: K }, "postAttendance", [[g1], DEP], 0n, { expectFail: true })).reason, /NotOpen/);
    await call("sweep after cancel", OWNER, { target: K }, "sweep", [OWNER]);
    assert.equal(await prov.getBalance(K), 0n);
  });
} catch (e) {
  failed = true;
}

// ================================================================ claimDeadline → emergencyWithdraw
try {
  scenario = "emergency";
  await prov.send("evm_revert", [S1]);
  for (const a of [g1, g2, g3, g4, g5, g6, g7, OWNER]) ledger.set(L(a), await prov.getBalance(a));
  await step("emergencyWithdraw refused before claimDeadline (TooEarly)", async () => {
    assert.equal(await kc().stakerCount(), 7n);
    assert.match((await call("emergencyWithdraw early (must revert)", g1, { target: K }, "emergencyWithdraw", [g1], 0n, { expectFail: true })).reason, /TooEarly/);
  });
  await step("warp past claimDeadline; postAttendance and cancel refused (TooLate)", async () => {
    await warpTo(CLAIM_DEADLINE + 60);
    assert.match((await call("post late (must revert)", OWNER, { target: K }, "postAttendance", [[g1], DEP * 7n], 0n, { expectFail: true })).reason, /TooLate/);
    assert.match((await call("cancel late (must revert)", OWNER, { target: K }, "cancel", [], 0n, { expectFail: true })).reason, /TooLate/);
  });
  await step("each staker emergencyWithdraws exactly 0.01 (g2 to another address); contract ends at 0", async () => {
    for (const a of [g1, g3, g4, g5, g6, g7]) {
      await call(`emergencyWithdraw ${NAMES[a]}`, a, { target: K }, "emergencyWithdraw", [a]);
      credit(a, DEP);
    }
    await call("emergencyWithdraw Ben → g1", g2, { target: K }, "emergencyWithdraw", [g1]);
    credit(g1, DEP);
    assert.match((await call("withdraw twice (must revert)", g3, { target: K }, "emergencyWithdraw", [g3], 0n, { expectFail: true })).reason, /NotAStaker/);
    assert.match((await call("non-staker withdraw (must revert)", g8, { target: K }, "emergencyWithdraw", [g8], 0n, { expectFail: true })).reason, /NotAStaker/);
    await assertLedger(Object.entries({ g1, g2, g3, g4, g5, g6, g7 }));
    assert.equal(await kc().stakerCount(), 0n);
    assert.equal(await prov.getBalance(K), 0n);
  });
} catch (e) {
  failed = true;
}

await prov.send("evm_revert", [S0]);
const nOk = results.filter((r) => r.ok).length;
console.log(`\n${nOk}/${results.length} steps passed${failed ? " (stopped at a failure in a scenario)" : ""}. Fork reverted to its starting snapshot.`);
process.exit(failed || nOk !== results.length ? 1 : 0);
