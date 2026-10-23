#!/usr/bin/env node
// Step 2 (after the event).
//
//   node scripts/build-payout.mjs --checkins luma-guests-after-event.csv
//        [--verified out/verified.csv] [--extra-checkins manual.csv] [--config config.json] [--out out]
//
// Matches Luma check-ins against verified stakers and writes:
//   out/attendees.json        staker wallets who checked in
//   out/payout-plan.json      attendees + the share per person → "Pay attendees" = finalize(attendees, share)
//   out/payout.csv            per-wallet payout
//   out/payout-summary.md     numbers to share publicly
//   out/safe-finalize.json    Safe Transaction Builder batch for finalize()
//
// --extra-checkins: optional CSV with an `email` and/or `wallet` column for anyone the door
// team checked in by hand (paper list, Luma app offline, etc.).
import fs from "node:fs";
import { ethers } from "ethers";
import {
  args, loadConfig, provider, readCsv, writeCsv, writeJson, detectColumns, normAddress,
  safeBatch, loadAbi, fmt, STATUS,
} from "./lib.mjs";

const a = args();
if (!a.checkins) {
  console.error("Usage: node scripts/build-payout.mjs --checkins <luma-export.csv> [--verified out/verified.csv] [--extra-checkins manual.csv] [--allow-missing]");
  process.exit(1);
}
const cfg = loadConfig(a.config ?? "config.json");
const out = a.out ?? "out";
const verified = readCsv(a.verified ?? `${out}/verified.csv`);

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
  const { abi } = loadAbi("GroundTruthKickback");
  const c = new ethers.Contract(contractAddr, abi, provider(cfg));
  const all = await c.stakers();
  const st = await Promise.all(all.map((w) => c.status(w)));
  onchain = [...new Set(all.filter((_, i) => Number(st[i]) === STATUS.Staker).map((w) => ethers.getAddress(w)))];
  const count = await c.stakerCount();
  if (BigInt(onchain.length) !== count) throw new Error(`On-chain staker list (${onchain.length}) and stakerCount (${count}) disagree; stop and investigate`);
  const missing = stakerWallets.filter((w) => !onchain.includes(w));
  if (missing.length) console.warn(`⚠️  ${missing.length} verified wallets are NOT registered on-chain and can't be paid: ${missing.join(", ")}`);
  stakerWallets = onchain;
}

const byWallet = new Map(verified.map((v) => [ethers.getAddress(v.wallet), v]));
const unknown = stakerWallets.filter((w) => !byWallet.has(w));
if (unknown.length) {
  const msg = `${unknown.length} registered stakers have no row in verified.csv, so their check-in cannot be matched: ${unknown.join(", ")}`;
  if (!a["allow-missing"]) throw new Error(`${msg}. Re-run verify-deposits with the latest export, or pass --allow-missing to treat them as no-shows.`);
  console.warn(`⚠️  ${msg} (treated as no-shows because of --allow-missing)`);
}
const attendees = [];
const noShows = [];
for (const w of stakerWallets) {
  const v = byWallet.get(w);
  const showed = checkedWallets.has(w) || (v && checkedEmails.has((v.email ?? "").toLowerCase()));
  (showed ? attendees : noShows).push({ wallet: w, name: v?.name ?? "", email: v?.email ?? "" });
}

const n = BigInt(stakerWallets.length);
const pool = cfg.depositUnits * n;
const share = attendees.length ? pool / BigInt(attendees.length) : 0n;
const dust = pool - share * BigInt(attendees.length);

if (!attendees.length) console.warn("⚠️  Nobody on the staker list checked in. Do not pay out; check the export first.");
writeJson(`${out}/attendees.json`, attendees.map((x) => x.wallet));
if (extraRows.length) {
  const staff = new Set(attendees.flatMap((x) => [x.email.toLowerCase(), x.wallet]));
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

const summary = `# Ground Truth: deposit settlement

| | |
|---|---|
| Stakers | ${stakerWallets.length} |
| Showed up | ${attendees.length} |
| No-shows | ${noShows.length} |
| Pool | ${fmt(pool, cfg.decimals)} USDC |
| Payout per attendee | ${fmt(share, cfg.decimals)} USDC (deposit ${cfg.deposit} + ${fmt(share - cfg.depositUnits, cfg.decimals)} bonus) |
| Rounding dust | ${fmt(dust, cfg.decimals)} USDC |
${contractAddr ? `| Contract | ${cfg.explorer}/address/${contractAddr} |\n` : ""}`;
fs.writeFileSync(`${out}/payout-summary.md`, summary);
console.log(summary);

if (contractAddr && attendees.length) {
  const { abi } = loadAbi("GroundTruthKickback");
  const iface = new ethers.Interface(abi);
  writeJson(`${out}/safe-finalize.json`, safeBatch(cfg, `Ground Truth: pay ${attendees.length} attendees`, [
    { to: contractAddr, data: iface.encodeFunctionData("finalize", [attendees.map((x) => x.wallet), share]) },
  ]));
  console.log(`Next: click "Pay attendees" in the console (reads ${out}/payout-plan.json), or upload ${out}/safe-finalize.json in Safe`);
} else if (attendees.length) {
  // No contract: deposits sit in a Safe. Pay out with one batched Safe tx of USDC transfers.
  const erc20 = new ethers.Interface(["function transfer(address,uint256)"]);
  writeJson(`${out}/safe-payout-transfers.json`, safeBatch(cfg, `Ground Truth: pay ${attendees.length} attendees`,
    attendees.map((x) => ({ to: cfg.token, data: erc20.encodeFunctionData("transfer", [x.wallet, share]) }))));
  console.log(`No contract configured → upload ${out}/safe-payout-transfers.json in Safe Transaction Builder (from the deposit Safe).`);
}
