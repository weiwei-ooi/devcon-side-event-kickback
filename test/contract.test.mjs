// Contract-level tests (v3): curation refunds, attendance list + Kleros challenges, payouts,
// failed-transfer claims, emergency exit, two-step ownership and a 150-guest run.
// Local in-memory chain (ganache) with stand-ins for the Kleros contracts.
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
const U = (x) => ethers.parseUnits(String(x), 6);
const PORT = 18546;
const N = 160; // accounts: owner + 159 guests

let server, prov, owner, guests, usdc, arbitrator, resolver;
const DAY = 86400;
const FEE = ethers.parseEther("0.015");
const EXTRA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [1, 3, 1]);
const POLICY = "/ipfs/QmPolicyForTests/attendance-policy.md";
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
async function reverts(contract, method, params, errorName) {
  try {
    await contract[method].staticCall(...params);
  } catch (e) {
    const name = e.revert?.name ?? contract.interface.parseError(e.data ?? "0x")?.name;
    assert.equal(name, errorName, `expected ${errorName}, got ${name ?? e.shortMessage}`);
    return;
  }
  assert.fail(`${method} did not revert (expected ${errorName})`);
}
const addr = (s) => s.getAddress();
const bal = async (a) => usdc.balanceOf(typeof a === "string" ? a : await addr(a));
const send = async (p) => (await p).wait();

async function freshKick({ startIn = 3600, deadlineIn = 3600 * 24 * 14 } = {}) {
  const t = await now();
  return deploy("TruthPaysKickback", owner, await usdc.getAddress(), U(15), "Truth Pays", await addr(owner), t + startIn, t + deadlineIn, arb());
}
const arb = () => [resolver.target, EXTRA, POLICY];
// post the list, let the 1-day challenge window pass, release
async function settle(kick, att, share) {
  await send(kick.postAttendance(att, share));
  await warp(DAY + 1);
  return send(kick.releasePayouts());
}
async function stake(kick, gs) {
  for (const g of gs) await send(usdc.connect(g).transfer(await kick.getAddress(), U(15)));
}

before(async () => {
  execFileSync("node", [path.join(root, "scripts/compile.mjs")], { stdio: "ignore" });
  server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337 },
    miner: { blockGasLimit: 120_000_000 },
    wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) },
  });
  await server.listen(PORT);
  prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 1337, { staticNetwork: true });
  prov.pollingInterval = 50; // local chain mines instantly; the 4 s default makes 450+ txs crawl
  const ws = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
  [owner, ...guests] = ws;
  usdc = await deploy("MockUSDC", owner);
  for (const g of guests) await send(usdc.mint(await addr(g), U(100)));
  arbitrator = await deploy("MockArbitrator", owner);
  resolver = await deploy("MockDisputeResolver", owner, arbitrator.target);
  await send(arbitrator.setResolver(resolver.target));
});
after(async () => server && (await server.close()));

test("constructor rejects a deadline before the event start", async () => {
  const t = await now();
  const { abi, bytecode } = load("TruthPaysKickback");
  const f = new ethers.ContractFactory(abi, bytecode, owner);
  // the settlement window after the event must be at least 7 days
  for (const [s, d] of [[t + 100, t + 100], [t + 100, t + 100 + 7 * 86400 - 1]]) {
    await assert.rejects(f.deploy(await usdc.getAddress(), U(15), "x", await addr(owner), s, d, arb()));
    owner.reset(); // the refused deploy used up a nonce locally; resync with the chain
  }
  await assert.rejects(f.deploy(await usdc.getAddress(), U(15), "x", await addr(owner), t + 100, t + 100 + 7 * 86400, [ethers.ZeroAddress, EXTRA, POLICY]));
  owner.reset();
  const ok = await f.deploy(await usdc.getAddress(), U(15), "x", await addr(owner), t + 100, t + 100 + 7 * 86400, arb());
  await ok.waitForDeployment();
});

test("rejectAndRefund: declined payers and dropped stakers get exactly their deposit back", async () => {
  const kick = await freshKick();
  const [a, b, c, d] = guests;
  await stake(kick, [a, b, c, d]);
  await send(kick.registerStakers([await addr(a), await addr(b)]));
  const before = await bal(c);
  // c and d paid but are declined; b drops out after being registered
  await send(kick.rejectAndRefund([await addr(c), await addr(d), await addr(b)]));
  assert.equal(await bal(c), before + U(15));
  assert.equal(await kick.stakerCount(), 1n);
  assert.equal(await bal(await kick.getAddress()), U(15));
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
  // only owner
  await reverts(kick.connect(a), "rejectAndRefund", [[await addr(a)]], "NotOwner");
});

test("refund can only use spare money, never the pool", async () => {
  const kick = await freshKick();
  const [a, b] = guests.slice(20);
  await stake(kick, [a, b]);
  await send(usdc.connect(a).transfer(await kick.getAddress(), U(5))); // overpayment
  await send(kick.registerStakers([await addr(a), await addr(b)]));
  assert.equal(await kick.spare(), U(5));
  await reverts(kick, "refund", [await addr(a), U(6)], "InsufficientBalance");
  await send(kick.refund(await addr(a), U(5)));
  assert.equal(await kick.spare(), 0n);
  await reverts(kick, "refund", [await addr(a), U(1)], "InsufficientBalance");
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
  const share = (U(15) * 4n) / 3n;
  await reverts(kick, "postAttendance", [att, share], "TooEarly");
  await warp(3601);
  await reverts(kick, "postAttendance", [att, U(15)], "ShareMismatch");
  await reverts(kick, "postAttendance", [[], 0n], "NoAttendees");
  await reverts(kick, "postAttendance", [[att[0], att[0]], U(30)], "DuplicateAttendee");
  await reverts(kick, "postAttendance", [[await addr(guests[50])], U(60)], "NotAStaker");
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
  const dust = await bal(await kick.getAddress());
  assert.ok(dust < 3n);
  await send(kick.sweep(await addr(owner)));
  assert.equal(await bal(await kick.getAddress()), 0n);
});

test("a blocklisted attendee does not block the payout; they claim to another address", async () => {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(60, 63);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  await warp(2);
  await send(usdc.setBlocked(await addr(gs[1]), true));
  const others = [await bal(gs[0]), await bal(gs[2])];
  await settle(kick, await Promise.all(gs.map(addr)), U(15));
  assert.equal(await bal(gs[0]), others[0] + U(15));
  assert.equal(await bal(gs[2]), others[1] + U(15));
  assert.equal(await kick.owed(await addr(gs[1])), U(15));
  // sweep must not take the unclaimed payout
  await send(kick.sweep(await addr(owner)));
  assert.equal(await bal(await kick.getAddress()), U(15));
  const alt = await addr(guests[70]);
  const altBefore = await bal(alt);
  await send(kick.connect(gs[1]).claim(alt));
  assert.equal(await bal(alt), altBefore + U(15));
  await reverts(kick.connect(gs[1]), "claim", [alt], "NothingToClaim");
  await send(usdc.setBlocked(await addr(gs[1]), false));
});

test("cancel refunds every active staker; blocked ones can claim", async () => {
  const kick = await freshKick();
  const gs = guests.slice(80, 84);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  await send(kick.rejectAndRefund([await addr(gs[3])]));
  await send(usdc.setBlocked(await addr(gs[2]), true));
  const b0 = await bal(gs[0]);
  await send(kick.cancel());
  assert.equal(await bal(gs[0]), b0 + U(15));
  assert.equal(await kick.owed(await addr(gs[2])), U(15));
  await reverts(kick, "registerStakers", [[await addr(guests[90])]], "NotOpen");
  // a registered staker was already paid back by cancel; cannot be "rejected" again
  await reverts(kick, "rejectAndRefund", [[await addr(gs[0])]], "CannotReject");
  // a late payer (never registered) can still be refunded after settlement
  const late = guests[91];
  await stake(kick, [late]);
  const lb = await bal(late);
  await send(kick.rejectAndRefund([await addr(late)]));
  assert.equal(await bal(late), lb + U(15));
  await send(usdc.setBlocked(await addr(gs[2]), false));
  await send(kick.connect(gs[2]).claim(await addr(gs[2])));
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
  await reverts(kick, "postAttendance", [[await addr(gs[1])], U(45)], "TooLate");
  await reverts(kick, "cancel", [], "TooLate");
  const b0 = await bal(gs[0]);
  await send(kick.connect(gs[0]).emergencyWithdraw(to0));
  assert.equal(await bal(gs[0]), b0 + U(15));
  assert.equal(await kick.stakerCount(), 2n);
  await reverts(kick.connect(gs[0]), "emergencyWithdraw", [to0], "NotAStaker");
  await reverts(kick.connect(guests[105]), "emergencyWithdraw", [await addr(guests[105])], "NotAStaker");
  // a blocklisted staker withdraws to another address of their own
  await send(usdc.setBlocked(await addr(gs[1]), true));
  const alt = await addr(guests[106]);
  const ab = await bal(alt);
  await send(kick.connect(gs[1]).emergencyWithdraw(alt));
  assert.equal(await bal(alt), ab + U(15));
  await send(usdc.setBlocked(await addr(gs[1]), false));
  await send(kick.connect(gs[2]).emergencyWithdraw(await addr(gs[2])));
  assert.equal(await bal(await kick.getAddress()), 0n);
});

test("a blocklisted wallet in a reject batch is kept for claim; the rest are refunded", async () => {
  const kick = await freshKick();
  const gs = guests.slice(120, 123);
  await stake(kick, gs);
  await send(usdc.setBlocked(await addr(gs[1]), true));
  const b = [await bal(gs[0]), await bal(gs[2])];
  await send(kick.rejectAndRefund(await Promise.all(gs.map(addr))));
  assert.equal(await bal(gs[0]), b[0] + U(15));
  assert.equal(await bal(gs[2]), b[1] + U(15));
  assert.equal(await kick.owed(await addr(gs[1])), U(15));
  assert.equal(await kick.spare(), 0n); // the owed 15 is reserved, refund() cannot touch it
  await reverts(kick, "refund", [await addr(owner), 1n], "InsufficientBalance");
  await send(usdc.setBlocked(await addr(gs[1]), false));
  await send(kick.connect(gs[1]).claim(await addr(gs[1])));
  assert.equal(await bal(await kick.getAddress()), 0n);
});

test("tokens that return false or return nothing are handled", async () => {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(130, 133);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  await warp(2);
  try {
    await send(usdc.setMode(1)); // blocked transfers return false instead of reverting
    await send(usdc.setBlocked(await addr(gs[0]), true));
    const b1 = await bal(gs[1]);
    await settle(kick, await Promise.all(gs.map(addr)), U(15));
    assert.equal(await kick.owed(await addr(gs[0])), U(15)); // false = failed, credited
    assert.equal(await bal(gs[1]), b1 + U(15));
    await send(usdc.setMode(2));
    await send(usdc.setBlocked(await addr(gs[0]), false));
    await send(kick.connect(gs[0]).claim(await addr(gs[0]))); // no-data success accepted
    assert.equal(await kick.owed(await addr(gs[0])), 0n);
    assert.equal(await bal(await kick.getAddress()), 0n);
  } finally {
    await send(usdc.setMode(0));
  }
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
  const share = (U(15) * 150n) / 120n; // 18.75
  assert.equal(share, U("18.75"));
  const p = await send(kick.postAttendance(att, share));
  await warp(DAY + 1);
  const r = await send(kick.releasePayouts());
  console.log(`  gas: register 150 = ${regGas}, post 120 = ${p.gasUsed}, release 120 = ${r.gasUsed}`);
  assert.ok(p.gasUsed < 10_000_000n && r.gasUsed < 10_000_000n);
  assert.equal(await bal(await kick.getAddress()), 0n);
});

// ------------------------------------------------------------------ Kleros challenges

async function listed(slice, attendingCount) {
  const kick = await freshKick({ startIn: 1 });
  const gs = guests.slice(...slice);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  await warp(2);
  const att = await Promise.all(gs.slice(0, attendingCount).map(addr));
  await send(kick.postAttendance(att, (U(15) * BigInt(gs.length)) / BigInt(att.length)));
  return { kick, gs };
}
const ethBal = async (s) => prov.getBalance(await addr(s));

test("challenge guards: only listed-out stakers, inside the window, with the exact Kleros fee", async () => {
  const { kick, gs } = await listed([140, 144], 2); // gs[2], gs[3] left off
  assert.equal(await kick.challengeDeposit(), FEE);
  await reverts(kick.connect(gs[0]), "challenge", [{ value: FEE }], "AlreadyAttending");
  await reverts(kick.connect(guests[145]), "challenge", [{ value: FEE }], "NotAStaker");
  await reverts(kick.connect(gs[2]), "challenge", [{ value: FEE - 1n }], "WrongDeposit");
  await reverts(kick, "matchChallenge", [await addr(gs[2]), { value: FEE }], "NoChallenge");
  // overpaying is fine: the extra comes straight back
  const e0 = await ethBal(gs[2]);
  const r = await send(kick.connect(gs[2]).challenge({ value: FEE * 2n }));
  assert.equal(await ethBal(gs[2]), e0 - FEE - r.gasUsed * r.gasPrice);
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
  assert.equal(await prov.getBalance(kick.target), FEE);
  await warp(DAY + 1);
  const e0 = await ethBal(g);
  const u0 = await bal(g);
  // releasePayouts accepts the unmatched challenge on its own: 4 x 15 over 3 attendees = 20 each
  await send(kick.connect(guests[150]).releasePayouts());
  assert.equal(await ethBal(g), e0 + FEE);
  assert.equal(await bal(g), u0 + U(20));
  assert.equal(await kick.attendeeCount(), 3n);
  assert.equal(await prov.getBalance(kick.target), 0n);
  const c = await kick.challenges(await addr(g));
  assert.equal(c.state, 3n); // Resolved
});

test("matched challenge opens a Kleros dispute; payouts go out anyway, with the challenger's share set aside", async () => {
  const { kick, gs } = await listed([4, 8], 2);
  const [g, m] = [gs[2], owner];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const c = await kick.challenges(await addr(g));
  assert.equal(c.state, 2n); // Disputed
  assert.equal(c.arbitratorDisputeID, 1000n + c.localDisputeID);
  assert.equal(await prov.getBalance(kick.target), FEE); // 2 deposits - 1 fee
  // the template is valid JSON naming the wallet, the policy and the arbitrator
  const tpl = JSON.parse(await resolver.lastTemplate());
  assert.match(tpl.question, new RegExp((await addr(g)).toLowerCase()));
  assert.equal(tpl.policyURI, POLICY);
  assert.equal(tpl.arbitratorAddress, arbitrator.target.toLowerCase());
  assert.equal(tpl.arbitratorChainID, "1337");
  assert.deepEqual(tpl.answers.map((a) => a.id), ["0x1", "0x2"]);
  await reverts(kick, "addAttendees", [[await addr(g)]], "InDispute"); // the jurors decide now
  await warp(DAY * 3);
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled");
  const [a0, a1] = [await bal(gs[0]), await bal(gs[1])];
  await send(kick.releasePayouts()); // 60 = 3 shares of 20: two attendees paid, one set aside
  assert.equal(await bal(gs[0]), a0 + U(20));
  assert.equal(await bal(gs[1]), a1 + U(20));
  assert.equal(await kick.heldBack(), U(20));
  assert.equal(await kick.reserved(), U(20));
  assert.equal(await kick.spare(), 0n);
  await send(resolver.giveRuling(c.localDisputeID, 1)); // jurors: attended
  const [e0, u0] = [await ethBal(g), await bal(g)];
  await send(kick.connect(guests[151]).resolveChallenge(await addr(g)));
  assert.equal(await ethBal(g), e0 + FEE); // winner gets the other side's deposit
  assert.equal(await bal(g), u0 + U(20)); // and the share set aside
  assert.equal(await kick.attended(await addr(g)), true);
  assert.equal(await kick.heldBack(), 0n);
  assert.equal(await bal(await kick.getAddress()), 0n);
  await reverts(kick, "resolveChallenge", [await addr(g)], "WrongChallengeState");
});

test("Kleros rules absent: the matcher is repaid and the guest forfeits", async () => {
  const { kick, gs } = await listed([8, 12], 2);
  const [g, m] = [gs[2], guests[152]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const c = await kick.challenges(await addr(g));
  await send(resolver.giveRuling(c.localDisputeID, 2));
  const em = await ethBal(m);
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await ethBal(m), em + FEE);
  await warp(DAY + 1);
  const [u0, a0] = [await bal(g), await bal(gs[0])];
  await send(kick.releasePayouts());
  assert.equal(await bal(g), u0); // nothing
  assert.equal(await bal(gs[0]), a0 + U(30)); // 60 over 2 attendees
});

test("Kleros refuses to arbitrate: both sides get half back, guest stays off the list", async () => {
  const { kick, gs } = await listed([12, 15], 2);
  const [g, m] = [gs[2], guests[153]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  await send(resolver.giveRuling((await kick.challenges(await addr(g))).localDisputeID, 0));
  const [eg, em] = [await ethBal(g), await ethBal(m)];
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await ethBal(g), eg + FEE / 2n);
  assert.equal(await ethBal(m), em + FEE / 2n);
  assert.equal(await kick.attended(await addr(g)), false);
});

test("the organiser can add a forgotten guest during the window; a waiting challenge is refunded", async () => {
  const { kick, gs } = await listed([15, 19], 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  const e0 = await ethBal(g);
  await reverts(kick.connect(g), "addAttendees", [[await addr(g)]], "NotOwner");
  await send(kick.addAttendees([await addr(g), await addr(gs[3])]));
  assert.equal(await ethBal(g), e0 + FEE);
  assert.equal(await kick.attendeeCount(), 4n);
  assert.equal(await kick.pendingChallenges(), 0n);
  await reverts(kick, "addAttendees", [[await addr(g)]], "DuplicateAttendee");
  await warp(DAY + 1);
  await reverts(kick, "addAttendees", [[await addr(guests[154])]], "TooLate");
  await send(kick.releasePayouts());
  assert.equal(await bal(await kick.getAddress()), 0n);
});

test("appeals: payouts wait through every appeal round and only the final ruling counts", async () => {
  const { kick, gs } = await listed([21, 25], 2);
  const [g, m] = [gs[2], guests[156]];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const c = await kick.challenges(await addr(g));
  const id = c.arbitratorDisputeID;
  const kit = new ethers.Contract(await arbitrator.kit(), load("MockDisputeKit").abi, prov);
  await warp(DAY + 1);

  // round 1: jurors say "did not attend"; the guest's side appeals (cost + 2x), the matcher's side defends (cost + 1x)
  await send(arbitrator.startAppealPeriod(id, 2, 3 * DAY, { gasLimit: 500000 }));
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled"); // a round-1 vote is not final
  const cost = await arbitrator.appealCost(id);
  await send(kit.connect(guests[157]).fundAppeal(id, 1, { value: cost, gasLimit: 500000 })); // crowdfunding: anyone can chip in
  await send(kit.connect(g).fundAppeal(id, 1, { value: 3n * cost, gasLimit: 500000 })); // the rest (any excess comes back)
  assert.equal(await kit.paidFees(id, 0, 1), 3n * cost);
  await send(kit.connect(m).fundAppeal(id, 2, { value: 2n * cost, gasLimit: 500000 }));
  assert.equal(await arbitrator.getNumberOfRounds(id), 2n); // both sides funded: a new, bigger jury
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled");

  // round 2: jurors say "attended"; nobody appeals; the ruling becomes final
  await send(arbitrator.startAppealPeriod(id, 1, 3 * DAY, { gasLimit: 500000 }));
  await warp(3 * DAY + 1);
  await reverts(kick, "resolveChallenge", [await addr(g)], "NotRuled");
  await send(arbitrator.passPeriod(id, { gasLimit: 500000 }));
  await send(arbitrator.executeRuling(id, { gasLimit: 500000 }));
  const e0 = await ethBal(g);
  await send(kick.connect(owner).resolveChallenge(await addr(g)));
  assert.equal(await ethBal(g), e0 + FEE); // the final winner gets what is left of both deposits
  assert.equal(await kick.attended(await addr(g)), true);
  const u0 = await bal(g);
  await send(kick.releasePayouts());
  assert.equal(await bal(g), u0 + U(20)); // 60 over 3 attendees
  assert.equal(await prov.getBalance(kick.target), 0n); // appeal money never passes through this contract
});

// an appealed case funded through the deposit contract: round 1 says absent, appealed, round 2 says attended
async function appealedThroughContract(slice, crowd, m, { newStyle = false } = {}) {
  const { kick, gs } = await listed(slice, 2);
  const g = gs[2];
  await send(kick.connect(g).challenge({ value: FEE }));
  await send(kick.connect(m).matchChallenge(await addr(g), { value: FEE }));
  const id = (await kick.challenges(await addr(g))).arbitratorDisputeID;
  const kit = new ethers.Contract(await arbitrator.kit(), load("MockDisputeKit").abi, owner);
  await send(kit.setNewStyle(newStyle, { gasLimit: 500000 }));
  await send(arbitrator.startAppealPeriod(id, 2, 3 * DAY, { gasLimit: 500000 }));
  return { kick, gs, g, id, kit };
}

test("appeals through the contract: status, crowdfunding, refunds of surplus, rewards shared by contribution", async () => {
  const [crowd, m] = [guests[158], guests[156]];
  const { kick, gs, g, id, kit } = await appealedThroughContract([25, 29], crowd, m);
  await reverts(kick, "appealStatus", [await addr(gs[3])], "NotAppealable");
  await reverts(kick, "fundAppeal", [await addr(gs[3]), 1, { value: 1n }], "NotAppealable");
  await reverts(kick, "fundAppeal", [await addr(g), 3, { value: 1n }], "BadSide");
  await reverts(kick, "claimAppealRewards", [await addr(g), await addr(g)], "WrongChallengeState");
  const cost = await arbitrator.appealCost(id);
  const st = await kick.appealStatus(await addr(g));
  assert.equal(st.round, 1n);
  assert.equal(st.ruling, 2n);
  assert.equal(st.costAttended, 3n * cost); // lost the vote: cost + 2x
  assert.equal(st.costAbsent, 2n * cost); // won the vote: cost + 1x
  assert.equal(st.loserEnd, st.start + (st.end - st.start) / 2n);

  const part = ethers.parseEther("0.05");
  await send(kick.connect(crowd).fundAppeal(await addr(g), 1, { value: part, gasLimit: 500000 }));
  const e0 = await ethBal(g);
  const r = await send(kick.connect(g).fundAppeal(await addr(g), 1, { value: 3n * cost, gasLimit: 500000 }));
  const rest = 3n * cost - part;
  assert.equal(await ethBal(g), e0 - rest - r.fee); // the surplus came back
  assert.equal(await kick.appealPaid(await addr(g), 0, 1), 3n * cost);
  assert.equal(await kick.appealContribution(await addr(g), 0, 1, await addr(crowd)), part);
  await send(kick.connect(m).fundAppeal(await addr(g), 2, { value: 2n * cost, gasLimit: 500000 }));
  assert.equal(await arbitrator.getNumberOfRounds(id), 2n); // both sides funded: round 2
  assert.equal(await prov.getBalance(kick.target), FEE); // only what is left of the challenge deposits
  assert.equal((await kick.appealStatus(await addr(g))).end, 0n); // round 2 is not in its appeal period yet

  // round 2: attended, final
  await send(arbitrator.startAppealPeriod(id, 1, DAY, { gasLimit: 500000 }));
  await warp(DAY + 1);
  await send(arbitrator.passPeriod(id, { gasLimit: 500000 }));
  await send(arbitrator.executeRuling(id, { gasLimit: 500000 }));
  await reverts(kick, "collectAppealFunds", [await addr(g)], "WrongChallengeState"); // settle first
  await send(kick.resolveChallenge(await addr(g)));
  // round-1 fee rewards: both sides' funding minus the appeal cost, all to the "attended" funders
  const rewards = 3n * cost + 2n * cost - cost;
  const expCrowd = (part * rewards) / (3n * cost), expG = (rest * rewards) / (3n * cost);
  assert.equal(await kick.appealRewardOf(await addr(g), await addr(crowd)), 0n); // not collected yet
  const to = await addr(guests[150]);
  const t0 = await prov.getBalance(to);
  await send(kick.connect(crowd).claimAppealRewards(await addr(g), to)); // collects from Kleros first
  assert.equal(await prov.getBalance(to), t0 + expCrowd);
  assert.equal(await kick.appealRewardOf(await addr(g), await addr(g)), expG);
  const e1 = await ethBal(g);
  const r2 = await send(kick.connect(g).claimAppealRewards(await addr(g), await addr(g)));
  assert.equal(await ethBal(g), e1 + expG - r2.fee);
  await reverts(kick.connect(g), "claimAppealRewards", [await addr(g), await addr(g)], "NothingToClaim");
  await reverts(kick.connect(m), "claimAppealRewards", [await addr(g), await addr(m)], "NothingToClaim"); // backed the losing side
  await reverts(kick, "collectAppealFunds", [await addr(g)], "NothingToClaim"); // only once
  assert.ok((await prov.getBalance(kick.target)) < 10n); // all paid out, rounding dust at most
  await send(kick.releasePayouts());
  assert.ok(await kick.attended(await addr(g)));
});

test("appeals through the contract: the losing side's deadline, a side never funded is refunded, newer Kleros kits", async () => {
  const [crowd, m] = [guests[157], guests[155]];
  const { kick, g, id, kit } = await appealedThroughContract([29, 33], crowd, m, { newStyle: true });
  const cost = await arbitrator.appealCost(id);
  // the guest's side raises only part of its appeal; nobody completes it
  await send(kick.connect(crowd).fundAppeal(await addr(g), 1, { value: cost, gasLimit: 500000 }));
  await warp(Math.floor(1.5 * DAY) + 10);
  await assert.rejects(kick.connect(crowd).fundAppeal.staticCall(await addr(g), 1, { value: cost }), /NotAppealPeriodForLoser/);
  await warp(2 * DAY);
  await send(arbitrator.passPeriod(id, { gasLimit: 500000 }));
  await send(arbitrator.executeRuling(id, { gasLimit: 500000 })); // round-1 vote stands: absent
  await send(kick.resolveChallenge(await addr(g)));
  assert.equal(await kick.attended(await addr(g)), false);
  const to = await addr(guests[154]);
  const t0 = await prov.getBalance(to);
  await send(kick.connect(crowd).claimAppealRewards(await addr(g), to)); // 3-argument withdrawal used
  assert.equal(await prov.getBalance(to), t0 + cost); // reimbursed in full
  await send(kit.setNewStyle(false, { gasLimit: 500000 }));
});

test("a lost case's set-aside share is split among the attendees; a challenge waiting for a match still holds the payout", async () => {
  const { kick, gs } = await listed([33, 37], 2); // 4 stakers x 15 = 60, 2 on the list
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
  await send(kick.releasePayouts()); // late is accepted unmatched; g's case is open: 60 / (3 + 1) = 15
  const mid = await Promise.all([gs[0], gs[1], late].map(bal));
  assert.deepEqual(mid.map((b, i) => b - before[i]), [U(15), U(15), U(15)]);
  assert.equal(await kick.payoutShare(), U(15));
  assert.equal(await kick.heldBack(), U(15));
  assert.equal(await kick.spare(), 0n); // the set-aside share cannot be swept or refunded
  await reverts(kick, "refund", [await addr(owner), 1n], "InsufficientBalance");
  await send(resolver.giveRuling((await kick.challenges(await addr(g))).localDisputeID, 2)); // jurors: absent
  await send(kick.resolveChallenge(await addr(g)));
  const end = await Promise.all([gs[0], gs[1], late].map(bal));
  assert.deepEqual(end.map((b, i) => b - mid[i]), [U(5), U(5), U(5)]);
  assert.equal(await bal(g), g0); // the challenger lost: nothing
  assert.equal(await bal(await kick.getAddress()), 0n);
  await reverts(kick.connect(late), "withdrawEth", [kick.target], "ZeroAddress"); // never to the contract itself
});

test("a wallet that refuses ETH can withdraw its challenge money later", async () => {
  const kick = await freshKick({ startIn: 1 });
  const refuser = await deploy("EthRefuser", owner);
  const gs = guests.slice(19, 21);
  await stake(kick, gs);
  // register the refusing contract as a staker (gs[0] pays its deposit)
  await send(usdc.connect(gs[0]).transfer(kick.target, U(15)));
  await send(kick.registerStakers([...(await Promise.all(gs.map(addr))), refuser.target]));
  await warp(2);
  await send(kick.postAttendance(await Promise.all(gs.map(addr)), (U(15) * 3n) / 2n));
  await send(refuser.challenge(kick.target, { value: FEE }));
  await warp(DAY + 1);
  await send(kick.releasePayouts()); // unmatched: accepted, but the refund bounces
  assert.equal(await kick.ethOwed(refuser.target), FEE);
  const to = await addr(guests[155]);
  const e0 = await prov.getBalance(to);
  await send(refuser.withdrawTo(kick.target, to));
  assert.equal(await prov.getBalance(to), e0 + FEE);
  assert.equal(await kick.ethOwed(refuser.target), 0n);
});
