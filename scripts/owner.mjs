#!/usr/bin/env node
// Owner actions from the command line, for developers (the organiser uses the owner console).
// If the owner is a Safe, use the out/safe-*.json files in Safe Transaction Builder instead.
// Amounts are in ETH.
//
//   node scripts/owner.mjs status                        (read-only, no key needed)
//   node scripts/owner.mjs challenges                    (read-only list, with Kleros case links)
//   node scripts/owner.mjs case --staker 0x…             (read-only: appeal period and costs of a Kleros case)
//   node scripts/owner.mjs case-description --staker 0x… (read-only: writes the case's description to
//                                                         out/case-<wallet>.json and prints its IPFS path; publish
//                                                         that exact file to IPFS, e.g. Kleros's upload service)
//   PRIVATE_KEY=0x… node scripts/owner.mjs register        [--file out/new-stakers.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs refund-declined [--file out/refunds.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs refund --to 0x… --amount 0.005   (spare ETH only)
//   PRIVATE_KEY=0x… node scripts/owner.mjs return-token --token 0x… --to 0x… --amount 25   (tokens sent by mistake, in whole tokens)
//   PRIVATE_KEY=0x… node scripts/owner.mjs post-attendance [--file out/payout-plan.json]
//   PRIVATE_KEY=0x… node scripts/owner.mjs add-attendees --file wallets.json   (during the 1-day window)
//   PRIVATE_KEY=0x… node scripts/owner.mjs resolve --staker 0x…          (anyone; after match window / ruling)
//   PRIVATE_KEY=0x… node scripts/owner.mjs release                      (anyone; after the window, none waiting for a match)
//   PRIVATE_KEY=0x… node scripts/owner.mjs claim --to 0x…               (the signer's own payment that could not be delivered)
//   PRIVATE_KEY=0x… node scripts/owner.mjs cancel
//   PRIVATE_KEY=0x… node scripts/owner.mjs sweep --to 0x…
import fs from "node:fs";
import { ethers } from "ethers";
import { args, loadConfig, provider, loadAbi, fmt, fmtEth, klerosConfig, gasLimitFor, ipfsPathOf, PHASES } from "./lib.mjs";

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
const iso = (t) => new Date(Number(t) * 1000).toISOString();
const caseUrl = (id) => `${klerosConfig(cfg).courtUrl}/cases/${id}`;

// For add-attendees: a plain array of wallets, or a stamped list for this contract
function walletsOf(file) {
  const d = readJson(file);
  if (!Array.isArray(d) && d.contract && d.contract.toLowerCase() !== cfg.contract.toLowerCase())
    throw new Error(`${file} was made for contract ${d.contract}, not ${cfg.contract}`);
  return (Array.isArray(d) ? d : d.items).map((r) => (typeof r === "string" ? r : r.wallet));
}

// new-stakers.json / refunds.json from verify-deposits: { contract, chainId, deposit, items: [{ wallet, status, … }] }.
// Like the console, refuse a list made for another contract, network or deposit amount, or one where
// any guest's on-chain status changed since it was made (re-run verify-deposits instead).
async function checkedList(file) {
  const d = readJson(file);
  if (Array.isArray(d) || !d.contract || !Array.isArray(d.items) || !d.deposit)
    throw new Error(`${file} is not a list made by verify-deposits (contract, chainId, deposit, items). Re-run verify-deposits.`);
  if (d.contract.toLowerCase() !== cfg.contract.toLowerCase()) throw new Error(`${file} was made for contract ${d.contract}, not ${cfg.contract}`);
  const chainId = await liveChainId();
  if (Number(d.chainId) !== chainId || (cfg.chainId && Number(cfg.chainId) !== chainId))
    throw new Error(`${file} was made for chain ${d.chainId} (config: ${cfg.chainId}), but the RPC is on chain ${chainId}. Stopped.`);
  // the deposit is fixed in the contract: the config and the list must use the same amount
  const deposit = await c.depositAmount();
  if (cfg.depositUnits !== deposit)
    throw new Error(`The config says the deposit is ${cfg.deposit} ETH, but the contract was deployed with ${fmt(deposit)} ETH. Set "deposit" in the config to the contract's amount and re-run verify-deposits. Stopped.`);
  if (BigInt(d.deposit) !== deposit)
    throw new Error(`${file} was made for a deposit of ${fmt(BigInt(d.deposit))} ETH, but the contract takes ${fmt(deposit)} ETH. Re-run verify-deposits. Stopped.`);
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
  // 20% over the estimate: batch payments give each recipient up to PAYOUT_GAS, and a limit cut too
  // fine makes the contract revert with NotEnoughGas rather than leave a payment unpaid. Never above
  // the 2^24 gas a single Ethereum transaction may use (EIP-7825), which the network would refuse.
  const gasLimit = gasLimitFor(await c[fn].estimateGas(...params), 20n);
  const tx = await c[fn](...params, { gasLimit, chainId: cfg.chainId });
  console.log(`${fn} → ${cfg.explorer}/tx/${tx.hash}`);
  await tx.wait();
  console.log("✅ confirmed");
}

const BATCH = 100;
switch (cmd) {
  case "status": {
    const [count, phase, owner, deposit, reserved, spare, owedTotal, heldBack, escrow, start, end, attendeeCount, windowEnd, pending, fee, bal] =
      await Promise.all([
        c.stakerCount(), c.phase(), c.owner(), c.depositAmount(), c.reserved(), c.spare(), c.owedTotal(), c.heldBack(),
        c.challengeEscrow(), c.eventStart(), c.claimDeadline(), c.attendeeCount(), c.challengeEndsAt(), c.pendingChallenges(),
        c.challengeDeposit().catch(() => null), prov.getBalance(cfg.contract),
      ]);
    console.log({
      owner, phase: PHASES[Number(phase)], stakers: Number(count), deposit: fmtEth(deposit),
      pool: fmtEth(deposit * count), balance: fmtEth(bal), reserved: fmtEth(reserved),
      unclaimedPayments: fmtEth(owedTotal), setAsideForKlerosCases: fmtEth(heldBack), challengeMoney: fmtEth(escrow),
      spare: `${fmt(spare)} ETH`,
      listFrom: iso(start), listBy: iso(end),
      attendees: Number(attendeeCount),
      challengeWindowEnds: windowEnd ? iso(windowEnd) : "(list not posted)",
      pendingChallenges: Number(pending), challengeDeposit: fee === null ? "?" : fmtEth(fee),
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
    if (Number(plan.chainId) !== (await liveChainId())) throw new Error(`payout-plan.json was made for chain ${plan.chainId}, the RPC is on another one. Stopped.`);
    const share = await c.previewShare(plan.attendees.length);
    if (share.toString() !== plan.share) throw new Error(`Share on-chain is ${fmt(share)} ETH, plan says ${fmt(BigInt(plan.share))} ETH. Rebuild the payout.`);
    console.log(`Posting ${plan.attendees.length} attendees (${fmtEth(share)} each if nobody is added)`);
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
      const state = Number(ch.state);
      console.log(`${w}: ${CHALLENGE_STATES[state]}, deposit ${fmtEth(ch.deposit)}` +
        (state === 1 ? `, match by ${iso(ch.matchEndsAt)}` : "") +
        (state >= 2 && ch.matcher !== ethers.ZeroAddress
          ? `, Kleros case #${ch.arbitratorDisputeID} (Dispute Resolver ID ${ch.localDisputeID}) ${caseUrl(ch.arbitratorDisputeID)}` : "") +
        (ch.heldShare > 0n ? `, share set aside ${fmtEth(ch.heldShare)}` : ""));
    }
    break;
  }
  case "case": {
    if (!a.staker) throw new Error("--staker 0x… is required");
    const staker = ethers.getAddress(a.staker);
    const ch = await c.challenges(staker);
    const [ruling, start, end, loserEnd, costAttended, costAbsent] = await c.appealStatus(staker);
    const RULING = ["refused / tied (counts as did not attend)", "attended", "did not attend"];
    console.log({
      case: caseUrl(ch.arbitratorDisputeID), arbitratorDisputeID: ch.arbitratorDisputeID.toString(), localDisputeID: ch.localDisputeID.toString(),
      currentRuling: RULING[Number(ruling)] ?? String(ruling),
      appeal: end ? { from: iso(start), until: iso(end), losingSideUntil: iso(loserEnd), costAttended: fmtEth(costAttended), costAbsent: fmtEth(costAbsent) }
        : "not in the appeal period",
    });
    break;
  }
  case "case-description": {
    if (!a.staker) throw new Error("--staker 0x… is required");
    const staker = ethers.getAddress(a.staker);
    const [text, uri] = await c.caseMetaEvidence(staker);
    if (ipfsPathOf(text) !== uri) throw new Error(`The contract's IPFS path ${uri} does not match its text (${ipfsPathOf(text)}). Stopped.`);
    const out = a.out ?? "out";
    fs.mkdirSync(out, { recursive: true });
    const file = `${out}/case-${staker}.json`;
    fs.writeFileSync(file, text); // exactly the contract's bytes: the IPFS path depends on every one
    console.log(`${file}\n${uri}\n${klerosConfig(cfg).ipfsGateway}${uri}`);
    break;
  }
  case "resolve":
    await send("resolveChallenge", ethers.getAddress(a.staker));
    break;
  case "release": {
    // releasePayouts accepts every unmatched challenge whose match window ended and pays its deposit
    // back. Settle those one by one first: many of them from wallets that burn their whole PAYOUT_GAS
    // could push the payout batch past the 2^24 gas a transaction may use.
    if (!signer) throw new Error("Set PRIVATE_KEY of the owner wallet");
    await c.releasePayouts.staticCall(); // stops early: too early, or a challenge still waiting for a match
    const now = BigInt((await prov.getBlock("latest")).timestamp);
    for (const w of await c.challengers()) {
      const ch = await c.challenges(w);
      if (Number(ch.state) === 1 && now > ch.matchEndsAt) {
        console.log(`Settling ${w}'s unmatched challenge (counts as attended)`);
        await send("resolveChallenge", w);
      }
    }
    await send("releasePayouts");
    break;
  }
  case "refund":
    await send("refund", ethers.getAddress(a.to), ethers.parseEther(String(a.amount)));
    break;
  case "claim":
    await send("claim", ethers.getAddress(a.to));
    break;
  case "return-token": {
    // tokens (USDC…) sent to the contract by mistake: never a deposit, and this cannot move ETH
    const token = new ethers.Contract(ethers.getAddress(a.token), ["function decimals() view returns (uint8)", "function symbol() view returns (string)"], prov);
    const [decimals, symbol] = await Promise.all([token.decimals(), token.symbol().catch(() => "tokens")]);
    const amount = ethers.parseUnits(String(a.amount), decimals);
    console.log(`Returning ${a.amount} ${symbol} to ${ethers.getAddress(a.to)}`);
    await send("returnToken", token.target, ethers.getAddress(a.to), amount);
    break;
  }
  case "cancel":
    await send("cancel");
    break;
  case "sweep":
    await send("sweep", ethers.getAddress(a.to));
    break;
  default:
    console.log("Commands: status | challenges | case --staker | register | refund-declined | refund --to --amount | return-token --token --to --amount | post-attendance | add-attendees --file | resolve --staker | release | claim --to | cancel | sweep --to");
}
