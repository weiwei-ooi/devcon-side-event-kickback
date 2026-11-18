#!/usr/bin/env node
// Step 1 (run any time during registration, as often as you like).
//
//   node scripts/verify-deposits.mjs --guests luma-guests.csv [--config config.json]
//        [--out out] [--scan-from-block 123456]
//
// Reads the Luma guest export, checks every pasted deposit tx on-chain (the deposit contract's own
// Deposited events: ETH sent with a plain transfer or with deposit()), and sorts the verified payers
// by the organiser's decision in Luma (approval_status):
//   out/verified.csv          every guest whose deposit checks out (with their Luma decision)
//   out/issues.csv            anything that needs a human look (wrong amount, wrong network…)
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
// Amounts in the CSV files are exact ETH amounts (what to type in the console).
// The checks themselves are core.mjs checkGuests (the admin panel runs the same code); this script
// reads the config and the export and writes the files.
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  args, loadConfig, provider, readCsv, writeCsv, writeJson, safeBatch, loadAbi, fmt, fmtEth, checkContract, checkGuests, CHECK_COLUMNS,
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
const scanFrom = a["scan-from-block"] !== undefined ? Number(a["scan-from-block"]) : cfg.deployBlock;
if (scanFrom === undefined && cfg.mode) {
  // live or rehearsal: a real network, where scanning from block 0 is not an option
  console.error(`No "deployBlock" in ${configFile} and no --scan-from-block. Without the deploy block, refunds already sent and ` +
    `deposits nobody claimed can't be checked, so nothing is listed (${cfg.mode} mode). Set "deployBlock" in ${configFile} ` +
    `or pass --scan-from-block <deploy block>.`);
  process.exit(1);
}

const prov = provider(cfg);
const { abi } = loadAbi("TruthPaysKickback");
const kickbackAddr = cfg.receiver;

// The deposit contract. Deposits are its own Deposited events, so without it there is nothing to check.
// The deposit is fixed in the contract when it is deployed, and every check uses the config's
// "deposit": they must be the same, or payers of the wrong amount would be listed for registration.
let contract;
try {
  ({ contract } = await checkContract(prov, cfg, abi));
} catch (e) {
  if (e.code === "NO_KICKBACK_CONTRACT")
    console.error(`No deposit contract at ${kickbackAddr} on ${cfg.chainName}. Set "contract" (and "receiver") in ${configFile} ` +
      `to the deployed contract, and check that "rpcUrl" is on the right network.`);
  else if (e.code === "DEPOSIT_MISMATCH")
    console.error(`${configFile} says the deposit is ${cfg.deposit} ETH, but the contract at ${kickbackAddr} was deployed with ` +
      `${fmt(e.depositAmount)} ETH. Nothing was listed. Set "deposit" in ${configFile} to the contract's amount (or redeploy).`);
  else throw e;
  process.exit(1);
}

const rows = readCsv(a.guests);
console.log(`Loaded ${rows.length} registrations from ${a.guests}`);

// every check, pairing and list (and the warnings printed on the way)
const r = await checkGuests({ prov, cfg, abi, rows, scanFrom, contract, log: { info: console.log, warn: console.warn } });
const { verified, issues, toReview, returns, newStakers, refunds } = r;
const dep = cfg.depositUnits;
const eth = (x) => fmtEth(x);

// ---------------------------------------------------------------- write everything
writeCsv(`${out}/verified.csv`, verified, CHECK_COLUMNS.verified);
writeCsv(`${out}/issues.csv`, issues, CHECK_COLUMNS.issues);
writeCsv(`${out}/to-review.csv`, toReview, CHECK_COLUMNS.toReview);
writeCsv(`${out}/returns.csv`, returns, CHECK_COLUMNS.returns);
// every row whose tx verified as its wallet's deposit, duplicates included: a check-in through any
// of them counts for that wallet (payouts only ever go to the registered wallet itself)
writeCsv(`${out}/claims.csv`, r.claims, CHECK_COLUMNS.claims);
// The console checks contract, network, deposit amount (in wei) and each wallet's on-chain status before
// sending, so an out-of-date list is refused instead of acting on a guest whose situation has changed.
writeJson(`${out}/new-stakers.json`, r.lists.newStakers);
writeJson(`${out}/refunds.json`, r.lists.refunds);

const iface = new ethers.Interface(abi);
const chunks = (list) => Array.from({ length: Math.ceil(list.length / 100) }, (_, i) => list.slice(i * 100, i * 100 + 100));
writeJson(`${out}/safe-register.json`, safeBatch(cfg, `Truth Pays: register ${newStakers.length} stakers`,
  chunks(newStakers.map((v) => v.wallet)).map((ch) => ({ to: kickbackAddr, data: iface.encodeFunctionData("registerStakers", [ch]) }))));
writeJson(`${out}/safe-refunds.json`, safeBatch(cfg, `Truth Pays: refund ${refunds.length} declined guests`,
  chunks(refunds.map((v) => v.wallet)).map((ch) => ({ to: kickbackAddr, data: iface.encodeFunctionData("rejectAndRefund", [ch]) }))));

writeCsv(`${out}/unmatched.csv`, r.unmatched, CHECK_COLUMNS.unmatched);
const open = r.openUnmatched;
console.log(`Deposit contract received ${r.incoming.length} deposits (${eth(r.totalIncoming)}); ${open.length} not claimed by any guest and not yet refunded` +
  `${open.length ? ` (${eth(open.reduce((s, u) => s + u.units, 0n))})` : ""} → ${out}/unmatched.csv`);

console.log(`\n✅ Verified deposits:  ${verified.length}  (${r.held.length} still held: ${eth(dep * BigInt(r.held.length))})`);
console.log(`🕒 Waiting for your decision on Luma: ${toReview.length}`);
console.log(`🆕 Approved, to register on-chain: ${newStakers.length}`);
console.log(`↩️  Declined, to refund: ${refunds.length}`);
console.log(`💸 To give back with "Return a stray transfer" (not covered by "Refund declined guests"): ${returns.length}` +
  `${returns.length ? ` (${eth(returns.reduce((s, x) => s + x.units, 0n))})` : ""} → ${out}/returns.csv`);
for (const x of returns) console.log(`     ${x.to_return} ETH → ${x.wallet}  ${x.name || x.email}  (${x.code})`);
console.log(`⚠️  Needs review: ${issues.length}  ${JSON.stringify(r.issueCounts)}`);
console.log(`\nNext: approve or decline the guests in ${out}/to-review.csv on Luma, re-run this, then in the console`);
console.log(`      click "Register stakers" and "Refund declined guests" (or use ${out}/safe-*.json / owner.mjs),`);
console.log(`      and send back each amount in ${out}/returns.csv with "Return a stray transfer" (then re-run this).`);
