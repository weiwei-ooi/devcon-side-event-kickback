#!/usr/bin/env node
// Step 2 (after the event).
//
//   node scripts/build-payout.mjs --checkins luma-guests-after-event.csv
//        [--verified out/verified.csv] [--claims out/claims.csv] [--extra-checkins manual.csv]
//        [--config config.json] [--out out]
//
// Matches Luma check-ins against the registered stakers and writes:
//   out/attendees.json        staker wallets who checked in
//   out/payout-plan.json      attendees + the share per person → "Post attendance list" = postAttendance(attendees, share)
//   out/payout.csv            per-wallet payout
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
  safeBatch, loadAbi, fmt, STATUS, lumaDecision, uncell,
} from "./lib.mjs";

const a = args();
if (!a.checkins) {
  console.error("Usage: node scripts/build-payout.mjs --checkins <luma-export.csv> [--verified out/verified.csv] [--claims out/claims.csv] [--extra-checkins manual.csv] [--allow-missing]");
  process.exit(1);
}
const cfg = loadConfig(a.config ?? "config.json");
const out = a.out ?? "out";
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

// Stakers = on-chain registry if a contract is configured (source of truth), else verified.csv
const contractAddr = cfg.contract ? ethers.getAddress(cfg.contract) : null;
let stakerWallets = verified.map((v) => ethers.getAddress(v.wallet));
let onchain = null;
if (contractAddr) {
  const { abi } = loadAbi("TruthPaysKickback");
  const c = new ethers.Contract(contractAddr, abi, provider(cfg));
  const all = await c.stakers();
  const st = await Promise.all(all.map((w) => c.status(w)));
  onchain = [...new Set(all.filter((_, i) => Number(st[i]) === STATUS.Staker).map((w) => ethers.getAddress(w)))];
  const count = await c.stakerCount();
  if (BigInt(onchain.length) !== count) throw new Error(`On-chain staker list (${onchain.length}) and stakerCount (${count}) disagree; stop and investigate`);
  const approved = verified.filter((v) => lumaDecision(v.approval) === "approved").map((v) => ethers.getAddress(v.wallet));
  const missing = [...new Set(approved)].filter((w) => !onchain.includes(w));
  if (missing.length) console.warn(`⚠️  ${missing.length} approved wallets with a verified deposit are NOT registered on-chain and can't be paid: ${missing.join(", ")}`);
  stakerWallets = onchain;
}

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
const pool = cfg.depositUnits * n;
const share = attendees.length ? pool / BigInt(attendees.length) : 0n;
const dust = pool - share * BigInt(attendees.length);

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
  share: share.toString(),
  shareUsdc: fmt(share, cfg.decimals),
});
writeCsv(
  `${out}/payout.csv`,
  [...attendees.map((x) => ({ ...x, attended: "yes", payout: fmt(share, cfg.decimals) })),
   ...noShows.map((x) => ({ ...x, attended: "no", payout: "0" }))],
  ["name", "email", "wallet", "attended", "payout"]
);

const summary = `# Truth Pays: deposit settlement

| | |
|---|---|
| Stakers | ${stakerWallets.length} |
| Showed up | ${attendees.length} |
| No-shows | ${noShows.length} |
| Pool | ${fmt(pool, cfg.decimals)} USDC |
| Payout per attendee (if nobody is added by a challenge) | ${fmt(share, cfg.decimals)} USDC (deposit ${cfg.deposit} + ${fmt(share - cfg.depositUnits, cfg.decimals)} bonus) |
| Rounding dust | ${fmt(dust, cfg.decimals)} USDC |
${contractAddr ? `| Contract | ${cfg.explorer}/address/${contractAddr} |\n` : ""}`;
fs.writeFileSync(`${out}/payout-summary.md`, summary);
console.log(summary);

if (contractAddr && attendees.length) {
  const { abi } = loadAbi("TruthPaysKickback");
  const iface = new ethers.Interface(abi);
  writeJson(`${out}/safe-post-attendance.json`, safeBatch(cfg, `Truth Pays: post ${attendees.length} attendees`, [
    { to: contractAddr, data: iface.encodeFunctionData("postAttendance", [attendees.map((x) => x.wallet), share]) },
  ]));
  console.log(`Next: click "Post attendance list" in the console (reads ${out}/payout-plan.json), or upload ${out}/safe-post-attendance.json in Safe.`);
  console.log(`Then wait 1 day for challenges; click "Release payouts" once none is waiting for a match.`);
} else if (attendees.length) {
  // No contract: deposits sit in a Safe. Pay out with one batched Safe tx of USDC transfers.
  const erc20 = new ethers.Interface(["function transfer(address,uint256)"]);
  writeJson(`${out}/safe-payout-transfers.json`, safeBatch(cfg, `Truth Pays: pay ${attendees.length} attendees`,
    attendees.map((x) => ({ to: cfg.token, data: erc20.encodeFunctionData("transfer", [x.wallet, share]) }))));
  console.log(`No contract configured → upload ${out}/safe-payout-transfers.json in Safe Transaction Builder (from the deposit Safe).`);
}
