#!/usr/bin/env node
// Step 1 (run any time during registration, as often as you like).
//
//   node scripts/verify-deposits.mjs --guests luma-guests.csv [--config config.json]
//        [--out out] [--scan-from-block 123456]
//
// Reads the Luma guest export, checks every pasted deposit tx on-chain, and sorts the
// verified payers by the organiser's decision in Luma (approval_status):
//   out/verified.csv          every guest whose deposit checks out (with their Luma decision)
//   out/issues.csv            anything that needs a human look (wrong amount, wrong chain…)
//   out/to-review.csv         verified payers still waiting for the organiser's approve/decline
//   out/new-stakers.json      approved + verified wallets not yet registered → "Register stakers"
//   out/refunds.json          declined payers whose deposit is still held → "Refund declined guests"
//   out/returns.csv           money of Luma guests to give back with "Return a stray transfer"
//                             (short or late payments, overpayments…), net of what was already returned
//   out/unmatched.csv         deposits received that no guest claimed (with what is left to return)
//   out/claims.csv            every Luma row whose deposit verified for a wallet (build-payout
//                             matches check-ins to registered wallets through it)
//   out/safe-register.json    Safe Transaction Builder batch for registerStakers()
//   out/safe-refunds.json     Safe Transaction Builder batch for rejectAndRefund()
//
// The contract counts money in total, not per wallet, so this script is what makes sure every
// wallet it lists still has its own deposit in the contract: what the contract already sent back
// (Refund declined guests, Return a stray transfer) is paired with each wallet's deposits.
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  args, loadConfig, provider, readCsv, writeCsv, writeJson, verifyRegistrations, resolveClaims,
  pairReturns, getLogsChunked, incomingTransfers, depKey, isContractCode, safeBatch, loadAbi, fmt, STATUS,
} from "./lib.mjs";

const a = args();
if (!a.guests) {
  console.error("Usage: node scripts/verify-deposits.mjs --guests <luma-export.csv> [--config config.json] [--out out] [--scan-from-block N]");
  process.exit(1);
}
const configFile = a.config ?? "config.json";
const out = a.out ?? "out";

// A run that stops half-way must never leave the previous run's lists looking current.
const OUTPUTS = ["verified.csv", "issues.csv", "to-review.csv", "returns.csv", "unmatched.csv", "claims.csv",
  "new-stakers.json", "refunds.json", "safe-register.json", "safe-refunds.json"];
for (const f of OUTPUTS) fs.rmSync(path.join(out, f), { force: true });

const cfg = loadConfig(configFile);

if (a["scan-from-block"] !== undefined && !/^\d+$/.test(String(a["scan-from-block"]))) {
  console.error("--scan-from-block needs a block number (the block the contract was deployed in).");
  process.exit(1);
}
let scanFrom = a["scan-from-block"] !== undefined ? Number(a["scan-from-block"]) : cfg.deployBlock;
if (scanFrom === undefined && cfg.mode) {
  // live, rehearsal or testnet: a real network, where scanning from block 0 is not an option
  console.error(`No "deployBlock" in ${configFile} and no --scan-from-block. Without the deploy block, refunds already sent and ` +
    `deposits nobody claimed can't be checked, so nothing is listed (${cfg.mode} mode). Set "deployBlock" in ${configFile} ` +
    `or pass --scan-from-block <deploy block>.`);
  process.exit(1);
}

const prov = provider(cfg);
const rows = readCsv(a.guests);
console.log(`Loaded ${rows.length} registrations from ${a.guests}`);

const { results, columns } = await verifyRegistrations(prov, cfg, rows);
console.log(`Columns used: ${JSON.stringify(columns)}`);
if (!columns.approval) console.warn("⚠️  No approval_status column: every verified payer is treated as pending.");

// The contract (the receiver may also be a Safe/EOA, then there is no on-chain registry)
const code = await prov.getCode(cfg.receiver);
const kickbackAddr = cfg.contract ? ethers.getAddress(cfg.contract) : code !== "0x" ? cfg.receiver : null;
let c = null;
let iface = null;
const snapshotBlock = await prov.getBlockNumber();
if (kickbackAddr) {
  const { abi } = loadAbi("TruthPaysKickback");
  c = new ethers.Contract(kickbackAddr, abi, prov);
  iface = new ethers.Interface(abi);
}
if (scanFrom === undefined && kickbackAddr) {
  console.warn('⚠️  No "deployBlock" in the config: scanning from block 0 (only fine on a local test chain).');
  scanFrom = 0;
}
if (scanFrom === undefined) console.warn('⚠️  No "deployBlock" in the config: deposits nobody claimed on Luma are NOT being checked.');

// Every deposit we know of: the ones guests pasted, plus every USDC transfer in since the start block.
const deposits = [];
let incoming = null;
if (scanFrom !== undefined) {
  const perDeposit = new Map(); // one deposit = what one wallet sent in one tx
  for (const t of await incomingTransfers(prov, cfg, scanFrom, snapshotBlock)) {
    const k = depKey(t.tx, t.from);
    const d = perDeposit.get(k) ?? { ...t, amount: 0n };
    d.amount += t.amount;
    d.logIndex = Math.min(d.logIndex, t.logIndex);
    perDeposit.set(k, d);
  }
  incoming = [...perDeposit.values()];
  deposits.push(...incoming);
}
for (const r of results) for (const d of r.deposits ?? []) deposits.push({ tx: r.tx, from: d.from, amount: d.amount, block: r.block, logIndex: d.logIndex });

// On-chain status of every wallet that sent money, at one block
const statusOf = new Map(); // lower-case wallet → 0..3 (missing = could not be read)
const st = (w) => (c ? statusOf.get(String(w).toLowerCase()) : STATUS.None);
if (c) {
  const wallets = [...new Set(deposits.map((d) => ethers.getAddress(d.from)))].filter((w) => w !== ethers.ZeroAddress);
  for (let i = 0; i < wallets.length; i += 10) {
    await Promise.all(wallets.slice(i, i + 10).map(async (w) => {
      try {
        statusOf.set(w.toLowerCase(), Number(await c.status(w, { blockTag: snapshotBlock })));
      } catch (e) {
        console.warn(`Could not read status of ${w}: ${e.shortMessage || e.message}`);
      }
    }));
  }
}

// What the contract sent back to each wallet, and when it registered them. The range starts at the
// oldest deposit we know of, so no refund of a pasted deposit is missed.
let events = [];
if (c) {
  const from = Math.min(scanFrom ?? Infinity, ...deposits.map((d) => Number(d.block)).filter(Number.isFinite));
  if (Number.isFinite(from)) {
    const topics = [["Rejected", "Refunded", "StakerRegistered"].map((n) => iface.getEvent(n).topicHash)];
    events = (await getLogsChunked(prov, { address: kickbackAddr, topics }, from, snapshotBlock)).map((l) => {
      const p = iface.parseLog(l);
      return {
        type: p.name, wallet: ethers.getAddress(p.args[0]), amount: p.name === "StakerRegistered" ? 0n : p.args[1],
        block: l.blockNumber, logIndex: l.index, tx: l.transactionHash.toLowerCase(),
      };
    });
  }
}
const dep = cfg.depositUnits;
const { byDeposit, unbacked, unpaired } = pairReturns(deposits, events, {
  deposit: dep,
  prefer: new Set(results.filter((r) => r.code === "VERIFIED").map((r) => r.tx.toLowerCase())),
  stakers: new Set([...statusOf].filter(([, s]) => s === STATUS.Staker || s === STATUS.Paid).map(([w]) => w)),
});
const depOf = (r) => byDeposit.get(depKey(r.tx, r.wallet));
// money of this row's deposit the contract still holds and nobody has staked
const freeOf = (r) => {
  const d = depOf(r);
  return d ? d.remaining - (d.staked ? dep : 0n) : r.units ?? 0n;
};
const held = (r) => !!depOf(r)?.staked || freeOf(r) >= dep;

// Several rows claiming one tx or one wallet: keep the real owner, flag the others.
const { kept, issues } = resolveClaims(results, { isStaker: (w) => st(w) === STATUS.Staker, held });

const verified = [];
const newStakers = [];
const refunds = [];
const toReview = [];
const returns = [];
const STRAY = "'Return a stray transfer'";
const usdc = (x) => `${fmt(x, cfg.decimals)} USDC`;
// wallets whose registration is backed by one of their own deposits
const backed = new Set([...byDeposit.values()].filter((d) => d.staked).map((d) => d.from.toLowerCase()));
const giveBack = (r, code, amount, note) => {
  // a registered wallet with no deposit of its own behind its spot: returning more would dig the hole deeper
  const s = st(r.wallet);
  if (amount <= 0n || ((s === STATUS.Staker || s === STATUS.Paid) && !backed.has(r.wallet.toLowerCase()))) return false;
  returns.push({ code, name: r.name, email: r.email, wallet: r.wallet, to_return: fmt(amount, cfg.decimals), units: amount, paid: r.amount, tx: r.tx, explorer: r.explorer, note });
  return true;
};
const LABEL = ["unregistered", "registered", "paid", "refunded"];

for (const r of kept) {
  const s = st(r.wallet);
  const free = freeOf(r);
  r.onchain = s === undefined ? "unknown" : LABEL[s];
  if (r.code !== "VERIFIED") {
    // the guest's own wallet sent money, but it can't be a deposit (short or late)
    issues.push(r);
    if (s === undefined) continue;
    if (r.code === "AMOUNT_TOO_LOW") {
      if (free === 0n) r.note += " (Already returned.)";
      giveBack(r, "AMOUNT_TOO_LOW", free, "Short deposit: return it and ask for one new transfer of the full deposit");
    } else if (r.decision === "declined" && s === STATUS.None && free >= dep) {
      // a declined late payer: rejectAndRefund works for unregistered payers while their money is spare
      refunds.push({ ...r, onchain: "unregistered" });
      r.note += ". Declined: in refunds.json ('Refund declined guests')";
      giveBack(r, "OVERPAID", free - dep, `Late and overpaid: the rest after 'Refund declined guests' sends back ${cfg.deposit}`);
    } else {
      giveBack(r, "OUTSIDE_WINDOW", free, r.decision === "declined"
        ? "Late payment, declined"
        : "Late payment: it can't be registered. Return it, or decline on Luma so 'Refund declined guests' sends it back");
    }
    continue;
  }

  verified.push(r);
  if (s === STATUS.None && !held(r)) r.onchain = "returned";
  if (s === STATUS.Rejected && held(r)) r.onchain = "refunded, paid again"; // a new deposit after their refund
  let used = 0n; // the part of this deposit a listed action takes (a spot, or the refund of the deposit)
  switch (r.onchain) {
    case "unregistered":
    case "refunded, paid again":
      if (r.decision === "approved") { newStakers.push(r); used = dep; }
      else if (r.decision === "declined") {
        if (r.onchain === "unregistered") { refunds.push(r); used = dep; }
        else {
          issues.push({ ...r, code: "PAID_AGAIN_DECLINED", note: `Declined, refunded once already, and then paid again. Return the new deposit with ${STRAY} (listed in returns.csv).` });
          giveBack(r, "PAID_AGAIN_DECLINED", free, "Declined, refunded once already, then paid again");
          used = free;
        }
      } else { toReview.push(r); used = dep; }
      break;
    case "returned":
      if (r.decision !== "declined")
        issues.push({ ...r, code: "RETURNED_EARLIER", note: `This deposit was already returned (${STRAY}). The guest must send a new ${cfg.deposit} USDC deposit and paste that link before they can be registered.` });
      giveBack(r, "PARTLY_RETURNED", free, "Rest of a deposit that was partly returned: it can no longer hold a spot");
      used = free;
      break;
    case "refunded":
      if (r.decision === "approved")
        issues.push({ ...r, code: "REFUNDED_EARLIER", note: "Approved now, but this deposit was already refunded. They must send a new deposit before they can be registered." });
      giveBack(r, "PARTLY_RETURNED", free, "Left over from a refunded deposit");
      used = free;
      break;
    case "registered":
      if (r.decision === "declined") refunds.push(r); // rejectAndRefund sends the staked deposit back
      else if (r.decision !== "approved")
        issues.push({ ...r, code: "REGISTERED_NOT_APPROVED", note: "Registered on-chain but no longer approved on Luma. Approve again, or decline to refund." });
      break;
    case "paid":
      break;
    default:
      continue; // status unknown: no action, nothing to give back
  }
  // Money beyond one deposit from this tx (an overpayment, or a second deposit of a registered wallet)
  const extra = free - used;
  if (giveBack(r, "OVERPAID", extra, "More than the deposit")) {
    r.note = [r.note, `overpaid by ${fmt(extra, cfg.decimals)} (return the excess with ${STRAY}; see returns.csv)`].filter(Boolean).join("; ");
    issues.push({ ...r, code: "OVERPAID", note: `${usdc(extra)} more than the deposit is still held from this payment. Return the excess with ${STRAY} (listed in returns.csv).` });
  }
}
// A second deposit from a wallet already counted for another registration goes back to that wallet.
for (const i of issues) if (i.code === "DUPLICATE_WALLET" && i.extra && st(i.wallet) !== undefined) giveBack(i, "DUPLICATE_WALLET", freeOf(i), "Second deposit from a wallet that is already counted");

// Safety net: a wallet is listed once, never as the zero address (either would make the batch revert).
const listed = [...newStakers, ...refunds].map((v) => v.wallet.toLowerCase());
if (new Set(listed).size !== listed.length || listed.includes(ethers.ZeroAddress))
  throw new Error("Internal check failed: a wallet would be listed twice (or is 0x0). Nothing was written; investigate.");

// Deposits nobody's Luma row points at
let unmatched = null;
if (incoming) {
  const claimedTx = new Set(results.map((r) => String(r.tx).toLowerCase()));
  unmatched = [];
  for (const t of incoming.filter((x) => !claimedTx.has(x.tx))) {
    const d = byDeposit.get(depKey(t.tx, t.from));
    const free = d.remaining - (d.staked ? dep : 0n);
    let status = "open";
    let note = "";
    if (free <= 0n) status = d.staked ? "held for a registered staker" : `already refunded (${[...new Set(d.returnedBy)].join(" ")})`;
    else if (t.from === ethers.ZeroAddress) note = "Minted straight to the contract (a bridge?): don't return it to this address; find out whose it is.";
    else if (isContractCode(await prov.getCode(t.from))) note = "Sent by a contract (bridge, exchange or smart wallet?): check where it should go before returning it.";
    else if (free < t.amount) note = `Partly returned already (${[...new Set(d.returnedBy)].join(" ")}).`;
    unmatched.push({ status, from: t.from, amount: fmt(t.amount, cfg.decimals), to_return: fmt(free > 0n ? free : 0n, cfg.decimals), units: free > 0n ? free : 0n, block: t.block, tx: t.tx, explorer: `${cfg.explorer}/tx/${t.tx}`, note });
  }
}

// ---------------------------------------------------------------- write everything
const vCols = ["name", "email", "ticket", "approval", "onchain", "wallet", "amount", "sent_at", "tx", "explorer", "note"];
writeCsv(`${out}/verified.csv`, verified, vCols);
writeCsv(`${out}/issues.csv`, issues, ["code", ...vCols]);
writeCsv(`${out}/to-review.csv`, toReview, vCols);
writeCsv(`${out}/returns.csv`, returns, ["code", "name", "email", "wallet", "to_return", "paid", "tx", "explorer", "note"]);
// every row whose tx verified as its wallet's deposit, duplicates included: a check-in through any
// of them counts for that wallet (payouts only ever go to the registered wallet itself)
const claims = [...verified, ...issues.filter((i) => i.was === "VERIFIED" && /^DUPLICATE_/.test(i.code))];
writeCsv(`${out}/claims.csv`, claims.map((r) => ({ ...r, code: r.was ? r.code : "VERIFIED" })), ["wallet", "email", "name", "code", "approval", "tx"]);
// The console checks contract, network and each wallet's on-chain status before sending, so an
// out-of-date list is refused instead of acting on a guest whose situation has changed.
const stamp = { contract: kickbackAddr, chainId: Number(cfg.chainId), block: snapshotBlock, generatedAt: new Date().toISOString() };
const STATUS_OF = { unregistered: 0, registered: 1, "refunded, paid again": 3 };
const item = (v) => ({ wallet: v.wallet, name: v.name, email: v.email, onchain: v.onchain, status: STATUS_OF[v.onchain] });
writeJson(`${out}/new-stakers.json`, { ...stamp, items: newStakers.map(item) });
writeJson(`${out}/refunds.json`, { ...stamp, items: refunds.map(item) });

if (iface) {
  const chunks = (list) => Array.from({ length: Math.ceil(list.length / 100) }, (_, i) => list.slice(i * 100, i * 100 + 100));
  writeJson(`${out}/safe-register.json`, safeBatch(cfg, `Truth Pays: register ${newStakers.length} stakers`,
    chunks(newStakers.map((v) => v.wallet)).map((ch) => ({ to: kickbackAddr, data: iface.encodeFunctionData("registerStakers", [ch]) }))));
  writeJson(`${out}/safe-refunds.json`, safeBatch(cfg, `Truth Pays: refund ${refunds.length} declined guests`,
    chunks(refunds.map((v) => v.wallet)).map((ch) => ({ to: kickbackAddr, data: iface.encodeFunctionData("rejectAndRefund", [ch]) }))));
}

if (unmatched) {
  writeCsv(`${out}/unmatched.csv`, unmatched, ["status", "from", "amount", "to_return", "block", "tx", "explorer", "note"]);
  const open = unmatched.filter((u) => u.status === "open");
  const total = incoming.reduce((s, t) => s + t.amount, 0n);
  console.log(`Deposit address received ${incoming.length} deposits (${usdc(total)}); ${open.length} not claimed by any guest and not yet refunded` +
    `${open.length ? ` (${usdc(open.reduce((s, u) => s + u.units, 0n))})` : ""} → ${out}/unmatched.csv`);
}

for (const u of unbacked)
  console.warn(`⚠️  ${u.wallet} was registered (tx ${u.tx}) while none of its own deposits was left in the contract: its spot is backed by someone else's money. Investigate before refunding anyone.`);
for (const u of unpaired)
  console.warn(`⚠️  ${usdc(u.left)} sent back to ${u.wallet} (tx ${u.tx}) matches no deposit seen from that wallet: either its deposit is ` +
    `older than the scanned range (check --scan-from-block / deployBlock), or that wallet got back more than it sent (someone else's money).`);

const byCode = issues.reduce((m, i) => ((m[i.code] = (m[i.code] ?? 0) + 1), m), {});
const live = verified.filter((v) => ["unregistered", "registered", "paid", "refunded, paid again"].includes(v.onchain));
console.log(`\n✅ Verified deposits:  ${verified.length}  (${live.length} still held: ${usdc(dep * BigInt(live.length))})`);
console.log(`🕒 Waiting for your decision on Luma: ${toReview.length}`);
console.log(`🆕 Approved, to register on-chain: ${newStakers.length}`);
console.log(`↩️  Declined, to refund: ${refunds.length}`);
console.log(`💸 To give back with "Return a stray transfer" (not covered by "Refund declined guests"): ${returns.length}` +
  `${returns.length ? ` (${usdc(returns.reduce((s, x) => s + x.units, 0n))})` : ""} → ${out}/returns.csv`);
for (const x of returns) console.log(`     ${x.to_return} USDC → ${x.wallet}  ${x.name || x.email}  (${x.code})`);
console.log(`⚠️  Needs review: ${issues.length}  ${JSON.stringify(byCode)}`);
console.log(`\nNext: approve or decline the guests in ${out}/to-review.csv on Luma, re-run this, then in the console`);
console.log(`      click "Register stakers" and "Refund declined guests" (or use ${out}/safe-*.json / owner.mjs),`);
console.log(`      and send back each amount in ${out}/returns.csv with "Return a stray transfer" (then re-run this).`);
