// Contract tests on a local chain with Kleros stand-ins: the factory, ETH and token events, deposits until the event's
// end, curation, the attendance list, challenges (unmatched, ruled attended / absent / refused, before and after
// payout, in any order), pull and push payouts, cancellation, the missed-deadline exit, spare money, wallets that
// refuse payments, reentrancy and each case's own description (checked against the JS copy and its IPFS path).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { ethers } from "ethers";
import { startChain, deployAll, deploy, load, E, DAY, FEE, KGAS, POLICY, EXTRA, reverts, eventAbi } from "./helpers.mjs";
import { renderCase, ipfsPathOf, eventConfig } from "../scripts/protocol.mjs";

let chain, prov, owner, org, guests, P;
const D = E("0.01");
const send = async (p) => (await p).wait();
const addr = (s) => (typeof s === "string" ? s : s.target ?? s.address ?? s.signer?.address);
const A = (s) => s.signer?.address ?? s.address ?? s.target;
const bal = (a) => prov.getBalance(typeof a === "string" ? a : A(a));
const now = async () => (await prov.getBlock("latest")).timestamp;
const warp = async (s) => {
  await prov.send("evm_increaseTime", [s]);
  await prov.send("evm_mine", []);
};
const logsOf = (r, c, name) => r.logs.filter((l) => l.address.toLowerCase() === c.target.toLowerCase()).map((l) => c.interface.parseLog(l)).filter((x) => x?.name === name);

/** A new event created by `org`; starts in `startIn` s, lasts `hours`. */
async function newEvent({ startIn = 3600, hours = 4, token = ethers.ZeroAddress, deposit = D, capacity = 0, name = "Test Night", url = "https://luma.com/test", by = org } = {}) {
  const t = await now();
  const s = t + startIn;
  const e = s + hours * 3600;
  const cfg = [name, url, token, deposit, s, e, e + 14 * DAY, capacity];
  const r = await send(P.factory.connect(by).createEvent(cfg));
  const ev = logsOf(r, P.factory, "EventCreated")[0].args.eventContract;
  return new ethers.Contract(ev, eventAbi(), by);
}
const at = (ev, who) => ev.connect(who);
async function stake(ev, gs) {
  for (const g of gs) await send(g.sendTransaction({ to: ev.target, value: D }));
}
/** Skip to the event's end, post `list` and close it. */
async function postList(ev, list) {
  const end = Number(await ev.eventEnd());
  const t = await now();
  if (t < end) await warp(end - t + 1);
  return send(ev.postAttendance(list.map(A), true));
}
async function release(ev, expired = []) {
  await warp(DAY + 1);
  return send(at(ev, guests[30]).releasePayouts(expired.map(A)));
}
const cl = async (ev, g) => (await ev.claimable(A(g)))[0];

before(async () => {
  chain = await startChain({ port: 18561, accounts: 40 });
  prov = chain.prov;
  [owner, org, ...guests] = chain.wallets;
  P = await deployAll(owner);
});
after(async () => chain?.server && (await chain.server.close()));

test("protocol: implementation is locked, factory only takes an implementation, settings are readable", async () => {
  const impl = new ethers.Contract(P.implementation, eventAbi(), owner);
  assert.equal(await impl.factory(), "0x0000000000000000000000000000000000000001");
  const cfg = ["x", "", ethers.ZeroAddress, D, (await now()) + 10, (await now()) + 20, (await now()) + 20 + 8 * DAY, 0];
  await reverts(impl, "initialize", [A(owner), cfg], "AlreadyInitialized");
  await assert.rejects(deploy("PresenceFactory", owner, A(owner)));
  owner.reset();
  await assert.rejects(deploy("PresenceFactory", owner, P.proxy.target));
  owner.reset();
  assert.equal(await impl.disputeResolver(), P.proxy.target);
  assert.equal(await impl.arbitrator(), P.liquid.target);
  const [extra, policy] = await impl.arbitrationSettings();
  assert.deepEqual([extra, policy], [EXTRA, POLICY]);
  assert.equal(await impl.challengeDeposit(), FEE);
  assert.equal(await impl.challengePeriod(), BigInt(DAY));
  const writer = new ethers.Contract(P.caseWriter, load("PresenceCaseWriter").abi, owner);
  const [pieces, slots] = await writer.template();
  assert.deepEqual([[...pieces], slots], [P.template.pieces, P.template.slots]);
});

test("factory: anyone creates events; bad settings are refused; events are listed", async () => {
  const before = await P.factory.eventCount();
  const ev = await newEvent({ by: guests[0] });
  assert.equal(await ev.owner(), A(guests[0]));
  assert.equal(await P.factory.isEvent(ev.target), true);
  assert.equal(await P.factory.eventCount(), before + 1n);
  assert.deepEqual([...(await P.factory.eventsOf(A(guests[0])))], [ev.target]);
  const page = await P.factory.events(before, 10);
  assert.deepEqual([...page], [ev.target]);
  assert.equal(await ev.tokenSymbol(), "ETH");
  // the clone cannot be initialised again
  const cfg = ["x", "", ethers.ZeroAddress, D, (await now()) + 10, (await now()) + 20, (await now()) + 20 + 8 * DAY, 0];
  await reverts(ev, "initialize", [A(owner), cfg], "AlreadyInitialized");
  const t = await now();
  const ok = ["Name", "https://x.org", ethers.ZeroAddress, D, t + 100, t + 200, t + 200 + 7 * DAY, 0];
  const bad = [
    [{ 3: 0n }, "BadConfig"],
    [{ 5: t + 50 }, "BadConfig"], // ends before it starts
    [{ 4: t - 500, 5: t - 100, 6: t + 8 * DAY }, "BadConfig"], // already over
    [{ 6: t + 200 + 7 * DAY - 1 }, "BadConfig"], // deadline too soon after the end
    [{ 6: t + 200 + 90 * DAY + 1 }, "BadConfig"], // deadline too long after the end
    [{ 4: t + 100, 5: t + 3 * 365 * DAY, 6: t + 3 * 365 * DAY + 8 * DAY }, "BadConfig"], // ends too far ahead
    [{ 0: "" }, "BadConfig"],
    [{ 0: 'Say "hi"' }, "BadConfig"],
    [{ 0: "a\\b" }, "BadConfig"],
    [{ 0: "line\nbreak" }, "BadConfig"],
    [{ 0: "x".repeat(201) }, "BadConfig"],
    [{ 1: "https://x.org/" + "a".repeat(300) }, "BadConfig"],
    [{ 2: A(guests[1]) }, "BadConfig"], // a token address without code
  ];
  for (const [patch, err] of bad) {
    const c = ok.map((v, i) => (i in patch ? patch[i] : v));
    await reverts(P.factory, "createEvent", [c], err);
  }
  await P.factory.createEvent.staticCall(ok);
  // the JS check agrees with the common mistakes
  assert.throws(() => eventConfig({ name: 'a"b', depositAmount: 1n, eventStart: t + 1, eventEnd: t + 2, claimDeadline: t + 2 + 7 * DAY }, t));
  assert.throws(() => eventConfig({ name: "a", depositAmount: 1n, eventStart: t + 1, eventEnd: t + 2, claimDeadline: t + 3 }, t));
  assert.equal(eventConfig({ name: " a ", depositAmount: 1n, eventStart: t + 1, eventEnd: t + 2, claimDeadline: t + 2 + 7 * DAY }, t).name, "a");
});

test("deposits: exact amount registers the staker at once; open while the event runs, closed at its end", async () => {
  const ev = await newEvent({ startIn: 600, hours: 3, capacity: 3 });
  const [a, b, c, d, x] = guests;
  const r = await send(a.sendTransaction({ to: ev.target, value: D }));
  assert.equal(logsOf(r, ev, "Deposited")[0].args.staker, A(a));
  assert.equal(await ev.status(A(a)), 1n);
  await reverts(at(ev, a), "deposit", [{ value: D }], "AlreadyStaker");
  await reverts(at(ev, b), "deposit", [{ value: D + 1n }], "WrongAmount");
  await reverts(at(ev, b), "deposit", [{ value: D - 1n }], "WrongAmount");
  await assert.rejects(prov.call({ from: A(b), to: ev.target, value: D * 2n })); // plain transfer, wrong amount
  await assert.rejects(prov.call({ from: A(b), to: ev.target, value: D, data: "0x12345678" })); // no fallback
  await send(c.sendTransaction({ to: ev.target, value: D }));
  await send(ev.reject([A(c)])); // before the start: a spot frees up
  await reverts(at(ev, c), "deposit", [{ value: D }], "WasRejected");
  // during the event (walk-ins)
  await warp(600 + 3600);
  await send(at(ev, b).deposit({ value: D }));
  await reverts(ev, "reject", [[A(b)]], "TooLate"); // once it has started, nobody can be turned away
  await warp(2 * 3600 - 120);
  await send(at(ev, d).deposit({ value: D })); // two minutes before the end
  assert.equal(await ev.stakerCount(), 3n);
  await reverts(at(ev, x), "deposit", [{ value: D }], "EventFull");
  await warp(200);
  await reverts(ev, "reject", [[A(d)]], "TooLate"); // nor after it
  assert.equal(await bal(ev), 3n * D);
  assert.deepEqual([...(await ev.stakers())], [A(a), A(c), A(b), A(d)]);
});

test("reject: refunds exactly the deposit; a wallet that refuses ETH can withdraw it to another address", async () => {
  const ev = await newEvent();
  const w = await deploy("TestWallet", owner);
  await send(w.exec(ev.target, ev.interface.encodeFunctionData("deposit"), { value: D }));
  await send(w.setMode(1)); // refuses ETH
  const [a] = guests;
  await stake(ev, [a]);
  const b0 = await bal(a);
  await reverts(at(ev, a), "reject", [[A(a)]], "NotOwner");
  const r = await send(ev.reject([A(a), w.target]));
  assert.equal(await bal(a), b0 + D);
  assert.equal(logsOf(r, ev, "PaymentFailed").length, 1);
  assert.equal(await ev.owed(w.target), D);
  assert.equal(await ev.stakerCount(), 0n);
  assert.equal(await ev.reservedPool(), D);
  await reverts(ev, "reject", [[A(a)]], "NotAStaker");
  const dest = ethers.Wallet.createRandom().address;
  await send(w.exec(ev.target, ev.interface.encodeFunctionData("withdraw", [dest])));
  assert.equal(await bal(dest), D);
  assert.equal(await bal(ev), 0n);
});

test("attendance: only after the end, in batches; then payouts split the whole pool among attendees", async () => {
  const ev = await newEvent();
  const g = guests.slice(0, 5);
  await stake(ev, g);
  await reverts(ev, "postAttendance", [[A(g[0])], false], "TooEarly");
  await warp(3600 + 4 * 3600 + 1);
  await send(ev.postAttendance([A(g[0]), A(g[1])], false));
  await reverts(ev, "postAttendance", [[A(g[1])], false], "DuplicateAttendee");
  await reverts(ev, "postAttendance", [[A(guests[9])], false], "NotAStaker");
  await reverts(ev, "reject", [[A(g[0])]], "TooLate"); // after the start nobody can be turned away
  await send(ev.postAttendance([A(g[2])], true));
  assert.equal(await ev.phase(), 1n);
  await reverts(at(ev, guests[9]), "deposit", [{ value: D }], "NotOpen");
  await reverts(ev, "cancel", [], "NotOpen");
  await reverts(at(ev, guests[9]), "releasePayouts", [[]], "TooEarly");
  const r = await release(ev);
  const share = (5n * D) / 3n;
  assert.equal(logsOf(r, ev, "PayoutsReleased")[0].args.share, share);
  assert.equal(await cl(ev, g[0]), share);
  assert.equal(await cl(ev, g[3]), 0n); // no-show
  // pull: one withdraws to another address; push: anyone distributes the rest
  const dest = ethers.Wallet.createRandom().address;
  await send(at(ev, g[0]).withdraw(dest));
  assert.equal(await bal(dest), share);
  await reverts(at(ev, g[0]), "withdraw", [dest], "NothingToWithdraw");
  const b1 = await bal(g[1]);
  await send(at(ev, guests[20]).distribute([A(g[1]), A(g[2]), A(g[3])]));
  assert.equal(await bal(g[1]), b1 + share);
  assert.equal(await ev.reservedPool(), 0n);
  const dust = 5n * D - 3n * share;
  assert.equal(await ev.spare(ethers.ZeroAddress), dust);
  await reverts(ev, "recoverSpare", [ethers.ZeroAddress, A(org), dust + 1n], "SpareTooLow");
  await send(ev.recoverSpare(ethers.ZeroAddress, A(org), dust));
  assert.equal(await bal(ev), 0n);
});

test("challenge: unmatched counts as attended; a waiting one blocks payout until it expires; organiser can add a staker back", async () => {
  const ev = await newEvent();
  const [a, b, c, d] = guests;
  await stake(ev, [a, b, c, d]);
  await postList(ev, [a]);
  await reverts(at(ev, a), "challenge", [{ value: FEE }], "AlreadyAttending");
  await reverts(at(ev, guests[9]), "challenge", [{ value: FEE }], "NotAStaker");
  await reverts(at(ev, b), "challenge", [{ value: FEE - 1n }], "WrongAmount");
  const b0 = await bal(b);
  const r = await send(at(ev, b).challenge({ value: FEE + 7n })); // extra comes back
  assert.equal(await bal(b), b0 - FEE - r.fee);
  await reverts(at(ev, b), "challenge", [{ value: FEE }], "AlreadyChallenged");
  await send(at(ev, c).challenge({ value: FEE }));
  // the organiser adds c back: c's challenge deposit is returned
  const c0 = await bal(c);
  await send(ev.addAttendees([A(c)]));
  assert.equal(await bal(c), c0 + FEE);
  // b's match window is still open when the challenge window ends
  await warp(DAY - 600);
  await send(at(ev, d).challenge({ value: FEE }));
  await warp(601);
  await reverts(at(ev, d), "challenge", [{ value: FEE }], "TooLate"); // the challenge window is over
  await reverts(at(ev, guests[30]), "releasePayouts", [[A(b), A(d)]], "ChallengesPending");
  await warp(DAY);
  await reverts(at(ev, guests[30]), "matchChallenge", [A(d), { value: FEE }], "TooLate");
  await send(at(ev, guests[30]).releasePayouts([A(b), A(d)]));
  assert.equal(await ev.attendeeCount(), 4n);
  assert.equal(await cl(ev, b), D);
  assert.equal((await ev.claimable(A(b)))[1], 0n); // challenge deposit already pushed back
  assert.equal(await ev.challengeEscrow(), 0n);
});

test("case description: written by the contract, identical to the JS copy, IPFS path computed on-chain; organiser snapshot", async () => {
  const ev = await newEvent({ name: "Truth & Justice: Night 1", url: "https://luma.com/abc" });
  const [a, b] = guests;
  await stake(ev, [a, b]);
  await postList(ev, [a]);
  await send(at(ev, b).challenge({ value: FEE }));
  // ownership moves after the challenge: the case keeps naming the organiser at challenge time
  await send(ev.transferOwnership(A(guests[10])));
  await send(at(ev, guests[10]).acceptOwnership());
  const [text, uri] = await ev.caseMetaEvidence(A(b));
  const facts = {
    staker: A(b),
    eventContract: ev.target,
    organiser: A(org),
    name: await ev.eventName(),
    url: await ev.eventURL(),
    start: await ev.eventStart(),
    end: await ev.eventEnd(),
    depositAmount: D,
    decimals: 18,
    symbol: "ETH",
    token: ethers.ZeroAddress,
    chainId: 1337,
  };
  assert.equal(text, renderCase(P.template, facts));
  assert.equal(uri, ipfsPathOf(text));
  const meta = JSON.parse(text);
  assert.match(meta.title, new RegExp(A(b)));
  assert.match(meta.description, /0\.01 ETH/);
  assert.match(meta.description, /Truth & Justice: Night 1/);
  assert.match(meta.description, /\d{4}-\d\d-\d\d \d\d:\d\d UTC/);
  assert.equal(meta.fileURI, POLICY);
  assert.ok(meta.aliases[A(b).toLowerCase()] && meta.aliases[A(org).toLowerCase()]);
  const r = await send(at(ev, guests[10]).matchChallenge(A(b), { value: FEE }));
  const m = logsOf(r, ev, "ChallengeMatched")[0].args;
  assert.equal((await ev.challenges(A(b))).localDisputeID, m.localDisputeID);
  const logs = await prov.getLogs({ address: P.proxy.target, fromBlock: r.blockNumber, toBlock: r.blockNumber });
  const meLog = logs.map((l) => { try { return P.proxy.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "MetaEvidence");
  assert.equal(meLog.args._evidence ?? meLog.args[1], uri);
});

/** Event with 6 stakers: g0, g1 on the list; g2, g3 challenge and get matched (Kleros cases); g4, g5 no-shows. */
async function twoCases() {
  const ev = await newEvent();
  const g = guests.slice(0, 6);
  await stake(ev, g);
  await postList(ev, [g[0], g[1]]);
  const ids = {};
  for (const s of [g[2], g[3]]) {
    await send(at(ev, s).challenge({ value: FEE }));
    const r = await send(ev.matchChallenge(A(s), { value: FEE }));
    ids[A(s)] = logsOf(r, ev, "ChallengeMatched")[0].args.arbitratorDisputeID;
  }
  return { ev, g, ids };
}
const rule = (id, ruling) => send(P.liquid.giveFinalRuling(id, ruling, KGAS));

test("Kleros cases: payout goes ahead with one share set aside per open case; any settlement order pays everyone the same", async () => {
  for (const order of [
    [[2, 1], [3, 2]], // g2 attended first, then g3 did not
    [[3, 2], [2, 1]], // g3 did not first, then g2 attended
    [[2, 2], [3, 0]], // neither: one absent, one refused
  ]) {
    const { ev, g, ids } = await twoCases();
    await reverts(at(ev, g[5]), "resolveChallenge", [A(g[2])], "NotRuled");
    await release(ev);
    const pool = 6n * D;
    const share = pool / 4n;
    assert.equal(await ev.payoutShare(), share);
    assert.equal(await cl(ev, g[0]), share);
    assert.equal(await ev.reservedPool(), share * 4n);
    await send(at(ev, g[0]).withdraw(A(g[0]))); // g0 takes the first share now
    for (const [i, ruling] of order) {
      await rule(ids[A(g[i])], ruling);
      const matcher0 = await bal(org);
      const s0 = await bal(g[i]);
      const r = await send(at(ev, g[5]).resolveChallenge(A(g[i])));
      const remaining = 2n * FEE - FEE; // the mock fee equals one deposit
      if (ruling === 1) assert.equal(await bal(g[i]), s0 + remaining);
      if (ruling === 2) assert.equal(await bal(org), matcher0 + remaining);
      if (ruling === 0) assert.equal(await bal(g[i]), s0 + remaining / 2n);
      assert.equal(logsOf(r, ev, "ChallengeResolved")[0].args.ruling, BigInt(ruling));
    }
    const winners = order.filter(([, r]) => r === 1).map(([i]) => g[i]);
    const finalList = [g[0], g[1], ...winners];
    const totals = await Promise.all(finalList.map(async (x) => (await ev.sharePaid(A(x))) + (await cl(ev, x))));
    const max = totals.reduce((m, v) => (v > m ? v : m));
    for (const t of totals) assert.ok(max - t <= 2n, `unequal totals ${totals}`);
    assert.ok(pool - totals.reduce((s, v) => s + v, 0n) <= 4n); // only rounding dust left
    for (const x of [g[2], g[3], g[4], g[5]]) if (!winners.includes(x)) assert.equal(await cl(ev, x), 0n);
    await send(at(ev, g[5]).distribute(finalList.map(A)));
    assert.equal(await ev.reservedPool(), 0n);
    assert.ok((await bal(ev)) <= 4n);
    assert.equal(await ev.openCases(), 0n);
  }
});

test("Kleros case settled before payout: attended joins the list, absent stays off", async () => {
  const { ev, g, ids } = await twoCases();
  await rule(ids[A(g[2])], 1);
  await rule(ids[A(g[3])], 2);
  await send(ev.resolveChallenge(A(g[2])));
  await send(ev.resolveChallenge(A(g[3])));
  await reverts(ev, "resolveChallenge", [A(g[3])], "WrongChallengeState");
  await release(ev);
  assert.equal(await ev.payoutShare(), (6n * D) / 3n);
  assert.equal(await ev.attended(A(g[2])), true);
  assert.equal(await cl(ev, g[3]), 0n);
});

test("appeals: appealStatus reads the appeal window and costs from Kleros; refused to appeal after ruling", async () => {
  const { ev, g, ids } = await twoCases();
  await send(P.liquid.startAppealPeriod(ids[A(g[2])], 2, 3 * DAY, KGAS));
  const s = await ev.appealStatus(A(g[2]));
  assert.equal(s.ruling, 2n);
  assert.ok(s.end > s.start && s.loserEnd <= s.end);
  assert.ok(s.costAttended > s.costAbsent); // the losing side pays the bigger stake
  await reverts(ev, "appealStatus", [A(g[4])], "NotAppealable");
});

test("cancel: every staker takes their deposit back (pull or push); nothing else can be taken", async () => {
  const ev = await newEvent();
  const [a, b, c] = guests;
  await stake(ev, [a, b, c]);
  await reverts(at(ev, a), "cancel", [], "NotOwner");
  await send(ev.cancel());
  await reverts(at(ev, guests[9]), "deposit", [{ value: D }], "NotOpen");
  assert.equal(await cl(ev, a), D);
  await send(at(ev, a).withdraw(A(a)));
  await send(at(ev, guests[9]).distribute([A(b), A(c), A(guests[9])]));
  assert.equal(await bal(ev), 0n);
  assert.equal(await ev.stakerCount(), 0n);
});

test("missed deadline: if the list is never closed, each staker takes their own deposit back", async () => {
  const ev = await newEvent();
  const [a, b] = guests;
  await stake(ev, [a, b]);
  await warp(3600 + 4 * 3600 + 14 * DAY - 60);
  assert.equal(await cl(ev, a), 0n);
  await warp(120);
  await reverts(ev, "postAttendance", [[A(a)], true], "TooLate");
  await reverts(ev, "cancel", [], "TooLate");
  assert.equal(await cl(ev, a), D);
  await send(at(ev, a).withdraw(A(a)));
  await send(at(ev, b).withdraw(A(b)));
  assert.equal(await bal(ev), 0n);
});

test("token events: approve + deposit, payouts in the token, challenge money in ETH; odd tokens handled", async () => {
  const usdc = await deploy("TestToken", owner, "USDC", 6);
  const U = 25_000_000n; // 25 USDC
  const ev = await newEvent({ token: usdc.target, deposit: U });
  assert.deepEqual([await ev.tokenSymbol(), await ev.tokenDecimals()], ["USDC", 6n]);
  const g = guests.slice(0, 4);
  for (const x of g) {
    await send(usdc.mint(A(x), U * 2n));
    await send(usdc.connect(x).approve(ev.target, U));
  }
  await reverts(at(ev, g[0]), "deposit", [{ value: 1n }], "TokenEvent");
  await assert.rejects(prov.call({ from: A(g[0]), to: ev.target, value: D })); // plain ETH refused
  for (const x of g.slice(0, 3)) await send(at(ev, x).deposit());
  // a transfer sent directly (not through deposit) is spare and can be returned
  await send(usdc.connect(g[3]).transfer(ev.target, U));
  assert.equal(await ev.spare(usdc.target), U);
  await send(ev.recoverSpare(usdc.target, A(g[3]), U));
  const [text] = await ev.caseMetaEvidence(A(g[2]));
  assert.match(text, new RegExp(`25 USDC \\(token ${usdc.target}\\)`));
  await postList(ev, [g[0], g[1]]);
  await send(at(ev, g[2]).challenge({ value: FEE }));
  await warp(DAY + 1);
  await reverts(at(ev, guests[30]), "releasePayouts", [[]], "ChallengesPending");
  await send(at(ev, guests[30]).releasePayouts([A(g[2])]));
  assert.equal(await cl(ev, g[0]), U);
  assert.equal((await ev.claimable(A(g[2])))[1], 0n); // ETH deposit pushed back
  // g1's wallet is blocked by the token: the push fails, it stays claimable, others are paid
  await send(usdc.setStyle(4));
  await send(usdc.setBlocked(A(g[1])));
  await send(at(ev, guests[30]).distribute([A(g[0]), A(g[1]), A(g[2])]));
  assert.equal(await usdc.balanceOf(A(g[0])), U * 2n);
  assert.equal(await ev.owed(A(g[1])), U);
  const dest = ethers.Wallet.createRandom().address;
  await send(at(ev, g[1]).withdraw(dest));
  assert.equal(await usdc.balanceOf(dest), U);
  assert.equal(await usdc.balanceOf(ev.target), 0n);
  // ETH sent by mistake (forced) is spare; the pool asset reserve is the token's
  assert.equal(await ev.spare(ethers.ZeroAddress), 0n);
});

test("token events: fee-on-transfer tokens are refused; USDT-style tokens (no return value) work", async () => {
  const fee = await deploy("TestToken", owner, "FEE", 18);
  await send(fee.setStyle(3));
  const ev = await newEvent({ token: fee.target, deposit: E(1) });
  await send(fee.mint(A(guests[0]), E(1)));
  await send(fee.connect(guests[0]).approve(ev.target, E(1)));
  await reverts(at(ev, guests[0]), "deposit", [], "WrongAmount");
  const usdt = await deploy("TestToken", owner, "USDT", 6);
  await send(usdt.setStyle(1));
  const ev2 = await newEvent({ token: usdt.target, deposit: 10n ** 6n });
  await send(usdt.mint(A(guests[0]), 10n ** 6n));
  await send(usdt.connect(guests[0]).approve(ev2.target, 10n ** 6n));
  await send(at(ev2, guests[0]).deposit());
  await send(ev2.reject([A(guests[0])]));
  assert.equal(await usdt.balanceOf(A(guests[0])), 10n ** 6n);
  const bad = await deploy("TestToken", owner, "BAD", 18);
  await send(bad.setStyle(2)); // answers false
  const ev3 = await newEvent({ token: bad.target, deposit: 1n });
  await send(bad.mint(A(guests[0]), 1n));
  await send(bad.connect(guests[0]).approve(ev3.target, 1n));
  await reverts(at(ev3, guests[0]), "deposit", [], "TransferFailed");
  // a token whose symbol is odd shows as "tokens"
  const odd = await deploy("TestToken", owner, 'X"Y', 18);
  const ev4 = await newEvent({ token: odd.target, deposit: 1n });
  assert.equal(await ev4.tokenSymbol(), "tokens");
});

test("wallets: a gas-burning or reentering wallet cannot block or drain a batch; too little gas reverts", async () => {
  const ev = await newEvent();
  const burner = await deploy("TestWallet", owner);
  await send(burner.exec(ev.target, ev.interface.encodeFunctionData("deposit"), { value: D }));
  const re = await deploy("TestWallet", owner);
  await send(re.exec(ev.target, ev.interface.encodeFunctionData("deposit"), { value: D }));
  const [a] = guests;
  await stake(ev, [a]);
  await postList(ev, [burner, re, a]);
  await release(ev);
  await send(burner.setMode(2));
  await send(re.setReentry(ev.target, ev.interface.encodeFunctionData("withdraw", [A(a)]), 0n));
  const share = D;
  const r = await send(at(ev, guests[30]).distribute([burner.target, re.target, A(a)], { gasLimit: 1_000_000 }));
  assert.equal(logsOf(r, ev, "PaymentFailed").length, 1); // only the burner
  assert.equal(await re.reentryOk(), false); // reentry refused, payment still delivered
  assert.equal(await ev.owed(burner.target), share);
  assert.equal(await cl(ev, a), 0n);
  // a caller who sends too little gas cannot push a payment into `owed` on purpose
  const ev2 = await newEvent();
  const b2 = await deploy("TestWallet", owner);
  await send(b2.exec(ev2.target, ev2.interface.encodeFunctionData("deposit"), { value: D }));
  await send(b2.setMode(2));
  await postList(ev2, [b2]);
  await release(ev2);
  const tx = await at(ev2, guests[30]).distribute([b2.target], { gasLimit: 60_000 });
  await assert.rejects(tx.wait());
  guests[30].reset?.();
});

test("ownership: two steps; the new owner runs the event", async () => {
  const ev = await newEvent();
  await reverts(at(ev, guests[1]), "transferOwnership", [A(guests[1])], "NotOwner");
  await send(ev.transferOwnership(A(guests[1])));
  await reverts(at(ev, guests[2]), "acceptOwnership", [], "NotPendingOwner");
  await send(at(ev, guests[1]).acceptOwnership());
  assert.equal(await ev.owner(), A(guests[1]));
  await reverts(ev, "cancel", [], "NotOwner");
  await send(at(ev, guests[1]).cancel());
});

test("case description dates: the contract's UTC text matches JS across leap days and month ends (events end within 2 years)", async () => {
  for (const iso of ["2028-02-29T23:59:00Z", "2027-12-31T00:00:00Z", "2028-03-01T12:34:00Z", "2027-06-30T05:07:00Z"]) {
    const s = Date.parse(iso) / 1000;
    const r = await send(P.factory.connect(org).createEvent(["Dates", "", ethers.ZeroAddress, 1n, s, s + 61, s + 61 + 7 * DAY, 0]));
    const ev = new ethers.Contract(logsOf(r, P.factory, "EventCreated")[0].args.eventContract, eventAbi(), org);
    const [text] = await ev.caseMetaEvidence(A(guests[0]));
    const want = iso.slice(0, 10) + " " + iso.slice(11, 16) + " UTC";
    assert.ok(text.includes(want), `${want} missing`);
    assert.match(text, /0\.000000000000000001 ETH/);
  }
});
