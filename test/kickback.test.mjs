// End-to-end test on a local in-memory chain (ganache): contract + the CLI scripts, including
// curation (approved → register, declined → refund), the attendance list, a Kleros challenge
// (unmatched, so it counts as attended) and the payout. Further scenarios: deposits already
// returned, copied tx links, unusual senders, late payers, money to give back, CSV safety.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
const execFileP = promisify(execFile);
import ganache from "ganache";
import { ethers } from "ethers";
import { parse } from "csv-parse/sync";
import { csvCell, uncell, pairReturns, getLogsChunked, depKey, isContractCode } from "../scripts/lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"));
const U = (x) => ethers.parseUnits(String(x), 6);
// a free port, so several test runs can share a machine
const PORT = await new Promise((resolve, reject) => {
  const s = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => {
    const { port } = s.address();
    s.close(() => resolve(port));
  });
});

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
  prov.pollingInterval = 50; // ganache mines at once; the default 4 s poll only slows tx.wait() down
  owner = new ethers.NonceManager(new ethers.Wallet(ownerKey, prov));
  guests = guestKeys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
  usdc = await deploy("MockUSDC", owner);
  const t = (await prov.getBlock("latest")).timestamp;
  const arbitrator = await deploy("MockArbitrator", owner);
  resolver = await deploy("MockDisputeResolver", owner, await arbitrator.getAddress());
  const extra = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [1, 3, 1]);
  kick = await deploy("TruthPaysKickback", owner, await usdc.getAddress(), U(15), "Truth Pays", await owner.getAddress(), t + 3600, t + 3600 + 14 * 86400,
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
  assert.match(verified, /wallet taken from the transaction sender/);

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
  // A second Luma row (declined) claiming Ana's tx must not refund or register anyone, and must not
  // knock Ana (registered) out of verified.csv either: a declined duplicate never blocks.
  fs.writeFileSync(path.join(tmp, "guests4.csv"), [H, `Ana2,ana2@x.io,${T},declined,,${await addr(g0)},${tx0}`, ...rows3].join("\n"));
  await run("verify-deposits.mjs", "--guests", "guests4.csv");
  assert.deepEqual(wallets("refunds.json"), []);
  assert.match(readOut("issues.csv"), /DUPLICATE_TX,Ana2,/);
  assert.match(readOut("verified.csv"), /^Ana,ana@x\.io,.*,registered,/m);
  // …but while the copy is not declined either, a human decides (and nothing is listed)
  fs.writeFileSync(path.join(tmp, "guests4b.csv"), [H, `Ana2,ana2@x.io,${T},approved,,${await addr(g0)},${tx0}`, ...rows3].join("\n"));
  await run("verify-deposits.mjs", "--guests", "guests4b.csv");
  assert.match(readOut("issues.csv"), /DUPLICATE_CLAIM,Ana2,/);
  assert.match(readOut("issues.csv"), /DUPLICATE_CLAIM,Ana,/);
  assert.match(readOut("claims.csv"), /ana2@x\.io/); // both still count for her check-in
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

// ---------------------------------------------------------------- more scenarios (deposit 25)
// Each one gets its own contract and output folder, on the same chain.

const T25 = "Committed Spot ($25 Deposit)";
const FREE = "Request to Join (Free)";
const H25 = "name,email,ticket_name,approval_status,checked_in_at,eth_address,Deposit tx link (Committed Spot only)";
const EXTRA = ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [1, 3, 1]);
let minted = false;

async function newKickback(name = "Truth Pays") {
  const t = (await prov.getBlock("latest")).timestamp;
  return deploy("TruthPaysKickback", owner, await usdc.getAddress(), U(25), name, await owner.getAddress(), t + 3600, t + 3600 + 14 * 86400,
    [await resolver.getAddress(), EXTRA, "/ipfs/QmTest/attendance-policy.md"]);
}

async function scenario() {
  if (!minted) {
    for (const g of guests) await (await usdc.mint(await g.getAddress(), U(1000))).wait();
    minted = true;
  }
  const k = await newKickback();
  const kAddr = await k.getAddress();
  const deployBlock = (await k.deploymentTransaction().wait()).blockNumber;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "gt-"));
  const base = {
    chain: "local", chainId: 1337, rpcUrl: `http://127.0.0.1:${PORT}`, token: await usdc.getAddress(),
    tokenDecimals: 6, deposit: "25", receiver: kAddr, contract: kAddr, explorer: "https://example.org",
    depositOpensAt: "2020-01-01T00:00:00Z", depositDeadline: "2099-01-01T00:00:00Z", deployBlock: String(deployBlock),
    kleros: { disputeResolver: await resolver.getAddress() },
  };
  const config = (over = {}) => fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({ ...base, ...over }));
  config();
  const exec = (script, params, env = {}) =>
    execFileP("node", [path.join(root, "scripts", script), "--config", "config.json", ...params], { cwd: dir, encoding: "utf8", env: { ...process.env, ...env } });
  const run = async (script, ...params) => (await exec(script, ["--out", "out", ...params])).stdout;
  // a run that must fail: returns its output
  const fails = async (script, params, env) => {
    try {
      await exec(script, params, env);
    } catch (e) {
      return e.stderr + e.stdout;
    }
    assert.fail(`${script} ${params.join(" ")} should have failed`);
  };
  const verify = async (lines, ...params) => {
    fs.writeFileSync(path.join(dir, "guests.csv"), [H25, ...lines].join("\n"));
    return run("verify-deposits.mjs", "--guests", "guests.csv", ...params);
  };
  const outFile = (f) => path.join(dir, "out", f);
  const readOut = (f) => fs.readFileSync(outFile(f), "utf8");
  const csv = (f) => parse(readOut(f), { columns: true, skip_empty_lines: true });
  const jsonOut = (f) => JSON.parse(readOut(f));
  const wallets = (f) => jsonOut(f).items.map((i) => i.wallet);
  const pay = async (g, amount) => (await (await usdc.connect(g).transfer(kAddr, U(amount))).wait()).hash;
  const row = (name, wallet, decision, tx, ticket = T25) => `${name},${name.toLowerCase()}@x.io,${ticket},${decision},,${wallet},${tx}`;
  const umRow = (tx) => csv("unmatched.csv").find((r) => r.tx === tx.toLowerCase());
  const returnsOf = () => csv("returns.csv").map((r) => [r.code, r.wallet, r.to_return]);
  return { k, kAddr, dir, deployBlock, config, run, fails, verify, outFile, readOut, csv, jsonOut, wallets, pay, row, umRow, returnsOf };
}

test("CSV cells: formulas neutralised, CR quoted; chunked log scans; refunds paired with the right deposit", async () => {
  assert.equal(csvCell('=HYPERLINK("http://x")'), `"'=HYPERLINK(""http://x"")"`);
  for (const s of ["+1", "-5", "@SUM(A1)", "\tx"]) assert.equal(csvCell(s), "'" + s);
  assert.equal(csvCell("a\rb"), '"a\rb"');
  assert.equal(csvCell("a,b"), '"a,b"');
  assert.equal(csvCell("0xabc"), "0xabc");
  assert.equal(uncell("'=x"), "=x");
  assert.equal(uncell("'plain"), "'plain");
  assert.equal(isContractCode("0x"), false);
  assert.equal(isContractCode("0xef0100" + "ab".repeat(20)), false); // EIP-7702 wallet
  assert.equal(isContractCode("0x6080604052"), true);

  // eth_getLogs is never asked for more than 50k blocks at a time
  const ranges = [];
  const fake = { getBlockNumber: async () => 120_000, getLogs: async (f) => (ranges.push([f.fromBlock, f.toBlock]), []) };
  await getLogsChunked(fake, { address: ethers.ZeroAddress }, 10, "latest");
  assert.deepEqual(ranges, [[10, 50_009], [50_010, 100_009], [100_010, 120_000]]);

  // A registered staker's deposit is never used up by refund(): an exact 5 refund covers the
  // overpayment, and a 25 refund after a stray of 25 covers the stray, not the stake
  const A = "0x" + "aa".repeat(20);
  const dep = (tx, amount, block) => ({ tx, from: A, amount, block, logIndex: 0 });
  const ev = (type, amount, block, tx) => ({ type, wallet: A, amount, block, logIndex: 0, tx });
  const { byDeposit } = pairReturns(
    [dep("0x01", U(30), 1), dep("0x02", U(25), 3)],
    [ev("StakerRegistered", 0n, 2, "0xr"), ev("Refunded", U(5), 4, "0xf1"), ev("Refunded", U(25), 5, "0xf2")],
    { deposit: U(25), prefer: new Set(["0x01"]) });
  const s1 = byDeposit.get(depKey("0x01", A));
  const s2 = byDeposit.get(depKey("0x02", A));
  assert.equal(s1.staked, true);
  assert.equal(s1.remaining, U(25)); // the stake is intact
  assert.equal(s2.remaining, 0n);
  // a refund only covers deposits made before it
  const late = pairReturns([dep("0x03", U(25), 9)], [ev("Refunded", U(25), 8, "0xf3")], { deposit: U(25) });
  assert.equal(late.byDeposit.get(depKey("0x03", A)).remaining, U(25));
  assert.equal(late.unpaired.length, 1);
});

test("returned deposits are never listed again: refund() and refund-declined history, by amount, nothing asked twice", async () => {
  const s = await scenario();
  const [gil, pat, wil, xan, yas] = await Promise.all(guests.slice(0, 5).map((g) => g.getAddress()));
  const [Gil, Pat, Wil, Xan, Yas] = guests;
  const txGil = await s.pay(Gil, 25); // pays before signing up on Luma
  const txPat = await s.pay(Pat, 25); // waits for a decision the whole time
  const txWil = await s.pay(Wil, 25); // declined
  const txXan1 = await s.pay(Xan, 10); // too low…
  const txXan2 = await s.pay(Xan, 25); // …then a full one that he never pastes
  const txYas1 = await s.pay(Yas, 30); // overpays…
  const txYas2 = await s.pay(Yas, 25); // …and sends a stray 25
  let lines = [
    s.row("Pat", pat, "pending_approval", txPat), s.row("Wil", wil, "declined", txWil),
    s.row("Xan", xan, "approved", txXan1), s.row("Yas", yas, "approved", txYas1),
  ];
  const log1 = await s.verify(lines);
  assert.equal(s.umRow(txGil).status, "open");
  assert.equal(s.umRow(txGil).to_return, "25.0");
  assert.deepEqual(s.returnsOf().sort(), [["AMOUNT_TOO_LOW", xan, "10.0"], ["OVERPAID", yas, "5.0"]]);
  assert.match(s.readOut("issues.csv"), /^OVERPAID,Yas,/m);
  assert.match(log1, /To give back with "Return a stray transfer".*: 2 \(15\.0 USDC\)/);
  assert.match(log1, /10\.0 USDC → 0x/);
  assert.deepEqual(s.wallets("new-stakers.json"), [yas]);
  assert.deepEqual(s.wallets("refunds.json"), [wil]);

  // The organiser does all of it: register Yas, refund Wil, return Gil's stray, Xan's 10, Yas' 5
  await (await s.k.registerStakers([yas])).wait();
  await (await s.k.rejectAndRefund([wil])).wait();
  await (await s.k.refund(gil, U(25))).wait();
  await (await s.k.refund(xan, U(10))).wait();
  await (await s.k.refund(yas, U(5))).wait();

  // Gil now signs up with the tx that was returned and is approved; Wil pays again, still declined
  const txWil2 = await s.pay(Wil, 25);
  lines = [
    s.row("Gil", gil, "approved", txGil), s.row("Pat", pat, "pending_approval", txPat), s.row("Wil", wil, "declined", txWil2),
    s.row("Xan", xan, "approved", txXan1), s.row("Yas", yas, "approved", txYas1),
  ];
  await s.verify(lines);
  assert.deepEqual(s.wallets("new-stakers.json"), []); // never Gil: his money is gone
  assert.deepEqual(s.wallets("refunds.json"), []);
  const issues = s.readOut("issues.csv");
  assert.match(issues, /^RETURNED_EARLIER,Gil,/m);
  assert.match(issues, /^PAID_AGAIN_DECLINED,Wil,/m);
  assert.doesNotMatch(issues, /^OVERPAID,/m); // Yas' 5 went back
  assert.match(s.readOut("verified.csv"), /^Gil,.*,returned,/m);
  assert.deepEqual(s.returnsOf(), [["PAID_AGAIN_DECLINED", wil, "25.0"]]); // not Xan's 10 again
  // a 10 refund can't cover a 25 stray, and Yas' 5 was the overpayment, not his stray
  assert.equal(s.umRow(txXan2).status, "open");
  assert.equal(s.umRow(txXan2).to_return, "25.0");
  assert.equal(s.umRow(txYas2).status, "open");
  assert.equal(s.umRow(txYas2).to_return, "25.0");
  assert.equal(s.umRow(txGil), undefined); // claimed now
  assert.match(s.umRow(txWil).status, /^already refunded/); // the first one, refunded when declined

  // Return Wil's second deposit: PAID_AGAIN_DECLINED is done and never asked again
  await (await s.k.refund(wil, U(25))).wait();
  await s.verify(lines);
  assert.doesNotMatch(s.readOut("issues.csv"), /PAID_AGAIN_DECLINED/);
  assert.deepEqual(s.returnsOf(), []);
  // Approving Wil now does not register him without a new deposit
  lines = lines.map((l) => (l.startsWith("Wil") ? l.replace("declined", "approved") : l));
  await s.verify(lines);
  assert.deepEqual(s.wallets("new-stakers.json"), []);
  assert.match(s.readOut("issues.csv"), /^REFUNDED_EARLIER,Wil,/m);

  // Pat's deposit was never touched: declining her still refunds her
  lines = lines.map((l) => (l.startsWith("Pat") ? l.replace("pending_approval", "declined") : l));
  await s.verify(lines);
  assert.deepEqual(s.jsonOut("refunds.json").items.map((i) => [i.wallet, i.status]), [[pat, 0]]);

  // owner.mjs (developers) refuses a list for another network, or one that is out of date
  const env = { PRIVATE_KEY: ownerKey };
  fs.writeFileSync(path.join(s.dir, "other-chain.json"), JSON.stringify({ ...s.jsonOut("refunds.json"), chainId: 999 }));
  assert.match(await s.fails("owner.mjs", ["refund-declined", "--file", "other-chain.json"], env), /made for chain 999/);
  await (await s.k.rejectAndRefund([pat])).wait();
  assert.match(await s.fails("owner.mjs", ["refund-declined", "--file", "out/refunds.json"], env), /out of date/);

  // The strays go back; afterwards they read "already refunded" and nothing is spare
  await (await s.k.refund(xan, U(25))).wait();
  await (await s.k.refund(yas, U(25))).wait();
  await s.verify(lines);
  assert.match(s.umRow(txXan2).status, /^already refunded/);
  assert.match(s.umRow(txYas2).status, /^already refunded/);
  assert.deepEqual(s.returnsOf(), []);
  assert.deepEqual(s.wallets("refunds.json"), []);
  assert.equal(await s.k.spare(), 0n);
  assert.equal(await usdc.balanceOf(s.kAddr), U(25)); // only Yas' stake
});

test("late payers, unusual senders, free guests and formula cells", async () => {
  const s = await scenario();
  const [ann, lou, lea] = await Promise.all([guests[5], guests[6], guests[7]].map((g) => g.getAddress()));
  const txAnn = await s.pay(guests[5], 25);
  // a bridge minting USDC straight to the contract, and a contract sending it
  const txMint = (await (await usdc.mint(s.kAddr, U(25))).wait()).hash;
  const relay = await newKickback("Relay");
  await (await usdc.connect(guests[8]).transfer(await relay.getAddress(), U(25))).wait();
  const txRelay = (await (await relay.refund(s.kAddr, U(25))).wait()).hash;
  const txStrayMint = (await (await usdc.mint(s.kAddr, U(5))).wait()).hash; // nobody claims this one
  // deposits close; two guests pay late
  const closeAt = (await prov.getBlock("latest")).timestamp + 5;
  s.config({ depositDeadline: new Date(closeAt * 1000).toISOString() });
  await prov.send("evm_increaseTime", [60]);
  await prov.send("evm_mine", []);
  const txLou = await s.pay(guests[6], 25);
  const txLea = await s.pay(guests[7], 30);

  const lines = [
    `"=HYPERLINK(""http://evil.example"",""click"")",ann@x.io,${T25},approved,,${ann},${txAnn}`,
    `Min,min@x.io,${T25},approved,,,${txMint}`,
    `Con,con@x.io,${T25},declined,,,${txRelay}`,
    `Hal,hal@x.io,${FREE},approved,,,N/A`,
    `Ida,ida@x.io,${FREE},approved,,,-`,
    `Joe,joe@x.io,${FREE},approved,,,none`,
    s.row("Lou", lou, "declined", txLou),
    `+Lea,lea@x.io,${T25},pending_approval,,${lea},${txLea}`,
  ];
  const log = await s.verify(lines);
  assert.deepEqual(s.wallets("new-stakers.json"), [ann]);
  // the declined late payer is refunded with "Refund declined guests" (status 0 = unregistered)
  assert.deepEqual(s.jsonOut("refunds.json").items.map((i) => [i.wallet, i.status, i.onchain]), [[lou, 0, "unregistered"]]);
  const issues = s.csv("issues.csv");
  const codeOf = (email) => issues.filter((i) => i.email === email).map((i) => i.code);
  assert.deepEqual(codeOf("min@x.io"), ["UNUSUAL_SENDER"]);
  assert.deepEqual(codeOf("con@x.io"), ["UNUSUAL_SENDER"]);
  assert.match(issues.find((i) => i.email === "con@x.io").note, /contract/);
  assert.deepEqual(codeOf("lou@x.io"), ["OUTSIDE_WINDOW"]);
  for (const e of ["hal@x.io", "ida@x.io", "joe@x.io"]) assert.deepEqual(codeOf(e), [], `${e} is a free guest`);
  assert.ok(!s.readOut("refunds.json").includes(ethers.ZeroAddress));
  assert.ok(!s.readOut("new-stakers.json").includes(ethers.ZeroAddress));
  // the undeclined late payer's 30 goes back with "Return a stray transfer"
  assert.deepEqual(s.returnsOf(), [["OUTSIDE_WINDOW", lea, "30.0"]]);
  assert.match(log, /30\.0 USDC → 0x/);
  // the unclaimed bridge mint is open, with a warning not to send it back to 0x0
  assert.equal(s.umRow(txStrayMint).status, "open");
  assert.match(s.umRow(txStrayMint).note, /Minted straight/);
  // formula cells are neutralised in every CSV we write
  for (const f of ["verified.csv", "issues.csv", "returns.csv", "claims.csv", "to-review.csv"]) {
    assert.doesNotMatch(s.readOut(f), /(^|,)"?[=+@-]/m, `${f} has a cell starting with a formula character`);
  }
  assert.match(s.readOut("verified.csv"), /"'=HYPERLINK\(""http:\/\/evil\.example""/);
  assert.match(s.readOut("returns.csv"), /,'\+Lea,/);

  // Refund Lou as listed: it works for an unregistered late payer, and he is not listed again
  await (await s.k.registerStakers([ann])).wait();
  await (await s.k.rejectAndRefund([lou])).wait();
  await s.verify(lines);
  assert.deepEqual(s.wallets("refunds.json"), []);
  assert.deepEqual(s.returnsOf(), [["OUTSIDE_WINDOW", lea, "30.0"]]);
  // Lea declined: "Refund declined guests" sends her 25, and the 5 extra is listed to give back
  await s.verify(lines.map((l) => l.replace("pending_approval", "declined")));
  assert.deepEqual(s.wallets("refunds.json"), [lea]);
  assert.deepEqual(s.returnsOf(), [["OVERPAID", lea, "5.0"]]);
});

test("a copied tx link never knocks out the real guest, and build-payout still pays them", async () => {
  const s = await scenario();
  const [sam, sue, eve, zed, ali] = await Promise.all(guests.slice(0, 5).map((g) => g.getAddress()));
  const txSam = await s.pay(guests[0], 25);
  const txSue = await s.pay(guests[1], 25);
  await s.verify([s.row("Sam", sam, "approved", txSam), s.row("Sue", sue, "approved", txSue)]);
  assert.deepEqual(s.wallets("new-stakers.json"), [sam, sue]);
  await (await s.k.registerStakers([sam, sue])).wait();

  // Listed before Sam in the export: a stranger with no ETH address (declined) and a copier who
  // states her own wallet (pending) both paste Sam's public tx link
  const copies = [`Str,str@x.io,${T25},declined,,,${txSam}`, s.row("Cop", eve, "pending_approval", txSam)];
  let lines = [...copies, s.row("Sam", sam, "approved", txSam), s.row("Sue", sue, "approved", txSue)];
  await s.verify(lines);
  const dups = () => s.csv("issues.csv").filter((i) => /^DUPLICATE/.test(i.code)).map((i) => [i.code, i.name]).sort();
  assert.deepEqual(dups(), [["DUPLICATE_TX", "Cop"], ["DUPLICATE_TX", "Str"]]);
  assert.match(s.readOut("verified.csv"), /^Sam,sam@x\.io,.*,registered,/m);
  assert.deepEqual(s.wallets("refunds.json"), []); // nobody refunded, Sam stays
  assert.deepEqual(s.wallets("new-stakers.json"), []);
  // even an approved blank-address copy can't displace him (his stated wallet sent it)
  lines = lines.map((l) => (l.startsWith("Str") ? l.replace("declined", "approved") : l));
  await s.verify(lines);
  assert.match(s.readOut("verified.csv"), /^Sam,/m);
  assert.deepEqual(dups(), [["DUPLICATE_TX", "Cop"], ["DUPLICATE_TX", "Str"]]);

  // After the event: Sam and Sue checked in; the copies change nothing
  const checkIn = (who) => (l) => (who.some((w) => l.startsWith(w + ",")) ? l.replace(",approved,,", ",approved,2026-11-04T19:00:00Z,") : l);
  fs.writeFileSync(path.join(s.dir, "after.csv"), [H25, ...lines.map(checkIn(["Sam", "Sue"]))].join("\n"));
  let log = await s.run("build-payout.mjs", "--checkins", "after.csv");
  assert.match(log, /Showed up \| 2/);
  assert.deepEqual(s.jsonOut("payout-plan.json").attendees.sort(), [sam, sue].sort());

  // Sam signed up twice (two emails, both approved): both rows wait for a human decision, and
  // his check-in under either email still counts
  lines = [s.row("Sam", sam, "approved", txSam), s.row("Sam2", sam, "approved", txSam), s.row("Sue", sue, "approved", txSue)];
  await s.verify(lines);
  assert.doesNotMatch(s.readOut("verified.csv"), /sam@x\.io/);
  assert.deepEqual(dups(), [["DUPLICATE_CLAIM", "Sam"], ["DUPLICATE_CLAIM", "Sam2"]]);
  assert.match(s.readOut("claims.csv"), /sam2@x\.io/);
  fs.writeFileSync(path.join(s.dir, "after2.csv"), [H25, ...lines.map(checkIn(["Sam2", "Sue"]))].join("\n"));
  log = await s.run("build-payout.mjs", "--checkins", "after2.csv");
  assert.match(log, /Showed up \| 2/);
  // a registered staker with no verified registration at all: no quiet "no-show" advice
  fs.writeFileSync(path.join(s.dir, "empty.csv"), "wallet,email\n");
  const err = await s.fails("build-payout.mjs", ["--out", "out", "--checkins", "after2.csv", "--verified", "empty.csv", "--claims", "empty.csv"]);
  assert.match(err, /--allow-missing would count every one of them as a no-show/);
  assert.match(err, /only use it after checking each of them by hand/);

  // A tx whose stated owner did not send it (an exchange withdrawal?) is "used" by that row: a
  // blank-address row pasting it can't take the seat while that row is not declined
  const txZed = await s.pay(guests[3], 25);
  lines = [s.row("Ali", ali, "pending_approval", txZed), `Bob,bob@x.io,${T25},approved,,,${txZed}`, s.row("Sam", sam, "approved", txSam), s.row("Sue", sue, "approved", txSue)];
  await s.verify(lines);
  assert.deepEqual(s.wallets("new-stakers.json"), []);
  const mine = s.csv("issues.csv").filter((i) => ["ali@x.io", "bob@x.io"].includes(i.email)).map((i) => [i.name, i.code]).sort();
  assert.deepEqual(mine, [["Ali", "WRONG_SENDER"], ["Bob", "DUPLICATE_CLAIM"]]);
  // once Ali is declined, the deposit (wallet taken from the sender) is Bob's
  await s.verify(lines.map((l) => (l.startsWith("Ali") ? l.replace("pending_approval", "declined") : l)));
  assert.deepEqual(s.wallets("new-stakers.json"), [zed]);
  assert.match(s.readOut("verified.csv"), /^Bob,.*wallet taken from the transaction sender/m);
});

test("live mode needs the deploy block; a stopped run leaves no stale lists behind", async () => {
  const s = await scenario();
  const eve = await guests[2].getAddress();
  const tx = await s.pay(guests[2], 25);
  await (await usdc.mint(s.kAddr, U(7))).wait(); // a stray
  const lines = [s.row("Eve", eve, "approved", tx)];
  await s.verify(lines);
  for (const f of ["unmatched.csv", "returns.csv", "new-stakers.json"]) assert.ok(fs.existsSync(s.outFile(f)), f);
  s.config({ mode: "live", deployBlock: "" });
  const err = await s.fails("verify-deposits.mjs", ["--guests", "guests.csv", "--out", "out"]);
  assert.match(err, /deployBlock/);
  for (const f of ["unmatched.csv", "returns.csv", "new-stakers.json", "refunds.json", "verified.csv"]) assert.ok(!fs.existsSync(s.outFile(f)), `${f} removed`);
  await s.verify(lines, "--scan-from-block", String(s.deployBlock));
  assert.deepEqual(s.wallets("new-stakers.json"), [eve]);
  assert.deepEqual(s.csv("unmatched.csv").filter((r) => r.status === "open").map((r) => r.to_return), ["7.0"]);
});
