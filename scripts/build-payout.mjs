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
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import {
  args, loadConfig, provider, readCsv, writeCsv, writeJson, detectColumns, normAddress,
  safeBatch, loadAbi, fmt, fmtEth, STATUS, lumaDecision, uncell,
} from "./lib.mjs";

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

// Who checked in?
const rows = readCsv(a.checkins);
const col = detectColumns(Object.keys(rows[0] ?? {}), cfg.columns);
if (!col.checkedIn) throw new Error("No checked_in_at column found in the Luma export");
if (!col.email) throw new Error("No email column found in the Luma export");
// A Luma check-in counts only through the guest's own registration (their email), never through
// a wallet typed into somebody else's row.
const checkedEmails = new Set();
const checkedWallets = new Set(); // only from the organiser's own door list
for (const r of rows) {
  if (!(r[col.checkedIn] ?? "").trim()) continue;
  if (r[col.email]) checkedEmails.add(r[col.email].toLowerCase().trim());
}
let extraRows = [];
if (a["extra-checkins"]) {
  extraRows = readCsv(a["extra-checkins"]);
  const xc = detectColumns(Object.keys(extraRows[0] ?? {}), {});
  if (!xc.email && !xc.wallet) throw new Error(`${a["extra-checkins"]}: needs an "email" or "wallet" column`);
  extraRows = extraRows.map((r) => ({ email: (r[xc.email] ?? "").toLowerCase().trim(), wallet: xc.wallet ? normAddress(r[xc.wallet]) : null }));
  for (const r of extraRows) {
    if (r.email) checkedEmails.add(r.email);
    if (r.wallet) checkedWallets.add(r.wallet);
  }
}

// Stakers and the deposit come from the contract (the source of truth)
const contractAddr = ethers.getAddress(cfg.contract);
const { abi } = loadAbi("TruthPaysKickback");
const c = new ethers.Contract(contractAddr, abi, provider(cfg));
const all = await c.stakers();
const st = await Promise.all(all.map((w) => c.status(w)));
const stakerWallets = [...new Set(all.filter((_, i) => Number(st[i]) === STATUS.Staker).map((w) => ethers.getAddress(w)))];
const count = await c.stakerCount();
if (BigInt(stakerWallets.length) !== count) throw new Error(`On-chain staker list (${stakerWallets.length}) and stakerCount (${count}) disagree; stop and investigate`);
const deposit = await c.depositAmount();
if (deposit !== cfg.depositUnits)
  console.warn(`⚠️  The contract's deposit is ${fmt(deposit)} ETH but the config says ${cfg.deposit} ETH: using the contract's amount. Fix "deposit" in the config.`);
const approved = verified.filter((v) => lumaDecision(v.approval) === "approved").map((v) => ethers.getAddress(v.wallet));
const missing = [...new Set(approved)].filter((w) => !stakerWallets.includes(w));
if (missing.length) console.warn(`⚠️  ${missing.length} approved wallets with a verified deposit are NOT registered on-chain and can't be paid: ${missing.join(", ")}`);

// wallet → its name and email (verified.csv first) and every email whose registration verified it
const byWallet = new Map();
for (const v of [...verified, ...claims]) {
  const w = normAddress(v.wallet);
  if (!w) continue;
  const email = uncell(v.email).toLowerCase().trim();
  const e = byWallet.get(w) ?? { name: uncell(v.name), email, emails: new Set() };
  if (email) e.emails.add(email);
  byWallet.set(w, e);
}
const unknown = stakerWallets.filter((w) => !byWallet.has(w));
if (unknown.length) {
  const msg = `${unknown.length} registered stakers have no Luma registration that verified their wallet, so their check-in cannot be matched: ${unknown.join(", ")}`;
  if (!a["allow-missing"])
    throw new Error(`${msg}.\nRe-run verify-deposits with the latest Luma export first. If someone is still missing, check by hand whether they came ` +
      `and put those who did on a door list (--extra-checkins, with their wallet). --allow-missing would count every one of them as a no-show ` +
      `(they would lose their deposit): only use it after checking each of them by hand.`);
  console.warn(`⚠️  ${msg}. Counted as no-shows because of --allow-missing (only after checking each one by hand).`);
}
const attendees = [];
const noShows = [];
for (const w of stakerWallets) {
  const v = byWallet.get(w);
  const showed = checkedWallets.has(w) || (!!v && [...v.emails].some((e) => checkedEmails.has(e)));
  (showed ? attendees : noShows).push({ wallet: w, name: v?.name ?? "", email: v?.email ?? "", emails: v?.emails ?? new Set() });
}

const n = BigInt(stakerWallets.length);
const pool = deposit * n;
const share = attendees.length ? pool / BigInt(attendees.length) : 0n;
const dust = pool - share * BigInt(attendees.length);
if (attendees.length && (await c.previewShare(attendees.length)) !== share)
  throw new Error("The contract computes a different share for this list; stop and investigate (is the config on the right contract?)");

if (!attendees.length) console.warn("⚠️  Nobody on the staker list checked in. Do not pay out; check the export first.");
writeJson(`${out}/attendees.json`, attendees.map((x) => x.wallet));
if (extraRows.length) {
  const staff = new Set(attendees.flatMap((x) => [...x.emails, x.wallet]));
  const unmatchedExtra = extraRows.filter((r) => !staff.has(r.email) && !staff.has(r.wallet));
  console.log(`Door list: ${extraRows.length} rows, ${extraRows.length - unmatchedExtra.length} matched a staker`);
  for (const r of unmatchedExtra) console.log(`  no staker for door-list row: ${r.email || r.wallet}`);
}
writeJson(`${out}/payout-plan.json`, {
  contract: contractAddr,
  chainId: Number(cfg.chainId),
  stakers: stakerWallets.length,
  attendees: attendees.map((x) => x.wallet),
  share: share.toString(), // wei: what postAttendance must be given
  shareEth: fmt(share),
});
writeCsv(
  `${out}/payout.csv`,
  [...attendees.map((x) => ({ ...x, attended: "yes", payout: fmt(share) })),
   ...noShows.map((x) => ({ ...x, attended: "no", payout: "0" }))],
  ["name", "email", "wallet", "attended", "payout"]
);

const summary = `# Truth Pays: deposit settlement

| | |
|---|---|
| Stakers | ${stakerWallets.length} |
| Showed up | ${attendees.length} |
| No-shows | ${noShows.length} |
| Pool | ${fmtEth(pool)} |
| Payout per attendee (if nobody is added by a challenge) | ${fmtEth(share)} (deposit ${fmtEth(deposit)} + ${fmtEth(share > deposit ? share - deposit : 0n)} bonus) |
| Rounding dust | ${fmt(dust)} ETH |
| Contract | ${cfg.explorer}/address/${contractAddr} |
`;
fs.writeFileSync(`${out}/payout-summary.md`, summary);
console.log(summary);

if (attendees.length) {
  const iface = new ethers.Interface(abi);
  writeJson(`${out}/safe-post-attendance.json`, safeBatch(cfg, `Truth Pays: post ${attendees.length} attendees`, [
    { to: contractAddr, data: iface.encodeFunctionData("postAttendance", [attendees.map((x) => x.wallet), share]) },
  ]));
  console.log(`Next: click "Post attendance list" in the console (reads ${out}/payout-plan.json), or upload ${out}/safe-post-attendance.json in Safe.`);
  console.log(`Then wait 1 day for challenges; click "Release payouts" once none is waiting for a match.`);
}
