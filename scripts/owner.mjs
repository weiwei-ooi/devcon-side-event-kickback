#!/usr/bin/env node
// Owner actions from the command line, for developers (the organiser uses the owner console).
// If the owner is a Safe, use the out/safe-*.json files in Safe Transaction Builder instead.
//
//   node scripts/owner.mjs status                        (read-only, no key needed)
//   PRIVATE_KEY=0x… node scripts/owner.mjs register        [--file out/new-stakers.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs refund-declined [--file out/refunds.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs refund --to 0x… --amount 5      (spare money only)
//   PRIVATE_KEY=0x… node scripts/owner.mjs post-attendance [--file out/payout-plan.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs add-attendees --file wallets.json   (during the 1-day window)
//   PRIVATE_KEY=0x… node scripts/owner.mjs challenges                   (read-only list)
//   PRIVATE_KEY=0x… node scripts/owner.mjs resolve --staker 0x…          (anyone; after match window / ruling)
//   PRIVATE_KEY=0x… node scripts/owner.mjs release                      (anyone; after the window, none waiting for a match)
//   PRIVATE_KEY=0x… node scripts/owner.mjs cancel
//   PRIVATE_KEY=0x… node scripts/owner.mjs sweep --to 0x…
import fs from "node:fs";
import { ethers } from "ethers";
import { args, loadConfig, provider, loadAbi, fmt, PHASES } from "./lib.mjs";

const CHALLENGE_STATES = ["None", "Waiting for a match", "In a Kleros dispute", "Resolved"];

const a = args();
const cmd = a._[0];
const cfg = loadConfig(a.config ?? "config.json");
if (!cfg.contract) throw new Error('Set "contract" in config.json');
const prov = provider(cfg);
const signer = process.env.PRIVATE_KEY ? new ethers.Wallet(process.env.PRIVATE_KEY, prov) : null;
const { abi } = loadAbi("TruthPaysKickback");
const c = new ethers.Contract(cfg.contract, abi, signer ?? prov);
const readJson = (f) => JSON.parse(fs.readFileSync(f, "utf8"));
// The chain the RPC is really on (provider() pins cfg.chainId without asking the node).
const liveChainId = async () => Number(await prov.send("eth_chainId", []));

// For add-attendees: a plain array of wallets, or a stamped list for this contract
function walletsOf(file) {
  const d = readJson(file);
  if (!Array.isArray(d) && d.contract && d.contract.toLowerCase() !== cfg.contract.toLowerCase())
    throw new Error(`${file} was made for contract ${d.contract}, not ${cfg.contract}`);
  return (Array.isArray(d) ? d : d.items).map((r) => (typeof r === "string" ? r : r.wallet));
}

// new-stakers.json / refunds.json from verify-deposits: { contract, chainId, items: [{ wallet, status, … }] }.
// Like the console, refuse a list made for another contract or network, or one where any guest's
// on-chain status changed since it was made (re-run verify-deposits instead).
async function checkedList(file) {
  const d = readJson(file);
  if (Array.isArray(d) || !d.contract || !Array.isArray(d.items))
    throw new Error(`${file} is not a list made by verify-deposits (contract, chainId, items). Re-run verify-deposits.`);
  if (d.contract.toLowerCase() !== cfg.contract.toLowerCase()) throw new Error(`${file} was made for contract ${d.contract}, not ${cfg.contract}`);
  const chainId = await liveChainId();
  if (Number(d.chainId) !== chainId || (cfg.chainId && Number(cfg.chainId) !== chainId))
    throw new Error(`${file} was made for chain ${d.chainId} (config: ${cfg.chainId}), but the RPC is on chain ${chainId}. Stopped.`);
  const now = await Promise.all(d.items.map((i) => c.status(i.wallet)));
  const changed = d.items.filter((i, k) => Number(now[k]) !== Number(i.status));
  if (changed.length)
    throw new Error(`${file} is out of date: ${changed.length} guest(s) changed on-chain since it was made (e.g. ${changed[0].name || changed[0].wallet}). Re-run verify-deposits.`);
  return d.items.map((i) => i.wallet);
}

async function send(fn, ...params) {
  if (!signer) throw new Error("Set PRIVATE_KEY of the owner wallet");
  const chainId = await liveChainId();
  if (cfg.chainId && chainId !== Number(cfg.chainId)) throw new Error(`The RPC is on chain ${chainId}, the config says ${cfg.chainId}. Stopped.`);
  await c[fn].staticCall(...params); // surfaces the contract's reason before paying gas
  const tx = await c[fn](...params);
  console.log(`${fn} → ${cfg.explorer}/tx/${tx.hash}`);
  await tx.wait();
  console.log("✅ confirmed");
}

const BATCH = 100;
switch (cmd) {
  case "status": {
    const [count, phase, owner, spare, owedTotal, start, end, attendeeCount, windowEnd, pending, fee] = await Promise.all([
      c.stakerCount(), c.phase(), c.owner(), c.spare(), c.owedTotal(), c.eventStart(), c.claimDeadline(),
      c.attendeeCount(), c.challengeEndsAt(), c.pendingChallenges(), c.challengeDeposit().catch(() => null),
    ]);
    const token = new ethers.Contract(cfg.token, ["function balanceOf(address) view returns (uint256)"], prov);
    const bal = await token.balanceOf(cfg.contract);
    console.log({
      owner, phase: PHASES[Number(phase)], stakers: Number(count),
      pool: fmt(cfg.depositUnits * count, cfg.decimals), balance: fmt(bal, cfg.decimals),
      unclaimedPayouts: fmt(owedTotal, cfg.decimals), spare: fmt(spare, cfg.decimals),
      listFrom: new Date(Number(start) * 1000).toISOString(), listBy: new Date(Number(end) * 1000).toISOString(),
      attendees: Number(attendeeCount),
      challengeWindowEnds: windowEnd ? new Date(Number(windowEnd) * 1000).toISOString() : "(list not posted)",
      pendingChallenges: Number(pending), challengeDepositEth: fee === null ? "?" : ethers.formatEther(fee),
    });
    break;
  }
  case "register": {
    const list = await checkedList(a.file ?? "out/new-stakers.json");
    if (!list.length) console.log("Nobody to register.");
    for (let i = 0; i < list.length; i += BATCH) await send("registerStakers", list.slice(i, i + BATCH));
    break;
  }
  case "refund-declined": {
    const list = await checkedList(a.file ?? "out/refunds.json");
    if (!list.length) console.log("Nobody to refund.");
    for (let i = 0; i < list.length; i += BATCH) await send("rejectAndRefund", list.slice(i, i + BATCH));
    break;
  }
  case "post-attendance": {
    const plan = readJson(a.file ?? "out/payout-plan.json");
    if (!plan.contract || plan.contract.toLowerCase() !== cfg.contract.toLowerCase()) throw new Error("payout-plan.json is for a different contract");
    const share = await c.previewShare(plan.attendees.length);
    if (share.toString() !== plan.share) throw new Error(`Share on-chain is ${fmt(share, cfg.decimals)}, plan says ${plan.shareUsdc}. Rebuild the payout.`);
    console.log(`Posting ${plan.attendees.length} attendees (${fmt(share, cfg.decimals)} USDC each if nobody is added)`);
    await send("postAttendance", plan.attendees, share);
    break;
  }
  case "add-attendees": {
    if (!a.file) throw new Error("--file wallets.json is required");
    await send("addAttendees", walletsOf(a.file));
    break;
  }
  case "challenges": {
    const list = await c.challengers();
    if (!list.length) console.log("No challenges.");
    for (const w of list) {
      const ch = await c.challenges(w);
      console.log(`${w}: ${CHALLENGE_STATES[Number(ch.state)]}, deposit ${ethers.formatEther(ch.deposit)} ETH` +
        (Number(ch.state) === 1 ? `, match by ${new Date(Number(ch.matchEndsAt) * 1000).toISOString()}` : "") +
        (Number(ch.state) >= 2 ? `, Kleros case #${ch.arbitratorDisputeID}` : ""));
    }
    break;
  }
  case "resolve":
    await send("resolveChallenge", ethers.getAddress(a.staker));
    break;
  case "release":
    await send("releasePayouts");
    break;
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
    console.log("Commands: status | register | refund-declined | refund --to --amount | post-attendance | add-attendees --file | challenges | resolve --staker | release | cancel | sweep --to");
}
