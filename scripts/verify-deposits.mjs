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
//   out/safe-register.json    Safe Transaction Builder batch for registerStakers()
//   out/safe-refunds.json     Safe Transaction Builder batch for rejectAndRefund()
//   out/unmatched.csv         (with --scan-from-block) deposits received that no guest claimed
import { ethers } from "ethers";
import {
  args, loadConfig, provider, readCsv, writeCsv, writeJson, verifyRegistrations,
  incomingTransfers, safeBatch, loadAbi, fmt, lumaDecision,
} from "./lib.mjs";

const a = args();
if (!a.guests) {
  console.error("Usage: node scripts/verify-deposits.mjs --guests <luma-export.csv> [--config config.json] [--out out] [--scan-from-block N]");
  process.exit(1);
}
const cfg = loadConfig(a.config ?? "config.json");
const out = a.out ?? "out";
const prov = provider(cfg);

const rows = readCsv(a.guests);
console.log(`Loaded ${rows.length} registrations from ${a.guests}`);

const { verified: verifiedAll, issues, columns } = await verifyRegistrations(prov, cfg, rows);

// Several Luma rows claiming the same tx or wallet (a copied tx link, a second sign-up, an
// approve and a decline for the same wallet): keep all of them out of the lists until a human decides.
// (A copied tx under a *different* stated wallet can't take anyone's place: that wallet didn't send it.)
const lc = (x) => String(x ?? "").toLowerCase();
const dupRows = issues.filter((i) => i.code === "DUPLICATE_TX" || i.code === "DUPLICATE_WALLET");
const conflicts = (v) => dupRows.some((d) =>
  (d.code === "DUPLICATE_WALLET" && lc(d.wallet) === lc(v.wallet)) ||
  (d.code === "DUPLICATE_TX" && lc(d.tx) === lc(v.tx) && (!d.wallet || lc(d.wallet) === lc(v.wallet))));
const verified = [];
for (const v of verifiedAll) {
  if (conflicts(v))
    issues.push({ ...v, code: "DUPLICATE_CLAIM", note: "Another Luma registration claims the same deposit tx or wallet. Decide by hand which one is real." });
  else verified.push(v);
}
console.log(`Columns used: ${JSON.stringify(columns)}`);
if (!columns.approval) console.warn("⚠️  No approval_status column: every verified payer is treated as pending.");

// On-chain status of every verified wallet (receiver may be the contract or a Safe/EOA)
const code = await prov.getCode(cfg.receiver);
const kickbackAddr = cfg.contract ? ethers.getAddress(cfg.contract) : code !== "0x" ? cfg.receiver : null;
let c = null;
let iface = null;
let snapshotBlock = await prov.getBlockNumber();
if (kickbackAddr) {
  const { abi } = loadAbi("GroundTruthKickback");
  c = new ethers.Contract(kickbackAddr, abi, prov);
  iface = new ethers.Interface(abi);
}
for (const v of verified) {
  v.decision = lumaDecision(v.approval);
  v.onchain = "unregistered";
  if (c) {
    try {
      v.onchain = ["unregistered", "registered", "paid", "refunded"][Number(await c.status(v.wallet, { blockTag: snapshotBlock }))];
      if (v.onchain === "refunded") {
        // a new deposit sent after their last refund lets them be registered again
        try {
          const ev = await c.queryFilter(c.filters.Rejected(v.wallet), cfg.deployBlock ?? 0, snapshotBlock);
          const lastRefund = Math.max(...ev.map((e) => e.blockNumber));
          if (ev.length && Number(v.block) > lastRefund) v.onchain = "refunded, paid again";
        } catch (e) {
          console.warn(`Could not read refund history of ${v.wallet} (${e.shortMessage || e.message}); treating as refunded`);
        }
      }
    } catch (e) {
      console.warn(`Could not read status of ${v.wallet}: ${e.shortMessage || e.message}`);
      v.onchain = "unknown";
    }
  }
}

const newStakers = [];
const refunds = [];
const toReview = [];
for (const v of verified) {
  if (v.decision === "approved") {
    if (v.onchain === "unregistered" || v.onchain === "refunded, paid again") newStakers.push(v);
    else if (v.onchain === "refunded")
      issues.push({ ...v, code: "REFUNDED_EARLIER", note: "Approved now, but this deposit was already refunded. They must send a new deposit before they can be registered." });
  } else if (v.decision === "declined") {
    // still holding their money (unregistered) or registered then dropped: refund it
    if (v.onchain === "unregistered" || v.onchain === "registered") refunds.push(v);
    else if (v.onchain === "refunded, paid again")
      issues.push({ ...v, code: "PAID_AGAIN_DECLINED", note: "Declined, refunded once already, and then paid again. Return the new deposit with 'Return a stray transfer'." });
  } else if (v.onchain === "unregistered" || v.onchain === "refunded, paid again") toReview.push(v);
  else if (v.onchain === "registered")
    issues.push({ ...v, code: "REGISTERED_NOT_APPROVED", note: "Registered on-chain but no longer approved on Luma. Approve again, or decline to refund." });
}

const vCols = ["name", "email", "ticket", "approval", "onchain", "wallet", "amount", "sent_at", "tx", "explorer", "note"];
writeCsv(`${out}/verified.csv`, verified, vCols);
writeCsv(`${out}/issues.csv`, issues, ["code", ...vCols]);
writeCsv(`${out}/to-review.csv`, toReview, vCols);
// The console checks contract, network and each wallet's on-chain status before sending, so an
// out-of-date list is refused instead of acting on a guest whose situation has changed.
const stamp = { contract: kickbackAddr, chainId: Number(cfg.chainId), block: snapshotBlock, generatedAt: new Date().toISOString() };
const STATUS_OF = { unregistered: 0, registered: 1, "refunded, paid again": 3 };
const item = (v) => ({ wallet: v.wallet, name: v.name, email: v.email, onchain: v.onchain, status: STATUS_OF[v.onchain] });
writeJson(`${out}/new-stakers.json`, { ...stamp, items: newStakers.map(item) });
writeJson(`${out}/refunds.json`, { ...stamp, items: refunds.map(item) });

if (iface) {
  const chunks = (list) => Array.from({ length: Math.ceil(list.length / 100) }, (_, i) => list.slice(i * 100, i * 100 + 100));
  writeJson(`${out}/safe-register.json`, safeBatch(cfg, `Ground Truth: register ${newStakers.length} stakers`,
    chunks(newStakers.map((v) => v.wallet)).map((ch) => ({ to: kickbackAddr, data: iface.encodeFunctionData("registerStakers", [ch]) }))));
  writeJson(`${out}/safe-refunds.json`, safeBatch(cfg, `Ground Truth: refund ${refunds.length} declined guests`,
    chunks(refunds.map((v) => v.wallet)).map((ch) => ({ to: kickbackAddr, data: iface.encodeFunctionData("rejectAndRefund", [ch]) }))));
}

// Cross-check: every deposit that landed vs. what guests claimed.
const scanFrom = a["scan-from-block"] ?? cfg.deployBlock;
if (scanFrom === undefined && cfg.contract) console.warn('⚠️  No "deployBlock" in the config: deposits nobody claimed on Luma are NOT being checked.');
if (scanFrom !== undefined) {
  const incoming = await incomingTransfers(prov, cfg, scanFrom);
  const claimed = new Set([...verified, ...issues].map((r) => String(r.tx).toLowerCase()));
  const unmatched = incoming.filter((t) => !claimed.has(t.tx)).map((t) => ({ ...t, status: "open" }));

  // A deposit nobody claims may simply have been refunded already (e.g. a declined guest who later
  // pasted a new tx link). Pair each sender's deposits with later refunds from the contract, oldest
  // first, so refunded money is never offered as a "stray transfer" to return a second time.
  if (c && unmatched.length) {
    const refundsBy = new Map();
    const add = (to, block, tx) => {
      const k = lc(to);
      if (!refundsBy.has(k)) refundsBy.set(k, []);
      refundsBy.get(k).push({ block, tx, used: false });
    };
    for (const e of await c.queryFilter(c.filters.Rejected(), Number(scanFrom))) add(e.args[0], e.blockNumber, e.transactionHash);
    for (const e of await c.queryFilter(c.filters.Refunded(), Number(scanFrom))) add(e.args[0], e.blockNumber, e.transactionHash);
    const refundedClaimed = [...verified, ...issues]
      .filter((r) => r.onchain === "refunded" && r.block)
      .map((r) => ({ from: r.wallet, block: Number(r.block), row: null }));
    const deposits = [...refundedClaimed, ...unmatched.map((u) => ({ from: u.from, block: Number(u.block), row: u }))]
      .sort((x, y) => x.block - y.block);
    for (const d of deposits) {
      const r = (refundsBy.get(lc(d.from)) ?? []).sort((x, y) => x.block - y.block).find((x) => !x.used && x.block >= d.block);
      if (!r) continue;
      r.used = true;
      if (d.row) d.row.status = `already refunded (${r.tx})`;
    }
  }
  const open = unmatched.filter((u) => u.status === "open");
  writeCsv(`${out}/unmatched.csv`,
    unmatched.map((t) => ({ ...t, amount: fmt(t.amount, cfg.decimals), explorer: `${cfg.explorer}/tx/${t.tx}` })),
    ["status", "from", "amount", "block", "tx", "explorer"]);
  const total = incoming.reduce((s, t) => s + t.amount, 0n);
  console.log(`Deposit address received ${incoming.length} transfers (${fmt(total, cfg.decimals)} USDC); ${open.length} not claimed by any guest and not yet refunded → ${out}/unmatched.csv`);
}

const byCode = issues.reduce((m, i) => ((m[i.code] = (m[i.code] ?? 0) + 1), m), {});
console.log(`\n✅ Verified deposits:  ${verified.length}  (${fmt(cfg.depositUnits * BigInt(verified.length), cfg.decimals)} USDC)`);
console.log(`🕒 Waiting for your decision on Luma: ${toReview.length}`);
console.log(`🆕 Approved, to register on-chain: ${newStakers.length}`);
console.log(`↩️  Declined, to refund: ${refunds.length}`);
console.log(`⚠️  Needs review: ${issues.length}  ${JSON.stringify(byCode)}`);
console.log(`\nNext: approve or decline the guests in ${out}/to-review.csv on Luma, re-run this, then in the console`);
console.log(`      click "Register stakers" and "Refund declined guests" (or use ${out}/safe-*.json / owner.mjs).`);
