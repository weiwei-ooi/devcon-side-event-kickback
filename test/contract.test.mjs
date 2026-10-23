// Contract-level tests (v2): curation refunds, guarded finalize, failed-transfer claims,
// emergency exit, two-step ownership and a 150-guest run. Local in-memory chain (ganache).
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

let server, prov, owner, guests, usdc;
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
  return deploy("GroundTruthKickback", owner, await usdc.getAddress(), U(15), "Ground Truth", await addr(owner), t + startIn, t + deadlineIn);
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
});
after(async () => server && (await server.close()));

test("constructor rejects a deadline before the event start", async () => {
  const t = await now();
  const { abi, bytecode } = load("GroundTruthKickback");
  const f = new ethers.ContractFactory(abi, bytecode, owner);
  // the settlement window after the event must be at least 7 days
  for (const [s, d] of [[t + 100, t + 100], [t + 100, t + 100 + 7 * 86400 - 1]]) {
    await assert.rejects(f.deploy(await usdc.getAddress(), U(15), "x", await addr(owner), s, d));
    owner.reset(); // the refused deploy used up a nonce locally; resync with the chain
  }
  const ok = await f.deploy(await usdc.getAddress(), U(15), "x", await addr(owner), t + 100, t + 100 + 7 * 86400);
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

test("finalize: not before the event, and only with the share the organiser confirmed", async () => {
  const kick = await freshKick({ startIn: 3600 });
  const gs = guests.slice(40, 44);
  await stake(kick, gs);
  await send(kick.registerStakers(await Promise.all(gs.map(addr))));
  const att = await Promise.all(gs.slice(0, 3).map(addr)); // 3 of 4 show up
  const share = (U(15) * 4n) / 3n;
  await reverts(kick, "finalize", [att, share], "TooEarly");
  await warp(3601);
  await reverts(kick, "finalize", [att, U(15)], "ShareMismatch");
  await reverts(kick, "finalize", [[], 0n], "NoAttendees");
  await reverts(kick, "finalize", [[att[0], att[0]], U(30)], "DuplicateAttendee");
  await reverts(kick, "finalize", [[await addr(guests[50])], U(60)], "NotAStaker");
  const b0 = await bal(att[0]);
  await send(kick.finalize(att, share));
  assert.equal(await bal(att[0]), b0 + share);
  assert.equal(await kick.phase(), 1n);
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
  await send(kick.finalize(await Promise.all(gs.map(addr)), U(15)));
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
  await reverts(kick, "finalize", [[await addr(gs[1])], U(45)], "TooLate");
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
    await send(kick.finalize(await Promise.all(gs.map(addr)), U(15)));
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

test("150 guests: register in batches, finalize with 120 attendees fits easily in a block", async () => {
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
  const r = await send(kick.finalize(att, share));
  console.log(`  gas: register 150 = ${regGas}, finalize 120 = ${r.gasUsed}`);
  assert.ok(r.gasUsed < 10_000_000n);
  assert.equal(await bal(await kick.getAddress()), 0n);
});
