#!/usr/bin/env node
// Owner actions from the command line, for developers (the organiser uses the owner console).
// If the owner is a Safe, use the out/safe-*.json files in Safe Transaction Builder instead.
//
//   node scripts/owner.mjs status                        (read-only, no key needed)
//   PRIVATE_KEY=0x… node scripts/owner.mjs register        [--file out/new-stakers.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs refund-declined [--file out/refunds.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs refund --to 0x… --amount 5      (spare money only)
//   PRIVATE_KEY=0x… node scripts/owner.mjs finalize        [--file out/payout-plan.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs cancel
//   PRIVATE_KEY=0x… node scripts/owner.mjs sweep --to 0x…
import fs from "node:fs";
import { ethers } from "ethers";
import { args, loadConfig, provider, loadAbi, fmt, PHASES } from "./lib.mjs";

const a = args();
const cmd = a._[0];
const cfg = loadConfig(a.config ?? "config.json");
if (!cfg.contract) throw new Error('Set "contract" in config.json');
const prov = provider(cfg);
const signer = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, prov) : null;
const { abi } = loadAbi("GroundTruthKickback");
const c = new ethers.Contract(cfg.contract, abi, signer ?? prov);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// verify-deposits writes { contract, chainId, items: [{ wallet, … }] }; plain arrays also work
function walletsOf(file) {
  const d = readJson(file);
  if (!Array.isArray(d) && d.contract && d.contract.toLowerCase() !== cfg.contract.toLowerCase())
    throw new Error(`${file} was made for contract ${d.contract}, not ${cfg.contract}`);
  return (Array.isArray(d) ? d : d.items).map((r) => (typeof r === "string" ? r : r.wallet));
}

async function send(fn, ...params) {
  if (!signer) throw new Error("Set PRIVATE_KEY of the owner wallet");
  await c[fn].staticCall(...params); // surfaces the contract's reason before paying gas
  const tx = await c[fn](...params);
  console.log(`${fn} → ${cfg.explorer}/tx/${tx.hash}`);
  await tx.wait();
  console.log("✅ confirmed");
}

const BATCH = 100;
switch (cmd) {
  case "status": {
    const [count, phase, owner, spare, owedTotal, start, end] = await Promise.all([
      c.stakerCount(), c.phase(), c.owner(), c.spare(), c.owedTotal(), c.eventStart(), c.claimDeadline(),
    ]);
    const token = new ethers.Contract(cfg.token, ["function balanceOf(address) view returns (uint256)"], prov);
    const bal = await token.balanceOf(cfg.contract);
    console.log({
      owner, phase: PHASES[Number(phase)], stakers: Number(count),
      pool: fmt(cfg.depositUnits * count, cfg.decimals), balance: fmt(bal, cfg.decimals),
      unclaimedPayouts: fmt(owedTotal, cfg.decimals), spare: fmt(spare, cfg.decimals),
      payoutFrom: new Date(Number(start) * 1000).toISOString(), settleBy: new Date(Number(end) * 1000).toISOString(),
    });
    break;
  }
  case "register": {
    const list = walletsOf(a.file ?? "out/new-stakers.json");
    for (let i = 0; i < list.length; i += BATCH) await send("registerStakers", list.slice(i, i + BATCH));
    break;
  }
  case "refund-declined": {
    const list = walletsOf(a.file ?? "out/refunds.json");
    for (let i = 0; i < list.length; i += BATCH) await send("rejectAndRefund", list.slice(i, i + BATCH));
    break;
  }
  case "finalize": {
    const plan = readJson(a.file ?? "out/payout-plan.json");
    if (!plan.contract || plan.contract.toLowerCase() !== cfg.contract.toLowerCase()) throw new Error("payout-plan.json is for a different contract");
    const share = await c.previewShare(plan.attendees.length);
    if (share.toString() !== plan.share) throw new Error(`Share on-chain is ${fmt(share, cfg.decimals)}, plan says ${plan.shareUsdc}. Rebuild the payout.`);
    console.log(`Paying ${plan.attendees.length} attendees ${fmt(share, cfg.decimals)} USDC each`);
    await send("finalize", plan.attendees, share);
    break;
  }
  case "refund":
    await send("refund", ethers.getAddress(a.to), ethers.parseUnits(String(a.amount), cfg.decimals));
    break;
  case "cancel":
    await send("cancel");
    break;
  case "sweep":
    await send("sweep", ethers.getAddress(a.to));
    break;
  default:
    console.log("Commands: status | register | refund-declined | refund --to --amount | finalize | cancel | sweep --to");
}
