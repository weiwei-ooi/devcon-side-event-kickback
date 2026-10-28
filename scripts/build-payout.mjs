#!/usr/bin/env node
// Step 2 (after the event).
//
//   node scripts/build-payout.mjs --checkins luma-guests-after-event.csv
//        [--verified out/verified.csv] [--claims out/claims.csv] [--extra-checkins manual.csv]
//        [--config config.json] [--out out]
//
// Matches Luma check-ins against the registered stakers (read from the contract) and writes:
//   out/attendees.json        staker wallets who checked in
//   out/payout-plan.json      attendees + the share per person in wei → "Post attendance list" = postAttendance(attendees, share)
//   out/payout.csv            per-wallet payout (exact ETH)
//   out/payout-summary.md     numbers to share publicly
//   out/safe-post-attendance.json  Safe Transaction Builder batch for postAttendance()
//
// Posting the list opens a 1-day challenge window (Kleros). Payouts are released afterwards
// with "Release payouts", once no challenge is waiting for a match (a share per open Kleros case is set aside).
//
// --extra-checkins: optional CSV with an `email` and/or `wallet` column for anyone the door
// team checked in by hand (paper list, Luma app offline, etc.).
//
// A staker's check-in is found through every Luma registration that verified their wallet's
// deposit (out/claims.csv from verify-deposits), so a second registration pasting the same tx
// (a copy, or the guest signing up twice) can never turn a guest who came into a no-show.
// The matching itself is core.mjs buildPayout (the admin panel runs the same code); this script
// reads the files and writes the results.
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { args, loadConfig, provider, readCsv, writeCsv, writeJson, safeBatch, loadAbi, buildPayout, PAYOUT_COLUMNS } from "./lib.mjs";

const a = args();
if (!a.checkins) {
  console.error("Usage: node scripts/build-payout.mjs --checkins <luma-export.csv> [--verified out/verified.csv] [--claims out/claims.csv] [--extra-checkins manual.csv] [--allow-missing]");
  process.exit(1);
}
const cfg = loadConfig(a.config ?? "config.json");
const out = a.out ?? "out";
// A run that stops half-way must never leave the previous plan behind for "Post attendance list".
// (safe-payout-transfers.json came from the old no-contract mode: removed if an old run left one.)
const OUTPUTS = ["attendees.json", "payout-plan.json", "payout.csv", "payout-summary.md",
  "safe-post-attendance.json", "safe-payout-transfers.json"];
for (const f of OUTPUTS) fs.rmSync(path.join(out, f), { force: true });
if (!cfg.contract) throw new Error('Set "contract" in the config: the stakers and the pool are read from the deployed contract.');
const verifiedFile = a.verified ?? `${out}/verified.csv`;
const verified = readCsv(verifiedFile);
// every registration that verified a wallet's deposit, including ones flagged as duplicates
const claimsFile = a.claims ?? path.join(path.dirname(verifiedFile), "claims.csv");
const claims = fs.existsSync(claimsFile) ? readCsv(claimsFile) : [];
if (!fs.existsSync(claimsFile)) console.warn(`⚠️  ${claimsFile} not found: matching check-ins through ${verifiedFile} only. Re-run verify-deposits to create it.`);

const { abi } = loadAbi("TruthPaysKickback");
const res = await buildPayout({
  prov: provider(cfg), cfg, abi, verified, claims,
  checkins: readCsv(a.checkins),
  extra: a["extra-checkins"] ? readCsv(a["extra-checkins"]) : undefined,
  extraName: a["extra-checkins"],
  log: { info: console.log, warn: console.warn },
});
if (res.unknown.length) {
  if (!a["allow-missing"])
    throw new Error(`${res.unknownNote}.\nRe-run verify-deposits with the latest Luma export first. If someone is still missing, check by hand whether they came ` +
      `and put those who did on a door list (--extra-checkins, with their wallet). --allow-missing would count every one of them as a no-show ` +
      `(they would lose their deposit): only use it after checking each of them by hand.`);
  console.warn(`⚠️  ${res.unknownNote}. Counted as no-shows because of --allow-missing (only after checking each one by hand).`);
}
const { attendees, plan, summaryMarkdown: summary } = res;

if (!attendees.length) console.warn("⚠️  Nobody on the staker list checked in. Do not pay out; check the export first.");
writeJson(`${out}/attendees.json`, attendees.map((x) => x.wallet));
if (res.door) {
  console.log(`Door list: ${res.door.rows} rows, ${res.door.rows - res.door.unmatched.length} matched a staker`);
  for (const r of res.door.unmatched) console.log(`  no staker for door-list row: ${r.email || r.wallet}`);
}
writeJson(`${out}/payout-plan.json`, plan);
writeCsv(`${out}/payout.csv`, res.payoutRows, PAYOUT_COLUMNS);
fs.writeFileSync(`${out}/payout-summary.md`, summary);
console.log(summary);

if (attendees.length) {
  const iface = new ethers.Interface(abi);
  writeJson(`${out}/safe-post-attendance.json`, safeBatch(cfg, `Truth Pays: post ${attendees.length} attendees`, [
    { to: res.contract, data: iface.encodeFunctionData("postAttendance", [plan.attendees, res.share]) },
  ]));
  console.log(`Next: click "Post attendance list" in the console (reads ${out}/payout-plan.json), or upload ${out}/safe-post-attendance.json in Safe.`);
  console.log(`Then wait 1 day for challenges; click "Release payouts" once none is waiting for a match.`);
}
