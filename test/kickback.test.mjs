// End-to-end test on a local in-memory chain (ganache): contract + the CLI scripts, including
// curation (approved → register, declined → refund), the attendance list, a Kleros challenge
// (unmatched, so it counts as attended) and the payout.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import ganache from "ganache";
import { ethers } from "ethers";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"));
const U = (x) => ethers.parseUnits(String(x), 6);
const PORT = 18545;

let server, prov, owner, guests, usdc, kick, resolver, tmp;
const ownerKey = "0x" + "11".repeat(32);
const guestKeys = Array.from({ length: 9 }, (_, i) => "0x" + (i + 2).toString(16).padStart(2, "0").repeat(32));

async function deploy(name, signer, ...params) {
  const { abi, bytecode } = load(name);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...params);
  await c.waitForDeployment();
  return c;
}

before(async () => {
  execFileSync("node", [path.join(root, "scripts/compile.mjs")], { stdio: "ignore" });
  server = ganache.server({
    logging: { quiet: true },
    chain: { chainId: 1337 },
    wallet: { accounts: [ownerKey, ...guestKeys].map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) },
  });
  await server.listen(PORT);
  prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 1337, { staticNetwork: true });
  owner = new ethers.NonceManager(new ethers.Wallet(ownerKey, prov));
  guests = guestKeys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
  usdc = await deploy("MockUSDC", owner);
  const t = (await prov.getBlock("latest")).timestamp;
  const arbitrator = await deploy("MockArbitrator", owner);
  resolver = await deploy("MockDisputeResolver", owner, await arbitrator.getAddress());
  const extra = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [1, 3, 1]);
  kick = await deploy("GroundTruthKickback", owner, await usdc.getAddress(), U(15), "Ground Truth", await owner.getAddress(), t + 3600, t + 3600 + 14 * 86400,
    [await resolver.getAddress(), extra, "/ipfs/QmTest/attendance-policy.md"]);
  for (const g of guests) await (await usdc.mint(await g.getAddress(), U(100))).wait();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "gt-"));
});

after(async () => server && (await server.close()));


// Ganache drops custom-error data on estimateGas, so assert reverts via eth_call (staticCall).
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
const pay = async (g, amount, to) => (await (await usdc.connect(g).transfer(to ?? (await kick.getAddress()), U(amount))).wait()).hash;

test("full flow: verify → curate on Luma → register / refund declined → check-ins → post list → challenge → release", async () => {
  const kAddr = await kick.getAddress();
  const [g0, g1, g2, g3, g4, g5, g6, g7, g8] = guests;

  // Deposits
  const tx0 = await pay(g0, 15);
  const tx1 = await pay(g1, 15);
  const tx2 = await pay(g2, 20); // overpaid
  const tx3 = await pay(g3, 15);
  const tx4 = await pay(g4, 10); // too low
  const tx5 = await pay(g5, 15, await addr(g6)); // sent to the wrong address
  const tx6 = await pay(g6, 15); // will claim someone else's tx too
  const tx7 = await pay(g7, 15); // a bot: paid, then declined
  const tx8 = await pay(g8, 15); // still waiting for a decision

  const H = "name,email,ticket_name,approval_status,checked_in_at,eth_address,Deposit tx link (Arbiscan)";
  const T = "Committed Spot ($15 refundable deposit)";
  const rowsFor = async (st) => [
    `Ana,ana@x.io,${T},${st.ana},,${await addr(g0)},https://arbiscan.io/tx/${tx0}`,
    `Ben,ben@x.io,${T},${st.ben},,${await addr(g1)},${tx1}`,
    `Cai,cai@x.io,${T},approved,,${await addr(g2)},see ${tx2} thanks`,
    `Dev,dev@x.io,${T},approved,,,${tx3}`, // wallet inferred
    `Eve,eve@x.io,${T},approved,,${await addr(g4)},${tx4}`,
    `Fay,fay@x.io,${T},approved,,${await addr(g5)},${tx5}`,
    `Gus,gus@x.io,${T},approved,,${await addr(g6)},${tx0}`, // reuses Ana's tx
    `Hal,hal@x.io,Request to Join (Free),approved,,,`,
    `Ivy,ivy@x.io,${T},approved,,${await addr(g6)},not sure`,
    `Bot,bot@x.io,${T},declined,,${await addr(g7)},${tx7}`,
    `Pat,pat@x.io,${T},pending_approval,,${await addr(g8)},${tx8}`,
  ];
  const writeGuests = async (file, st) => fs.writeFileSync(path.join(tmp, file), [H, ...(await rowsFor(st))].join("\n"));
  await writeGuests("guests.csv", { ana: "approved", ben: "approved" });
  fs.writeFileSync(path.join(tmp, "config.json"), JSON.stringify({
    chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${PORT}`, token: await usdc.getAddress(),
    tokenDecimals: 6, deposit: "15", receiver: kAddr, contract: kAddr, explorer: "https://example.org",
    depositOpensAt: "2020-01-01T00:00:00Z", depositDeadline: "2099-01-01T00:00:00Z",
    kleros: { disputeResolver: await resolver.getAddress() },
  }));

  // async exec: ganache runs in this process, so a sync child call would deadlock
  const run = async (script, ...extra) =>
    (await execFileP("node", [path.join(root, "scripts", script), "--config", "config.json", "--out", "out", ...extra], { cwd: tmp, encoding: "utf8" })).stdout;
  const readOut = (f) => fs.readFileSync(path.join(tmp, "out", f), "utf8");
  const jsonOut = (f) => JSON.parse(readOut(f));
  const wallets = (f) => jsonOut(f).items.map((i) => i.wallet);

  const log = await run("verify-deposits.mjs", "--guests", "guests.csv", "--scan-from-block", "0");
  assert.match(log, /Verified deposits:\s+6/);

  const verified = readOut("verified.csv");
  for (const n of ["Ana", "Ben", "Cai", "Dev", "Bot", "Pat"]) assert.ok(verified.includes(n), `${n} verified`);
  assert.match(verified, /overpaid by 5/);
  assert.match(verified, /wallet taken from tx sender/);

  const issues = readOut("issues.csv");
  assert.match(issues, /AMOUNT_TOO_LOW.*Eve|Eve.*AMOUNT_TOO_LOW/s);
  assert.match(issues, /NO_DEPOSIT_TRANSFER/); // Fay
  assert.match(issues, /DUPLICATE_TX/); // Gus
  assert.match(issues, /BAD_TX_HASH/); // Ivy
  assert.ok(!issues.includes("Hal"), "free tickets are ignored");
  assert.ok(readOut("unmatched.csv").includes(tx6.toLowerCase()), "Gus' own deposit is unclaimed");

  // Curation: only approved + verified are registered; declined payers are refunded; pending waits
  const newStakers = wallets("new-stakers.json");
  assert.equal(jsonOut("new-stakers.json").contract, kAddr);
  assert.equal(newStakers.length, 4);
  assert.ok(!newStakers.includes(await addr(g7)) && !newStakers.includes(await addr(g8)));
  assert.deepEqual(wallets("refunds.json"), [await addr(g7)]);
  assert.ok(readOut("to-review.csv").includes("Pat"));
  await (await kick.registerStakers(newStakers)).wait();
  assert.equal(await kick.stakerCount(), 4n);
  assert.ok(fs.existsSync(path.join(tmp, "out/safe-register.json")));

  const botBefore = await usdc.balanceOf(await addr(g7));
  await (await kick.rejectAndRefund(wallets("refunds.json"))).wait();
  assert.equal(await usdc.balanceOf(await addr(g7)), botBefore + U(15));

  // Later: Ben is declined after being registered; Pat is approved. Re-run is idempotent otherwise.
  await writeGuests("guests2.csv", { ana: "approved", ben: "declined" });
  fs.writeFileSync(path.join(tmp, "guests2.csv"), fs.readFileSync(path.join(tmp, "guests2.csv"), "utf8").replace("pending_approval", "approved"));
  await run("verify-deposits.mjs", "--guests", "guests2.csv");
  assert.deepEqual(wallets("new-stakers.json"), [await addr(g8)]);
  assert.deepEqual(wallets("refunds.json"), [await addr(g1)]); // Bot already refunded: not again
  await (await kick.registerStakers(wallets("new-stakers.json"))).wait();
  await (await kick.rejectAndRefund(wallets("refunds.json"))).wait();
  assert.equal(await usdc.balanceOf(await addr(g1)), U(100)); // Ben got his 15 back
  assert.equal(await kick.stakerCount(), 4n); // Ana, Cai, Dev, Pat

  // Bot pays again after the refund and is approved this time: offered for registration again
  const tx7b = await pay(g7, 15);
  const rows3 = (await rowsFor({ ana: "approved", ben: "declined" })).map((l) =>
    l.startsWith("Bot") ? l.replace("declined", "approved").replace(tx7, tx7b) : l.replace("pending_approval", "approved"));
  fs.writeFileSync(path.join(tmp, "guests3.csv"), [H, ...rows3].join("\n"));
  await run("verify-deposits.mjs", "--guests", "guests3.csv", "--scan-from-block", "0");
  assert.deepEqual(wallets("new-stakers.json"), [await addr(g7)]);
  // Bot's first (refunded) deposit is no longer claimed on Luma, but must not look like a stray to return
  const um = readOut("unmatched.csv");
  assert.match(um, new RegExp(`already refunded[^\\n]*${tx7.toLowerCase()}`));
  assert.match(um, new RegExp(`open[^\\n]*${tx6.toLowerCase()}`)); // Gus' own deposit is still open
  // …but if the old tx link is still pasted, they stay blocked until they pay again
  fs.writeFileSync(path.join(tmp, "guests3b.csv"), [H, ...rows3.map((l) => l.replace(tx7b, tx7))].join("\n"));
  await run("verify-deposits.mjs", "--guests", "guests3b.csv");
  assert.deepEqual(wallets("new-stakers.json"), []);
  assert.match(readOut("issues.csv"), /REFUNDED_EARLIER/);
  // A second Luma row (declined) claiming Ana's tx must not refund or register anyone
  fs.writeFileSync(path.join(tmp, "guests4.csv"), [H, `Ana2,ana2@x.io,${T},declined,,${await addr(g0)},${tx0}`, ...rows3].join("\n"));
  await run("verify-deposits.mjs", "--guests", "guests4.csv");
  assert.deepEqual(wallets("refunds.json"), []);
  assert.match(readOut("issues.csv"), /DUPLICATE_CLAIM/);
  // Bot is refunded again so the rest of the flow is unchanged
  await (await kick.refund(await addr(g7), U(15))).wait();
  await run("verify-deposits.mjs", "--guests", "guests2.csv");

  // Refund Eve's short deposit + Cai's overpayment (spare money only, never the pool)
  await (await kick.refund(await addr(g4), U(10))).wait();
  await (await kick.refund(await addr(g2), U(5))).wait();
  await reverts(kick, "refund", [await addr(g4), U(16)], "InsufficientBalance"); // 15 spare = Gus' unclaimed deposit

  // After the event: Ana, Cai, Dev checked in (Dev by hand); Pat no-show.
  const after = [H, ...(await rowsFor({ ana: "approved", ben: "declined" }))
    .map((l) => (l.startsWith("Ana") || l.startsWith("Cai") ? l.replace("approved,,", "approved,2026-11-04T19:02:00Z,") : l))];
  fs.writeFileSync(path.join(tmp, "after.csv"), after.join("\n"));
  fs.writeFileSync(path.join(tmp, "manual.csv"), "Email,Wallet\ndev@x.io,\n");
  const payoutLog = await run("build-payout.mjs", "--checkins", "after.csv", "--extra-checkins", "manual.csv");
  assert.match(payoutLog, /Stakers \| 4/);
  assert.match(payoutLog, /Showed up \| 3/);
  assert.match(payoutLog, /Payout per attendee \(if nobody is added by a challenge\) \| 20\.0 USDC/);
  assert.ok(fs.existsSync(path.join(tmp, "out/safe-post-attendance.json")));

  const plan = jsonOut("payout-plan.json");
  assert.equal(plan.share, U(20).toString());
  assert.equal(plan.stakers, 4);
  await reverts(kick, "postAttendance", [plan.attendees, BigInt(plan.share)], "TooEarly");
  await prov.send("evm_increaseTime", [3601]);
  await prov.send("evm_mine", []);
  await reverts(kick, "postAttendance", [plan.attendees, U(15)], "ShareMismatch");
  await (await kick.postAttendance(plan.attendees, BigInt(plan.share))).wait();
  await reverts(kick, "releasePayouts", [], "TooEarly");

  // Pat says they were there but was not scanned: challenges with the Kleros fee; nobody matches
  const fee = await kick.challengeDeposit();
  const pat = kick.connect(guests[8]);
  await (await pat.challenge({ value: fee })).wait();
  const challengesLog = await run("owner.mjs", "challenges");
  assert.match(challengesLog, /Waiting for a match/);
  const statusLog = await run("owner.mjs", "status");
  assert.match(statusLog, /phase: 'Listed'/);
  assert.match(statusLog, /pendingChallenges: 1/);

  await prov.send("evm_increaseTime", [86400 + 60]);
  await prov.send("evm_mine", []);
  const before = await Promise.all([...plan.attendees, await addr(g8)].map((w) => usdc.balanceOf(w)));
  await (await kick.connect(guests[3]).releasePayouts()).wait(); // anyone can release
  const afterBal = await Promise.all([...plan.attendees, await addr(g8)].map((w) => usdc.balanceOf(w)));
  afterBal.forEach((b, i) => assert.equal(b - before[i], U(15))); // 4 stakers × 15 = 60 pool / 4 attendees (Pat added)
  assert.equal(await usdc.balanceOf(await addr(g8)), U(100)); // Pat kept their deposit
  assert.equal(await prov.getBalance(kAddr), 0n); // Pat's ETH challenge deposit went back

  // Gus' unclaimed 15 stays → swept after settlement
  assert.equal(await usdc.balanceOf(kAddr), U(15));
  await (await kick.sweep(await owner.getAddress())).wait();
  assert.equal(await usdc.balanceOf(kAddr), 0n);
});
