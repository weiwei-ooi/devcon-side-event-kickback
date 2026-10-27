// Contract-level tests: ETH deposits (receive / deposit()), curation refunds, attendance list +
// Kleros Court v1 challenges through the Dispute Resolver (evidence, appeals funded from the
// funders' own wallets, the one-side-funded override, refusal to rule), payouts with shares set
// aside for open Kleros cases (fair in any settlement order), ETH accounting (refund / sweep only
// touch spare ETH), wallets that refuse ETH or burn gas, reentrancy, emergency exit, two-step
// ownership and a 150-guest run.
// Local in-memory chain (ganache) with stand-ins for KlerosLiquid and the Dispute Resolver.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
import ganache from "ganache";
import { ethers } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"));
const E = (x) => ethers.parseEther(String(x));
const PORT = 18546;
const N = 160; // accounts: owner + 159 guests

let server, prov, owner, guests, liquid, proxy, kickIface;
const DAY = 86400;
const D = E("0.01"); // the deposit
const FEE_PER_JUROR = E("0.005");
const FEE = 3n * FEE_PER_JUROR; // Kleros fee for 3 jurors: the challenge deposit
const EXTRA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 3]); // General Court, 3 jurors
const POLICY = "/ipfs/QmPolicyForTests/attendance-policy.md";
const META = "/ipfs/QmMetaEvidenceForTests/metaevidence.json";
const MAX = ethers.MaxUint256;
// the Kleros stand-ins' transactions also get an explicit gas limit (see the estimate margin in `before`)
const KGAS = { gasLimit: 500_000 };
const MODE = { Accept: 0, Refuse: 1, BurnGas: 2, Busy: 3, Reenter: 4 };
const keys = Array.from({ length: N }, (_, i) => "0x" + (i + 1).toString(16).padStart(64, "0"));

async function deploy(name, signer, ...params) {
  const { abi, bytecode } = load(name);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...params);
  await c.waitForDeployment();
  return c;
}
const now = async () => (await prov.getBlock("latest")).timestamp;
const warp = async (s) => {
  await prov.send("evm_increaseTime", [s]);
  await prov.send("evm_mine", []);
};
// the custom error behind a failed call, also when it bubbled up through a TestWallet
function errName(e) {
  if (e.revert?.name) return e.revert.name;
  const data = e.data ?? e.info?.error?.data;
  try {
    return kickIface.parseError(data ?? "0x")?.name;
  } catch {
    return undefined;
  }
}
async function reverts(contract, method, params, errorName) {
  try {
    await contract[method].staticCall(...params);
  } catch (e) {
    const name = errName(e);
    assert.equal(name, errorName, `expected ${errorName}, got ${name ?? e.shortMessage}`);
    return;
  }
  assert.fail(`${method} did not revert (expected ${errorName})`);
}
// a plain ETH transfer to the contract (its receive function)
async function sendReverts(kick, from, value, errorName) {
  try {
    await prov.call({ from: await addr(from), to: kick.target, value });
  } catch (e) {
    assert.equal(errName(e), errorName);
    return;
  }
  assert.fail(`plain transfer did not revert (expected ${errorName})`);
}
const addr = (s) => (typeof s === "string" ? s : s.target ?? s.getAddress());
const bal = async (a) => prov.getBalance(await addr(a));
const send = async (p) => (await p).wait();
const logsOf = (r, contract, name) =>
  r.logs.filter((l) => l.address.toLowerCase() === contract.target.toLowerCase()).map((l) => contract.interface.parseLog(l)).filter((x) => x?.name === name);

async function freshKick({ startIn = 3600, deadlineIn = 3600 * 24 * 14 } = {}) {
  const t = await now();
  return deploy("TruthPaysKickback", owner, D, "Truth Pays", await addr(owner), t + startIn, t + deadlineIn, arb());
}
const arb = () => [proxy.target, EXTRA, META, POLICY];
// post the list, let the 1-day challenge window pass, release
async function settle(kick, att, share) {
  await send(kick.postAttendance(att, share));
  await warp(DAY + 1);
  return send(kick.connect(guests[158]).releasePayouts({ gasLimit: 3_000_000 }));
}
// plain transfers from the guests' wallets
async function stake(kick, gs) {
  for (const g of gs) await send(g.sendTransaction({ to: kick.target, value: D }));
}
// a wallet contract that deposits through deposit(), then behaves as `mode` when ETH arrives
async function testWallet(kick, mode = MODE.Accept) {
  const w = await deploy("TestWallet", owner);
  await send(w.exec(kick.target, kickIface.encodeFunctionData("deposit"), { value: D }));
  if (mode !== MODE.Accept) await send(w.setMode(mode));
  return w;
}
// a call from a TestWallet that must fail with `errorName` (the wallet passes the contract's error on)
const walletReverts = (w, kick, fn, args, errorName) =>
  reverts({ exec: w.exec }, "exec", [kick.target, kickIface.encodeFunctionData(fn, args)], errorName);

before(async () => {
  execFileSync("node", [path.join(root, "scripts/compile.mjs")], { stdio: "ignore" });
  server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337 },
    miner: { blockGasLimit: 120_000_000 },
    wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) },
  });
  await server.listen(PORT);
  // cacheTimeout -1: ethers otherwise reuses an identical read (a balance) for 250 ms, which can predate a fast tx
  prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 1337, { staticNetwork: true, cacheTimeout: -1 });
  prov.pollingInterval = 50; // local chain mines instantly; the 4 s default makes 450+ txs crawl
  // ganache's gas estimate is the exact gas used, with no margin; now and then a mined tx then runs out of
  // gas. Real wallets add a margin (and real nodes search for a limit that works), so do the same here.
  const estimate = prov.estimateGas.bind(prov);
  prov.estimateGas = async (tx) => ((await estimate(tx)) * 12n) / 10n;
  const ws = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
  [owner, ...guests] = ws;
  kickIface = new ethers.Interface(load("TruthPaysKickback").abi);
  liquid = await deploy("MockKlerosLiquid", owner);
  await send(liquid.setFeeForJuror(FEE_PER_JUROR, KGAS));
  proxy = await deploy("MockArbitrableProxy", owner, liquid.target);
});
after(async () => server && (await server.close()));

test("constructor: checks the times, deposit, owner and Dispute Resolver, and reads Kleros Court from it", async () => {
  const t = await now();
  const { abi, bytecode } = load("TruthPaysKickback");
  const f = new ethers.ContractFactory(abi, bytecode, owner);
  const o = await addr(owner);
  const W = 7 * DAY; // the settlement window after the event must be at least 7 days
  for (const bad of [
    [D, "x", o, t + 100, t + 100, arb()],
    [D, "x", o, t + 100, t + 100 + W - 1, arb()],
    [D, "x", o, t + 100, t + 100 + W, [ethers.ZeroAddress, EXTRA, META, POLICY]],
    [D, "x", o, t + 100, t + 100 + W, [o, EXTRA, META, POLICY]], // a wallet, not a Dispute Resolver
    [0n, "x", o, t + 100, t + 100 + W, arb()],
    [D, "x", ethers.ZeroAddress, t + 100, t + 100 + W, arb()],
  ]) {
    await assert.rejects(f.deploy(...bad));
    owner.reset(); // the refused deploy used up a nonce locally; resync with the chain
  }
  const k = await f.deploy(D, "x", o, t + 100, t + 100 + W, arb());
  await k.waitForDeployment();
  assert.equal(await k.depositAmount(), D);
  assert.equal(await k.disputeResolver(), proxy.target);
  assert.equal(await k.arbitrator(), liquid.target);
  assert.equal(await k.arbitratorExtraData(), EXTRA);
  assert.equal(await k.metaEvidenceURI(), META);
  assert.equal(await k.policyURI(), POLICY);
  assert.equal(await k.PAYOUT_GAS(), 100_000n);
  assert.equal(await k.RULING_OPTIONS(), 2n);
  assert.equal(await k.challengeDeposit(), FEE); // KlerosLiquid: fee per juror x 3 jurors
});

test("deposits: a plain transfer or deposit() logs Deposited; zero, odd calls and late deposits are refused, so the ETH stays in the wallet", async () => {
  const kick = await freshKick({ startIn: 1 });
  const [a, b, c] = guests.slice(0, 3);
  const r1 = await send(a.sendTransaction({ to: kick.target, value: D }));
  const r2 = await send(kick.connect(b).deposit({ value: D + 5n }));
  const logs = [...logsOf(r1, kick, "Deposited"), ...logsOf(r2, kick, "Deposited")];
  assert.deepEqual(logs.map((l) => [l.args.from, l.args.amount]), [[await addr(a), D], [await addr(b), D + 5n]]);
  assert.equal(await bal(kick), 2n * D + 5n);
  assert.equal(await kick.spare(), 2n * D + 5n); // nobody registered yet: nothing is reserved
  await reverts(kick.connect(c), "deposit", [{ value: 0n }], "ZeroDeposit");
  await sendReverts(kick, c, 0n, "ZeroDeposit");
  // no fallback: a call with unknown data is refused
  await assert.rejects(prov.call({ from: await addr(c), to: kick.target, value: D, data: "0x12345678" }));

  await send(kick.registerStakers([await addr(a), await addr(b)]));
  await warp(2);
  await send(kick.postAttendance([await addr(a)], 2n * D));
  // the list is posted: no more deposits
  await sendReverts(kick, c, D, "NotOpen");
  await reverts(kick.connect(c), "deposit", [{ value: D }], "NotOpen");
  const e0 = await bal(c);
  const tx = await c.sendTransaction({ to: kick.target, value: D, gasLimit: 100000 }); // forced through anyway
  const err = await tx.wait().then(() => null, (e) => e);
  assert.equal(err?.code, "CALL_EXCEPTION"); // mined, but reverted
  assert.equal(await bal(c), e0 - err.receipt.fee); // only the gas is spent
  await warp(DAY + 1);
  await send(kick.releasePayouts());
  await sendReverts(kick, c, D, "NotOpen"); // paid out
  const k2 = await freshKick();
  await send(k2.cancel());
  await sendReverts(k2, c, D, "NotOpen"); // cancelled
  await reverts(k2.connect(c), "deposit", [{ value: D }], "NotOpen");
});

test("rejectAndRefund: declined payers and dropped stakers get exactly their deposit back", async () => {
  const kick = await freshKick();
  const [a, b, c, d] = guests;
  await stake(kick, [a, b, c, d]);
  await send(kick.registerStakers([await addr(a), await addr(b)]));
  const before = await bal(c);
  // c and d paid but are declined; b drops out after being registered
  const r = await send(kick.rejectAndRefund([await addr(c), await addr(d), await addr(b)]));
  assert.equal(logsOf(r, kick, "Payout").length, 3);
  assert.equal(await bal(c), before + D);
  assert.equal(await kick.stakerCount(), 1n);
  assert.equal(await bal(kick), D);
  assert.equal(await kick.status(await addr(c)), 3n); // Rejected
  // cannot reject twice
  await reverts(kick, "rejectAndRefund", [[await addr(c)]], "CannotReject");
  // a rejected wallet may come back, but only once it has paid again
  await reverts(kick, "registerStakers", [[await addr(c)]], "InsufficientBalance");
  await stake(kick, [c]);
  await send(kick.registerStakers([await addr(c)]));
  assert.equal(await kick.status(await addr(c)), 1n); // Staker
  assert.equal(await kick.stakerCount(), 2n);
  // an unregistered wallet with no spare money behind it cannot be "refunded" out of the pool
  await reverts(kick, "rejectAndRefund", [[await addr(guests[10])]], "InsufficientBalance");
  // the contract itself can never be registered or refunded
  await reverts(kick, "rejectAndRefund", [[kick.target]], "ZeroAddress");
  await reverts(kick, "registerStakers", [[kick.target]], "ZeroAddress");
  // only owner
  await reverts(kick.connect(a), "rejectAndRefund", [[await addr(a)]], "NotOwner");
});

test("refund can only use spare money, never the pool", async () => {
  const kick = await freshKick();
  const [a, b] = guests.slice(20);
  await stake(kick, [a, b]);
  const extra = E("0.005");
  await send(a.sendTransaction({ to: kick.target, value: extra })); // overpayment
  await send(kick.registerStakers([await addr(a), await addr(b)]));
  assert.equal(await kick.spare(), extra);
  await reverts(kick, "refund", [await addr(a), extra + 1n], "InsufficientBalance");
  await reverts(kick, "refund", [kick.target, 1n], "ZeroAddress");
  const a0 = await bal(a);
  await send(kick.refund(await addr(a), extra));
  assert.equal(await bal(a), a0 + extra);
  assert.equal(await kick.spare(), 0n);
  await reverts(kick, "refund", [await addr(a), 1n], "InsufficientBalance");
});

test("registerStakers refuses wallets the balance does not cover", async () => {
  const kick = await freshKick();
  const [a, b] = guests.slice(30);
  await stake(kick, [a]);
  await reverts(kick, "registerStakers", [[await addr(a), await addr(b)]], "InsufficientBalance");
  await send(kick.registerStakers([await addr(a)]));
});

test("postAttendance: not before the event, and only with the share the organiser confirmed", async () => {
  const kick = await freshKick({ startIn: 3600 });
  const gs = guests.slice(40, 44);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  const att = await Promise.all(gs.slice(0, 3).map(addr)); // 3 of 4 show up
  const share = (D * 4n) / 3n;
  await reverts(kick, "postAttendance", [att, share], "TooEarly");
  await warp(3601);
  await reverts(kick, "postAttendance", [att, D], "ShareMismatch");
  await reverts(kick, "postAttendance", [[], 0n], "NoAttendees");
  await reverts(kick, "postAttendance", [[att[0], att[0]], 2n * D], "DuplicateAttendee");
  await reverts(kick, "postAttendance", [[await addr(guests[50])], 4n * D], "NotAStaker");
  await reverts(kick.connect(gs[0]), "postAttendance", [att, share], "NotOwner");
  await reverts(kick, "releasePayouts", [], "NotListed");
  const b0 = await bal(att[0]);
  await send(kick.postAttendance(att, share));
  assert.equal(await kick.phase(), 1n); // Listed
  assert.equal(await kick.attendeeCount(), 3n);
  // the list is posted once; the pool stays locked during the challenge window
  await reverts(kick, "postAttendance", [att, share], "NotOpen");
  await reverts(kick, "cancel", [], "NotOpen");
  await reverts(kick, "rejectAndRefund", [[att[0]]], "CannotReject");
  await reverts(kick, "sweep", [await addr(owner)], "NotSettled");
  assert.equal(await kick.spare(), 0n);
  await reverts(kick, "releasePayouts", [], "TooEarly");
  await warp(DAY + 1);
  await send(kick.connect(guests[51]).releasePayouts()); // anyone can release
  assert.equal(await bal(att[0]), b0 + share);
  assert.equal(await kick.phase(), 2n); // Finalized
  assert.equal(await kick.status(att[0]), 2n); // Paid
  assert.equal(await kick.status(await addr(gs[3])), 1n); // no-show stays a Staker, deposit forfeited
  // dust only; sweep takes it, nothing else
  const dust = await bal(kick);
  assert.equal(dust, 4n * D - 3n * share);
  assert.equal(await kick.spare(), dust);
  await send(kick.sweep(await addr(owner)));
  assert.equal(await bal(kick), 0n);
});

test("a wallet that refuses ETH or burns its gas does not block the payout: its share waits in owed; a heavy smart wallet is paid directly", async () => {
  const kick = await freshKick({ startIn: 1 });
  const g = guests[60];
  await stake(kick, [g]);
  const refuser = await testWallet(kick, MODE.Refuse);
  const burner = await testWallet(kick, MODE.BurnGas);
  const busy = await testWallet(kick, MODE.Busy);
  const all = [await addr(g), refuser.target, burner.target, busy.target];
  await send(kick.registerStakers(all));
  await warp(2);
  const g0 = await bal(g);
  const r = await settle(kick, all, D);
  assert.equal(await bal(g), g0 + D);
  assert.equal(await bal(busy), D); // needs ~66k gas: more than transfer's 2,300, within PAYOUT_GAS
  assert.equal(await busy.received(), 1n);
  assert.deepEqual(logsOf(r, kick, "PayoutFailed").map((l) => l.args.to), [refuser.target, burner.target]);
  assert.equal(await kick.owed(refuser.target), D);
  assert.equal(await kick.owed(burner.target), D);
  assert.equal(await kick.owedTotal(), 2n * D);
  assert.equal(await kick.reserved(), 2n * D);
  // sweep must not take the unclaimed payments
  await send(kick.sweep(await addr(owner)));
  assert.equal(await bal(kick), 2n * D);
  // the refuser claims to another address of its own
  const alt = await addr(guests[70]);
  const altBefore = await bal(alt);
  await send(refuser.exec(kick.target, kickIface.encodeFunctionData("claim", [alt])));
  assert.equal(await bal(alt), altBefore + D);
  await walletReverts(refuser, kick, "claim", [alt], "NothingToClaim");
  // a claim to an address that refuses ETH reverts and keeps the money owed
  await walletReverts(burner, kick, "claim", [refuser.target], "TransferFailed");
  await walletReverts(burner, kick, "claim", [ethers.ZeroAddress], "ZeroAddress");
  // once the burner accepts ETH it claims to itself (claim forwards all the gas)
  await send(burner.setMode(MODE.Accept));
  await send(burner.exec(kick.target, kickIface.encodeFunctionData("claim", [burner.target])));
  assert.equal(await bal(burner), D);
  assert.equal(await kick.owedTotal(), 0n);
  assert.equal(await bal(kick), 0n);
});

test("a caller cannot starve a payment into owed by sending too little gas (NotEnoughGas)", async () => {
  const kick = await freshKick({ startIn: 1 });
  const smart = await testWallet(kick, MODE.Busy); // a smart wallet that needs ~66k gas to receive
  await send(kick.registerStakers([smart.target]));
  await warp(2);
  await send(kick.postAttendance([smart.target], D));
  await warp(DAY + 1);
  const tryGas = (gasLimit) => kick.releasePayouts.staticCall({ gasLimit }).then(() => null, (e) => errName(e) ?? "out of gas");
  // with a little too little gas the smart wallet's call would fail; the contract refuses instead of recording it as owed
  const outcomes = new Set();
  for (let g = 60_000; g <= 200_000; g += 2_000) outcomes.add(await tryGas(g));
  assert.ok(outcomes.has("NotEnoughGas"), [...outcomes].join(", "));
  // whatever gas a caller picks, a release that goes through has paid the wallet directly
  let lo = 60_000, hi = 400_000;
  while (hi - lo > 200) {
    const mid = Math.floor((lo + hi) / 2);
    (await tryGas(mid)) === null ? (hi = mid) : (lo = mid);
  }
  const r = await send(kick.connect(guests[61]).releasePayouts({ gasLimit: hi }));
  assert.equal(logsOf(r, kick, "PayoutFailed").length, 0);
  assert.equal(await bal(smart), D);
  assert.equal(await kick.owedTotal(), 0n);

  // a wallet that burns all its gas is recorded as owed only after it had its full PAYOUT_GAS
  const k2 = await freshKick({ startIn: 1 });
  const burner = await testWallet(k2, MODE.BurnGas);
  await send(k2.registerStakers([burner.target]));
  await warp(2);
  await send(k2.postAttendance([burner.target], D));
  await warp(DAY + 1);
  const r2 = await send(k2.connect(guests[61]).releasePayouts({ gasLimit: 1_000_000 }));
  assert.ok(r2.gasUsed > 100_000n, `gas used ${r2.gasUsed}`);
  assert.equal(await k2.owed(burner.target), D);
});

test("cancel refunds every active staker; a wallet that refuses ETH can claim", async () => {
  const kick = await freshKick();
  const gs = guests.slice(80, 84);
  await stake(kick, gs);
  const refuser = await testWallet(kick, MODE.Refuse);
  await send(kick.registerStakers([...(await Promise.all(gs.map(addr))), refuser.target]));
  await send(kick.rejectAndRefund([await addr(gs[3])]));
  const b0 = await bal(gs[0]);
  await send(kick.cancel());
  assert.equal(await bal(gs[0]), b0 + D);
  assert.equal(await kick.owed(refuser.target), D);
  assert.equal(await kick.reserved(), D);
  await reverts(kick, "registerStakers", [[await addr(guests[90])]], "NotOpen");
  // a registered staker was already paid back by cancel; cannot be "rejected" again
  await reverts(kick, "rejectAndRefund", [[await addr(gs[0])]], "CannotReject");
  // a payer who was never registered can't send after cancel (the deposit is refused), but one who paid
  // before cancel and was not registered can still be refunded from spare money
  const k2 = await freshKick();
  const late = guests[91];
  await stake(k2, [late]);
  await send(k2.cancel());
  const lb = await bal(late);
  await send(k2.rejectAndRefund([await addr(late)]));
  assert.equal(await bal(late), lb + D);
  await send(refuser.setMode(MODE.Accept));
  await send(refuser.exec(kick.target, kickIface.encodeFunctionData("claim", [refuser.target])));
  assert.equal(await bal(kick), 0n);
});

test("emergencyWithdraw only after the deadline, only for active stakers, only once", async () => {
  const W = 7 * 86400;
  const kick = await freshKick({ startIn: 10, deadlineIn: 10 + W });
  const gs = guests.slice(100, 103);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  const to0 = await addr(gs[0]);
  await reverts(kick.connect(gs[0]), "emergencyWithdraw", [to0], "TooEarly");
  await warp(11 + W);
  // after the deadline the organiser can no longer settle: no last-second race with stakers
  await reverts(kick, "postAttendance", [[await addr(gs[1])], 3n * D], "TooLate");
  await reverts(kick, "cancel", [], "TooLate");
  const b0 = await bal(gs[0]);
  const r = await send(kick.connect(gs[0]).emergencyWithdraw(to0));
  assert.equal(await bal(gs[0]), b0 + D - r.fee);
  assert.equal(await kick.stakerCount(), 2n);
  await reverts(kick.connect(gs[0]), "emergencyWithdraw", [to0], "NotAStaker");
  await reverts(kick.connect(guests[105]), "emergencyWithdraw", [await addr(guests[105])], "NotAStaker");
  await reverts(kick.connect(gs[1]), "emergencyWithdraw", [kick.target], "ZeroAddress");
  // a staker can withdraw to another address of their own
  const alt = await addr(guests[106]);
  const ab = await bal(alt);
  await send(kick.connect(gs[1]).emergencyWithdraw(alt));
  assert.equal(await bal(alt), ab + D);
  await send(kick.connect(gs[2]).emergencyWithdraw(await addr(gs[2])));
  assert.equal(await bal(kick), 0n);
});

test("a wallet that refuses ETH in a reject batch is kept for claim; the rest are refunded", async () => {
  const kick = await freshKick();
  const gs = guests.slice(120, 122);
  await stake(kick, gs);
  const refuser = await testWallet(kick, MODE.Refuse);
  const b = [await bal(gs[0]), await bal(gs[1])];
  await send(kick.rejectAndRefund([await addr(gs[0]), refuser.target, await addr(gs[1])]));
  assert.equal(await bal(gs[0]), b[0] + D);
  assert.equal(await bal(gs[1]), b[1] + D);
  assert.equal(await kick.owed(refuser.target), D);
  assert.equal(await kick.spare(), 0n); // the owed deposit is reserved, refund() cannot touch it
  await reverts(kick, "refund", [await addr(owner), 1n], "InsufficientBalance");
  await send(refuser.exec(kick.target, kickIface.encodeFunctionData("claim", [await addr(guests[123])])));
  assert.equal(await bal(kick), 0n);
});

test("two-step ownership", async () => {
  const kick = await freshKick();
  const [n, x] = guests.slice(110);
  await send(kick.transferOwnership(await addr(n)));
  assert.equal(await kick.owner(), await addr(owner));
  await reverts(kick.connect(x), "acceptOwnership", [], "NotPendingOwner");
  await send(kick.connect(n).acceptOwnership());
  assert.equal(await kick.owner(), await addr(n));
  await reverts(kick, "registerStakers", [[await addr(x)]], "NotOwner");
});

test("150 guests: register in batches, post 120 attendees and release, all fit easily in a block", async () => {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(0, 150);
  await stake(kick, gs);
  const all = await Promise.all(gs.map(addr));
  let regGas = 0n;
  for (let i = 0; i < 150; i += 50) regGas += (await send(kick.registerStakers(all.slice(i, i + 50)))).gasUsed;
  await warp(2);
  const att = all.slice(0, 120);
  const share = (D * 150n) / 120n;
  assert.equal(share, E("0.0125"));
  const p = await send(kick.postAttendance(att, share));
  await warp(DAY + 1);
  const r = await send(kick.releasePayouts());
  console.log(`  gas: register 150 = ${regGas}, post 120 = ${p.gasUsed}, release 120 = ${r.gasUsed}`);
  assert.ok(p.gasUsed < 10_000_000n && r.gasUsed < 10_000_000n);
  assert.equal(await bal(kick), 0n);
});

// ------------------------------------------------------------------ Kleros challenges

async function listed(slice, attendingCount) {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(...slice);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  await warp(2);
  const att = await Promise.all(gs.slice(0, attendingCount).map(addr));
  await send(kick.postAttendance(att, (D * BigInt(gs.length)) / BigInt(att.length)));
  return { kick, gs };
}
// 4 stakers, 3 final attendees
const THIRD = (4n * D) / 3n;

test("challenge guards: only listed-out stakers, inside the window, with the Kleros fee", async () => {
  const { kick, gs } = await listed([140, 144], 2); // gs[2], gs[3] left off
  assert.equal(await kick.challengeDeposit(), FEE);
  await reverts(kick.connect(gs[0]), "challenge", [{ value: FEE }], "AlreadyAttending");
  await reverts(kick.connect(guests[145]), "challenge", [{ value: FEE }], "NotAStaker");
  await reverts(kick.connect(gs[2]), "challenge", [{ value: FEE - 1n }], "WrongDeposit");
  await reverts(kick, "matchChallenge", [await addr(gs[2]), { value: FEE }], "NoChallenge");
  // overpaying is fine: the extra comes straight back
  const e0 = await bal(gs[2]);
  const r = await send(kick.connect(gs[2]).challenge({ value: FEE * 2n }));
  assert.equal(await bal(gs[2]), e0 - FEE - r.fee);
  assert.equal(await kick.challengeEscrow(), FEE);
  assert.equal(await kick.reserved(), 4n * D + FEE);
  await reverts(kick.connect(gs[2]), "challenge", [{ value: FEE }], "AlreadyChallenged");
  await reverts(kick, "resolveChallenge", [await addr(gs[2])], "TooEarly");
  await reverts(kick, "matchChallenge", [await addr(gs[2]), { value: FEE - 1n }], "WrongDeposit");
  // the challenge window closes after 1 day
  await warp(DAY + 1);
  await reverts(kick.connect(gs[3]), "challenge", [{ value: FEE }], "TooLate");
  // the match window (1 day from the challenge) has closed too
  await reverts(kick, "matchChallenge", [await addr(gs[2]), { value: FEE }], "TooLate");
});

test("unmatched challenge: the guest counts as attended, gets the deposit back, shares the pool", async () => {
  const { kick, gs } = await listed([0, 4], 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  assert.equal(await bal(kick), 4n * D + FEE);
  await warp(DAY + 1);
  const e0 = await bal(g);
  // releasePayouts accepts the unmatched challenge on its own: 4 deposits over 3 attendees
  await send(kick.connect(guests[150]).releasePayouts());
  assert.equal(await bal(g), e0 + FEE + THIRD);
  assert.equal(await kick.attendeeCount(), 3n);
  assert.equal(await kick.challengeEscrow(), 0n);
  assert.equal(await bal(kick), 4n * D - 3n * THIRD); // rounding dust only
  const c = await kick.challenges(await addr(g));
  assert.equal(c.state, 3n); // Resolved
});

test("matched challenge opens a Kleros v1 case through the Dispute Resolver; payouts go out anyway, with the challenger's share set aside", async () => {
  const { kick, gs } = await listed([4, 8], 2);
  const [g, m] = [gs[2], owner];
  await send(kick.connect(g).challenge({ value: FEE }));
  const l0 = await bal(liquid);
  const r = await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE + 7n })); // extra comes back
  const c = await kick.challenges(await addr(g));
  assert.equal(c.state, 2n); // Disputed
  assert.equal(c.matcher, await addr(m));
  assert.equal(c.arbitratorDisputeID, 1000n + c.localDisputeID); // two numbers for one case, like on mainnet
  assert.equal(await proxy.externalIDtoLocalID(c.arbitratorDisputeID), c.localDisputeID);
  assert.equal(await bal(liquid), l0 + FEE); // Kleros got exactly its fee
  assert.equal(await bal(kick), 4n * D + FEE); // the pool + what is left of the two deposits
  assert.equal(await kick.challengeEscrow(), FEE);
  const [ev] = logsOf(r, kick, "ChallengeMatched");
  assert.deepEqual([...ev.args], [await addr(g), await addr(m), c.arbitratorDisputeID, c.localDisputeID]);
  // the Dispute Resolver opened the case with the static metaevidence, 2 ruling options and the court settings
  const pd = await proxy.disputes(c.localDisputeID);
  assert.equal(pd.disputeIDOnArbitratorSide, c.arbitratorDisputeID);
  assert.equal(pd.arbitratorExtraData, EXTRA);
  assert.equal(pd.isRuled, false);
  assert.equal(await proxy.numberOfRulingOptions(c.localDisputeID), 2n);
  const [meta] = logsOf(r, proxy, "MetaEvidence");
  assert.deepEqual([...meta.args], [c.localDisputeID, META]);
  const [disp] = logsOf(r, proxy, "Dispute");
  assert.deepEqual([...disp.args], [liquid.target, c.arbitratorDisputeID, c.localDisputeID, c.localDisputeID]);
  const ld = await liquid.disputes(c.arbitratorDisputeID);
  assert.equal(ld.arbitrated, proxy.target);
  assert.equal(ld.numberOfChoices, 2n);
  assert.equal(ld.drawsInRound, 3n); // 3 jurors, from the extra data
  await reverts(kick, "addAttendees", [[await addr(g)]], "InDispute"); // the jurors decide now
  await warp(DAY * 3);
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled");
  const [a0, a1] = [await bal(gs[0]), await bal(gs[1])];
  await send(kick.connect(guests[151]).releasePayouts()); // 3 shares: two attendees paid, one set aside
  assert.equal(await bal(gs[0]), a0 + THIRD);
  assert.equal(await bal(gs[1]), a1 + THIRD);
  assert.equal(await kick.heldBack(), THIRD);
  assert.equal((await kick.challenges(await addr(g))).heldShare, THIRD);
  assert.equal(await kick.reserved(), THIRD + FEE);
  assert.equal(await kick.spare(), 4n * D - 3n * THIRD); // rounding dust only
  await send(liquid.giveFinalRuling(c.arbitratorDisputeID, 1, KGAS)); // jurors: attended
  const e0 = await bal(g);
  const rr = await send(kick.connect(guests[151]).resolveChallenge(await addr(g)));
  assert.equal(await bal(g), e0 + FEE + THIRD); // the other side's deposit (after the fee) and the share set aside
  assert.deepEqual(logsOf(rr, kick, "Payout").map((l) => [l.args.to, l.args.amount]), [[await addr(g), THIRD]]);
  assert.equal(await kick.attended(await addr(g)), true);
  assert.equal(await kick.heldBack(), 0n);
  assert.equal(await kick.challengeEscrow(), 0n);
  assert.equal((await kick.challenges(await addr(g))).heldShare, 0n);
  assert.equal(await bal(kick), 4n * D - 3n * THIRD);
  await reverts(kick, "resolveChallenge", [await addr(g)], "WrongChallengeState");
});

test("evidence goes to the Dispute Resolver under the case's local ID, from anyone's wallet, until the case is ruled", async () => {
  const { kick, gs } = await listed([8, 12], 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.matchChallenge(await addr(g), { value: FEE }));
  const c = await kick.challenges(await addr(g));
  const r1 = await send(proxy.connect(g).submitEvidence(c.localDisputeID, "/ipfs/QmGuestEvidence/photo.json"));
  const r2 = await send(proxy.connect(owner).submitEvidence(c.localDisputeID, "/ipfs/QmOrganiserEvidence/door-list.json"));
  const evs = [...logsOf(r1, proxy, "Evidence"), ...logsOf(r2, proxy, "Evidence")];
  assert.deepEqual(evs.map((e) => [e.args._arbitrator, e.args._evidenceGroupID, e.args._party]), [
    [liquid.target, c.localDisputeID, await addr(g)],
    [liquid.target, c.localDisputeID, await addr(owner)],
  ]);
  // the Dispute event links Kleros's case number to that evidence group
  const [disp] = await proxy.queryFilter(proxy.filters.Dispute(liquid.target, c.arbitratorDisputeID));
  assert.equal(disp.args._evidenceGroupID, c.localDisputeID);
  await send(liquid.giveFinalRuling(c.arbitratorDisputeID, 2, KGAS));
  await assert.rejects(proxy.submitEvidence.staticCall(c.localDisputeID, "/ipfs/QmLate/x.json"), /Cannot submit evidence to a resolved dispute/);
});

test("Kleros rules absent: the matcher is repaid and the guest forfeits", async () => {
  const { kick, gs } = await listed([12, 16], 2);
  const [g, m] = [gs[2], guests[152]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const c = await kick.challenges(await addr(g));
  await send(liquid.giveFinalRuling(c.arbitratorDisputeID, 2, KGAS));
  const [em, eg] = [await bal(m), await bal(g)];
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await bal(m), em + FEE);
  assert.equal(await bal(g), eg);
  await warp(DAY + 1);
  const [u0, a0] = [await bal(g), await bal(gs[0])];
  await send(kick.connect(owner).releasePayouts());
  assert.equal(await bal(g), u0); // nothing
  assert.equal(await bal(gs[0]), a0 + 2n * D); // 4 deposits over 2 attendees
  assert.equal(await bal(kick), 0n);
});

test("Kleros refuses to arbitrate (ruling 0): both sides get half back, guest stays off the list", async () => {
  const { kick, gs } = await listed([16, 19], 2);
  const [g, m] = [gs[2], guests[153]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  await send(liquid.giveFinalRuling((await kick.challenges(await addr(g))).arbitratorDisputeID, 0, KGAS));
  const [eg, em] = [await bal(g), await bal(m)];
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await bal(g), eg + FEE / 2n);
  assert.equal(await bal(m), em + FEE - FEE / 2n);
  assert.equal(await kick.attended(await addr(g)), false);
  assert.equal(await kick.challengeEscrow(), 0n);
});

test("the organiser can add a forgotten guest during the window; a waiting challenge is refunded", async () => {
  const { kick, gs } = await listed([19, 23], 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  const e0 = await bal(g);
  await reverts(kick.connect(g), "addAttendees", [[await addr(g)]], "NotOwner");
  await send(kick.addAttendees([await addr(g), await addr(gs[3])]));
  assert.equal(await bal(g), e0 + FEE);
  assert.equal(await kick.attendeeCount(), 4n);
  assert.equal(await kick.pendingChallenges(), 0n);
  assert.equal(await kick.challengeEscrow(), 0n);
  await reverts(kick, "addAttendees", [[await addr(g)]], "DuplicateAttendee");
  await warp(DAY + 1);
  await reverts(kick, "addAttendees", [[await addr(guests[154])]], "TooLate");
  await send(kick.releasePayouts());
  assert.equal(await bal(kick), 0n);
});

test("a match is refused if the Kleros fee more than doubled since the challenge", async () => {
  const { kick, gs } = await listed([23, 26], 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  try {
    await send(liquid.setFeeForJuror(2n * FEE_PER_JUROR + 1n, KGAS));
    await reverts(kick, "matchChallenge", [await addr(g), { value: FEE }], "ArbitrationCostTooHigh");
    await send(liquid.setFeeForJuror(2n * FEE_PER_JUROR, KGAS)); // exactly double: both deposits pay the fee
    await send(kick.matchChallenge(await addr(g), { value: FEE }));
    assert.equal((await kick.challenges(await addr(g))).arbitrationPaid, 2n * FEE);
    assert.equal(await kick.challengeEscrow(), 0n);
  } finally {
    await send(liquid.setFeeForJuror(FEE_PER_JUROR, KGAS));
  }
});

const W_ALL = "withdrawFeesAndRewardsForAllRounds";

test("appeals are funded on the Dispute Resolver from the funders' own wallets; it pays them directly; only the final ruling counts", async () => {
  const { kick, gs } = await listed([26, 30], 2);
  const [g, m, crowd, bot] = [gs[2], guests[156], guests[157], guests[151]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const { arbitratorDisputeID: id, localDisputeID: local } = await kick.challenges(await addr(g));
  await warp(DAY + 1);
  await reverts(kick, "appealStatus", [await addr(gs[3])], "NotAppealable");
  assert.equal((await kick.appealStatus(await addr(g))).end, 0n); // the jurors have not voted yet

  // round 1: jurors say "did not attend"; the guest's side appeals (cost + 2x), the matcher's side defends (cost + 1x)
  await send(liquid.startAppealPeriod(id, 2, 3 * DAY, KGAS));
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled"); // a round-1 vote is not final
  const cost = await liquid.appealCost(id, EXTRA);
  assert.equal(cost, 7n * FEE_PER_JUROR); // next jury: 2 x 3 + 1 jurors
  const st = await kick.appealStatus(await addr(g));
  assert.equal(st.ruling, 2n);
  assert.equal(st.costAttended, 3n * cost); // lost the vote: cost + 2x
  assert.equal(st.costAbsent, 2n * cost); // won the vote: cost + 1x
  assert.equal(st.loserEnd, st.start + (st.end - st.start) / 2n);
  const part = E("0.02");
  await send(proxy.connect(crowd).fundAppeal(local, 1, { value: part, gasLimit: 500000 })); // crowdfunding: anyone can chip in
  const e0 = await bal(g);
  const r = await send(proxy.connect(g).fundAppeal(local, 1, { value: 3n * cost, gasLimit: 500000 })); // more than missing
  const rest = 3n * cost - part;
  assert.equal(await bal(g), e0 - rest - r.fee); // the Dispute Resolver returned the surplus to the funder
  const contributions = await proxy.queryFilter(proxy.filters.Contribution(local));
  assert.deepEqual(contributions.map((l) => [l.args.contributor, l.args.ruling, l.args.amount]), [
    [await addr(crowd), 1n, part],
    [await addr(g), 1n, rest],
  ]); // Kleros records the real funders, never the deposit contract
  await send(proxy.connect(m).fundAppeal(local, 2, { value: 2n * cost, gasLimit: 500000 }));
  assert.equal(await liquid.rounds(id), 2n); // both sides funded: a new, bigger jury
  assert.equal((await liquid.disputes(id)).period, 0n); // evidence period again
  assert.equal((await kick.appealStatus(await addr(g))).end, 0n); // round 2 is not in its appeal period yet
  assert.equal(await bal(kick), 4n * D + FEE); // only the pool and what is left of the challenge deposits
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled");

  // round 2: jurors say "attended"; nobody appeals; the ruling becomes final
  await send(liquid.startAppealPeriod(id, 1, DAY, KGAS));
  assert.equal((await kick.appealStatus(await addr(g))).costAbsent, 3n * 15n * FEE_PER_JUROR); // 15 jurors next, loser pays 3x
  await warp(DAY + 1);
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled");
  await send(liquid.passPeriod(id, KGAS));
  await send(liquid.executeRuling(id, KGAS));
  const pd = await proxy.disputes(local);
  assert.deepEqual([pd.isRuled, pd.ruling], [true, 1n]);
  // funders collect refunds and rewards from the Dispute Resolver straight to their wallets (anyone can trigger it)
  const rewards = 3n * cost + 2n * cost - cost; // both sides' funding minus the appeal fee, to the "attended" funders
  assert.equal(await proxy.getTotalWithdrawableAmount(local, await addr(crowd), [1, 2]), (part * rewards) / (3n * cost));
  const c0 = await bal(crowd);
  await send(proxy.connect(bot)[W_ALL](local, await addr(crowd), [1, 2], KGAS));
  assert.equal(await bal(crowd), c0 + (part * rewards) / (3n * cost));
  const g0 = await bal(g);
  await send(proxy.connect(bot)[W_ALL](local, await addr(g), [1, 2], KGAS));
  assert.equal(await bal(g), g0 + (rest * rewards) / (3n * cost));
  assert.equal(await proxy.getTotalWithdrawableAmount(local, await addr(m), [1, 2]), 0n); // backed the losing side
  assert.equal(await proxy.getTotalWithdrawableAmount(local, kick.target, [1, 2]), 0n); // nothing is owed to the deposit contract
  assert.equal(await bal(kick), 4n * D + FEE);

  // the deposit contract settles from the final ruling alone
  const e1 = await bal(g);
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await bal(g), e1 + FEE); // the final winner gets what is left of both deposits
  assert.equal(await kick.attended(await addr(g)), true);
  await reverts(kick, "appealStatus", [await addr(g)], "NotAppealable");
  const u0 = await bal(g);
  await send(kick.connect(bot).releasePayouts());
  assert.equal(await bal(g), u0 + THIRD);
  assert.equal(await bal(kick), 4n * D - 3n * THIRD); // dust only: no appeal money ever passes through this contract
});

test("an appeal funded by one side only wins the case (the Dispute Resolver's override); the contract follows the final ruling", async () => {
  const { kick, gs } = await listed([30, 34], 2); // 4 stakers, 2 on the list
  const [g, m, crowd] = [gs[2], guests[155], guests[158]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const { arbitratorDisputeID: id, localDisputeID: local } = await kick.challenges(await addr(g));
  await warp(DAY + 1);
  await send(kick.releasePayouts()); // 4 deposits / (2 + 1); the challenger's share is set aside
  assert.equal((await kick.challenges(await addr(g))).heldShare, THIRD);

  // round 1: jurors say "did not attend". The crowd and the guest fully fund "attended";
  // the matcher's side raises only part of "did not attend" and nobody completes it
  await send(liquid.startAppealPeriod(id, 2, 2 * DAY, KGAS));
  const cost = await liquid.appealCost(id, EXTRA);
  await send(proxy.connect(crowd).fundAppeal(local, 1, { value: cost, gasLimit: 500000 }));
  await send(proxy.connect(g).fundAppeal(local, 1, { value: 2n * cost, gasLimit: 500000 }));
  await send(proxy.connect(m).fundAppeal(local, 2, { value: cost, gasLimit: 500000 }));
  await warp(Math.floor(1.5 * DAY)); // past the losing side's deadline (half the period)
  await assert.rejects(proxy.connect(crowd).fundAppeal.staticCall(local, 1, { value: 1n }), /Funding must be made within the appeal period/);
  await warp(DAY);
  await assert.rejects(proxy.connect(m).fundAppeal.staticCall(local, 2, { value: cost }), /Funding must be made within the appeal period/);
  await send(liquid.passPeriod(id, KGAS));
  await send(liquid.executeRuling(id, KGAS));
  assert.equal(await liquid.rounds(id), 1n); // no new round
  assert.equal(await liquid.currentRuling(id), 2n); // the jurors voted "absent"...
  assert.equal((await proxy.disputes(local)).ruling, 1n); // ...but only "attended" was funded: final ruling "attended"

  const e0 = await bal(g);
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await kick.attended(await addr(g)), true);
  assert.equal(await bal(g), e0 + THIRD + FEE); // the share set aside and what is left of both challenge deposits
  assert.equal(await kick.heldBack(), 0n);
  // no appeal took place, so the Dispute Resolver reimburses every funder in full, directly
  for (const [w, paid] of [[crowd, cost], [m, cost], [g, 2n * cost]]) {
    const b0 = await bal(w);
    await send(proxy.connect(guests[151])[W_ALL](local, await addr(w), [1, 2], KGAS));
    assert.equal(await bal(w), b0 + paid);
  }
  assert.equal(await bal(kick), 4n * D - 3n * THIRD);
});

test("appealStatus matches the Dispute Resolver's saturating maths when Kleros quotes a non-payable appeal", async () => {
  const { kick, gs } = await listed([34, 37], 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.matchChallenge(await addr(g), { value: FEE }));
  const { arbitratorDisputeID: id } = await kick.challenges(await addr(g));
  try {
    await send(liquid.setJurorsForCourtJump(3, KGAS)); // the General Court cannot grow further
    await send(liquid.startAppealPeriod(id, 1, DAY, KGAS));
    const N_ = await liquid.NON_PAYABLE_AMOUNT();
    assert.equal(await liquid.appealCost(id, EXTRA), N_);
    const mulCap = (a, b) => (a * b > MAX ? MAX : a * b);
    const addCap = (a, b) => (a + b > MAX ? MAX : a + b);
    const st = await kick.appealStatus(await addr(g));
    assert.equal(st.costAttended, addCap(N_, mulCap(N_, 10000n) / 10000n));
    assert.equal(st.costAbsent, addCap(N_, mulCap(N_, 20000n) / 10000n));
  } finally {
    await send(liquid.setJurorsForCourtJump(511, KGAS));
  }
});

// Several Kleros cases open at payout. Stakers: the first `listedCount` are on the list, then one
// matched challenger per entry of `rulings`, the rest are no-shows. Settles the cases in `order` and
// checks after every step that heldBack is the sum of the open cases' set-aside amounts, that the
// balance covers reserved(), and that every attendee so far has received what each open case holds.
// Pool money is followed through the Payout events (challenge money and gas are not logged there).
async function heldCases(slice, listedCount, rulings, order) {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(...slice);
  const all = await Promise.all(gs.map(addr));
  await Promise.all(gs.map((g) => send(g.sendTransaction({ to: kick.target, value: D })))); // different senders: in parallel
  await send(kick.registerStakers(all));
  await warp(2);
  await send(kick.postAttendance(all.slice(0, listedCount), (D * BigInt(gs.length)) / BigInt(listedCount)));
  const chs = all.slice(listedCount, listedCount + rulings.length);
  for (const [i, c] of chs.entries()) {
    await send(kick.connect(gs[listedCount + i]).challenge({ value: FEE, gasLimit: 500000 }));
    await send(kick.matchChallenge(c, { value: FEE, gasLimit: 1_000_000 }));
  }
  await warp(DAY + 1);
  const from = await prov.getBlockNumber();
  const received = async () => {
    const got = new Map(all.map((a) => [a, 0n]));
    for (const l of await kick.queryFilter(kick.filters.Payout(), from + 1)) got.set(l.args.to, got.get(l.args.to) + l.args.amount);
    return got;
  };
  const check = async () => {
    const held = await Promise.all(chs.map(async (c) => (await kick.challenges(c)).heldShare));
    assert.equal(await kick.heldBack(), held.reduce((x, y) => x + y, 0n));
    assert.ok((await bal(kick)) >= (await kick.reserved()));
    const got = await received();
    const paid = [...new Set((await kick.attendees()).map((a) => got.get(a)))];
    assert.equal(paid.length, 1, `attendees received different totals: ${paid}`);
    for (const h of held) if (h > 0n) assert.equal(h, paid[0]); // a later winner gets exactly what attendees got
  };
  await send(kick.releasePayouts({ gasLimit: 3_000_000 }));
  await check();
  for (const i of order) {
    await send(liquid.giveFinalRuling((await kick.challenges(chs[i])).arbitratorDisputeID, rulings[i], KGAS));
    await send(kick.resolveChallenge(chs[i], { gasLimit: 3_000_000 }));
    await check();
  }
  assert.equal(await kick.heldBack(), 0n);
  assert.equal(await kick.challengeEscrow(), 0n);
  assert.equal(await kick.reserved(), 0n);
  const got = await received();
  const atts = await kick.attendees();
  assert.equal(atts.length, listedCount + rulings.filter((r) => r === 1).length);
  const total = got.get(atts[0]);
  const pool = D * BigInt(gs.length);
  const dust = await bal(kick);
  assert.equal(total * BigInt(atts.length) + dust, pool); // nothing lost: the pool is paid out, dust aside
  assert.ok(dust < BigInt(atts.length) * 3n, `dust ${dust}`);
  for (const c of chs) if (!atts.includes(c)) assert.equal(got.get(c), 0n); // lost cases get nothing
  await send(kick.sweep(await addr(owner))); // only the rounding dust is spare
  assert.equal(await bal(kick), 0n);
  return { total, got };
}

test("two Kleros cases open at payout (one won, one lost): every final attendee gets the same, in either settlement order", async () => {
  // 8 stakers; 5 on the list; A wins, B loses; 1 no-show. 8 / 7 leaves rounding dust
  const won = await heldCases([0, 8], 5, [1, 2], [0, 1]);
  const lost = await heldCases([0, 8], 5, [1, 2], [1, 0]);
  assert.equal(won.total, lost.total);
  const ideal = (8n * D) / 6n;
  assert.ok(ideal - won.total <= 2n, `${won.total} vs ${ideal}`); // 8 deposits / 6 attendees, less a few wei of rounding dust
});

test("three Kleros cases open at payout: every final attendee gets the same total whether the winner settles first, between or last", async () => {
  // 10 stakers; 4 on the list; A wins, B is ruled absent, C gets a refusal to arbitrate (0); 3 no-shows
  const totals = [];
  for (const order of [[0, 1, 2], [1, 0, 2], [2, 1, 0]]) {
    totals.push((await heldCases([8, 18], 4, [1, 2, 0], order)).total);
  }
  const [lo, hi] = [totals.reduce((a, b) => (a < b ? a : b)), totals.reduce((a, b) => (a > b ? a : b))];
  assert.ok(hi - lo <= 2n, `totals differ by more than rounding dust: ${totals}`);
  assert.ok(hi <= 2n * D && 2n * D - lo <= 5n, `${totals}`); // 10 deposits / 5 attendees, less a few wei
});

test("a lost case's set-aside share is split among the attendees; a challenge waiting for a match still holds the payout", async () => {
  const { kick, gs } = await listed([37, 41], 2); // 4 stakers, 2 on the list
  const [g, late] = [gs[2], gs[3]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.matchChallenge(await addr(g), { value: FEE }));
  await warp(DAY - 60);
  await send(kick.connect(late).challenge({ value: FEE })); // last-minute challenge: its match window runs 1 more day
  await warp(120);
  await reverts(kick, "releasePayouts", [], "ChallengesPending");
  await warp(DAY);
  const before = await Promise.all([gs[0], gs[1], late].map(bal));
  const g0 = await bal(g);
  await send(kick.connect(guests[150]).releasePayouts()); // late is accepted unmatched; g's case is open: 4 deposits / (3 + 1)
  const mid = await Promise.all([gs[0], gs[1], late].map(bal));
  assert.deepEqual(mid.map((b, i) => b - before[i]), [D, D, D + FEE]); // late also gets the challenge deposit back
  assert.equal(await kick.payoutShare(), D);
  assert.equal(await kick.heldBack(), D);
  assert.equal(await kick.spare(), 0n); // the set-aside share and the case's challenge money cannot be swept or refunded
  await reverts(kick, "refund", [await addr(owner), 1n], "InsufficientBalance");
  await send(liquid.giveFinalRuling((await kick.challenges(await addr(g))).arbitratorDisputeID, 2, KGAS)); // jurors: absent
  await send(kick.connect(guests[150]).resolveChallenge(await addr(g)));
  const each = D / 3n;
  const end = await Promise.all([gs[0], gs[1], late].map(bal));
  assert.deepEqual(end.map((b, i) => b - mid[i]), [each, each, each]);
  assert.equal(await bal(g), g0); // the challenger lost: nothing
  assert.equal(await bal(kick), D - 3n * each); // rounding dust
  await reverts(kick.connect(late), "claim", [kick.target], "NothingToClaim");
});

test("a wallet that refuses ETH keeps its challenge money and share in owed, and claims them to another address", async () => {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(41, 43);
  await stake(kick, gs);
  const refuser = await testWallet(kick); // accepts ETH for now
  await send(kick.registerStakers([...(await Promise.all(gs.map(addr))), refuser.target]));
  await warp(2);
  await send(kick.postAttendance(await Promise.all(gs.map(addr)), (D * 3n) / 2n));
  await send(refuser.exec(kick.target, kickIface.encodeFunctionData("challenge"), { value: FEE + 3n })); // the extra 3 wei come back
  assert.equal(await bal(refuser), 3n);
  await send(refuser.setMode(MODE.Refuse));
  await warp(DAY + 1);
  await send(kick.releasePayouts({ gasLimit: 1_000_000 })); // unmatched: accepted, but the challenge deposit and the share bounce
  const share = D; // 3 deposits / 3 attendees
  assert.equal(await kick.owed(refuser.target), FEE + share);
  assert.equal(await kick.reserved(), FEE + share);
  const to = await addr(guests[155]);
  const e0 = await bal(to);
  await send(refuser.exec(kick.target, kickIface.encodeFunctionData("claim", [to])));
  assert.equal(await bal(to), e0 + FEE + share);
  assert.equal(await kick.owed(refuser.target), 0n);
  assert.equal(await bal(kick), 0n);
});

test("refund and sweep only ever move spare ETH: never the pool, unclaimed payments, challenge money or set-aside shares", async () => {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(43, 49); // 6 guests
  await stake(kick, gs);
  const refuser = await testWallet(kick); // will refuse its share
  const extra = E("0.003");
  await send(gs[0].sendTransaction({ to: kick.target, value: extra })); // an overpayment
  const stray = guests[49];
  await stake(kick, [stray]); // paid, never registered
  const stakers = [...(await Promise.all(gs.map(addr))), refuser.target];
  await send(kick.registerStakers(stakers)); // 7 stakers
  const expectSpare = async (v) => {
    assert.equal(await kick.spare(), v);
    assert.equal(await bal(kick), (await kick.reserved()) + v);
  };
  await expectSpare(extra + D);
  await reverts(kick, "refund", [await addr(owner), extra + D + 1n], "InsufficientBalance");
  await warp(2);
  // 5 on the list; gs[4] and gs[5] left off
  await send(kick.postAttendance([...stakers.slice(0, 4), refuser.target], (7n * D) / 5n));
  await send(kick.connect(gs[4]).challenge({ value: FEE })); // will go unmatched
  await send(kick.connect(gs[5]).challenge({ value: FEE }));
  await send(kick.matchChallenge(stakers[5], { value: FEE })); // a Kleros case
  assert.equal(await kick.challengeEscrow(), 2n * FEE); // gs[4]'s deposit + both of gs[5]'s, less the Kleros fee
  await expectSpare(extra + D);
  await reverts(kick, "refund", [await addr(owner), extra + D + 1n], "InsufficientBalance");
  await reverts(kick, "sweep", [await addr(owner)], "NotSettled");
  await warp(DAY + 1);
  await send(refuser.setMode(MODE.Refuse));
  await send(kick.connect(guests[150]).releasePayouts({ gasLimit: 2_000_000 })); // 7 deposits / (6 attendees + 1 open case) = 1 each
  assert.equal(await kick.payoutShare(), D);
  assert.equal(await kick.owed(refuser.target), D);
  assert.equal(await kick.heldBack(), D);
  assert.equal(await kick.challengeEscrow(), FEE);
  assert.equal(await kick.reserved(), D + D + FEE); // set-aside share + owed share + the open case's challenge money
  await expectSpare(extra + D);
  // the organiser returns the stray deposit and the overpayment; nothing more can leave
  await send(kick.refund(await addr(stray), D));
  await send(kick.refund(await addr(gs[0]), extra));
  await expectSpare(0n);
  await reverts(kick, "refund", [await addr(owner), 1n], "InsufficientBalance");
  // a late payer can't be refunded out of the challenge money either (FEE > D is sitting there)
  await reverts(kick, "rejectAndRefund", [[await addr(guests[60])]], "InsufficientBalance");
  const o0 = await bal(kick);
  await send(kick.sweep(await addr(owner)));
  assert.equal(await bal(kick), o0); // nothing spare to sweep
  // the case is lost: the matcher gets the challenge money back, the held share is split over the 6 attendees
  await send(liquid.giveFinalRuling((await kick.challenges(stakers[5])).arbitratorDisputeID, 2, KGAS));
  await send(kick.connect(guests[150]).resolveChallenge(stakers[5], { gasLimit: 2_000_000 }));
  const each = D / 6n;
  assert.equal(await kick.owed(refuser.target), D + each);
  await expectSpare(D - 6n * each); // rounding dust only
  await send(kick.sweep(await addr(owner)));
  await expectSpare(0n);
  assert.equal(await bal(kick), D + each); // only the refuser's unclaimed payments are left
  await send(refuser.exec(kick.target, kickIface.encodeFunctionData("claim", [await addr(guests[150])])));
  assert.equal(await bal(kick), 0n);
});

test("reentrancy: a recipient calling back into the contract is refused, and its payment still arrives", async () => {
  const kick = await freshKick({ startIn: 1 });
  const g = guests[52];
  await stake(kick, [g]);
  const [w1, w2, w3, w4] = [await testWallet(kick), await testWallet(kick), await testWallet(kick), await testWallet(kick)];
  const reentrancy = kickIface.getError("Reentrancy").selector;
  const notOpen = kickIface.getError("NotOpen").selector;
  await send(kick.registerStakers([await addr(g), w1.target, w2.target, w3.target, w4.target]));

  // while Open, a refunded wallet may deposit again during its refund: that only adds spare ETH
  await send(w1.setReentry(kick.target, kickIface.encodeFunctionData("deposit"), D));
  const r1 = await send(kick.rejectAndRefund([w1.target], { gasLimit: 1_000_000 }));
  assert.equal(await w1.reentryOk(), true);
  assert.deepEqual(logsOf(r1, kick, "Deposited").map((l) => [l.args.from, l.args.amount]), [[w1.target, D]]);
  assert.equal(await kick.stakerCount(), 4n);
  assert.equal(await kick.spare(), D); // the new deposit, not registered
  await reverts(kick, "rejectAndRefund", [[w1.target]], "CannotReject"); // already refunded once
  await send(kick.refund(w1.target, D)); // the organiser returns it as a stray transfer
  assert.equal(await kick.spare(), 0n);

  // during the payout: w2 tries to release again, w3 tries to deposit, w4 refuses its share
  await send(w2.setReentry(kick.target, kickIface.encodeFunctionData("releasePayouts"), 0n));
  await send(w3.setReentry(kick.target, kickIface.encodeFunctionData("deposit"), D));
  await send(w4.setMode(MODE.Refuse));
  await warp(2);
  const list = [await addr(g), w2.target, w3.target, w4.target];
  await send(kick.postAttendance(list, D));
  await warp(DAY + 1);
  await send(kick.connect(guests[53]).releasePayouts({ gasLimit: 2_000_000 }));
  assert.deepEqual([await w2.reentryOk(), await w2.reentryError()], [false, reentrancy]);
  assert.deepEqual([await w3.reentryOk(), await w3.reentryError()], [false, notOpen]); // paid out: deposits are closed
  assert.equal(await bal(w2), D); // the reentry failed, the payment arrived
  assert.equal(await bal(w3), D);
  assert.equal(await kick.owed(w4.target), D);

  // a claim that calls claim again: refused, and the money is paid exactly once
  await send(w4.setReentry(kick.target, kickIface.encodeFunctionData("claim", [w4.target]), 0n));
  await send(w4.exec(kick.target, kickIface.encodeFunctionData("claim", [w4.target])));
  assert.deepEqual([await w4.reentryOk(), await w4.reentryError()], [false, reentrancy]);
  assert.equal(await bal(w4), D);
  assert.equal(await kick.owedTotal(), 0n);
  await walletReverts(w4, kick, "claim", [w4.target], "NothingToClaim");
  assert.equal(await bal(kick), 0n);
});
