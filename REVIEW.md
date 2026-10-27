# Truth Pays Kickback v6: review summary (27 Oct 2026, ETH deposit on Ethereum mainnet)

For Wei Wei and the developers reviewing the code before the live deployment.

## v6: Ethereum mainnet and ETH deposits (27 Oct 2026, please review this first)

**Why.** The organiser's decision on 27 Oct: "Change the chain to Mainnet instead of Arbitrum. Ask deposit in ETH instead of USDC." Deposits move from 25 USDC on Arbitrum One to **native ETH on Ethereum mainnet** (chain ID 1). The amount is `deposit` in the config, 0.01 ETH for now (about $23 on 27 Oct), still to be confirmed by her (0.011 or 0.005 ETH are possible); nothing outside configs, tests and doc examples hard-codes it. Kleros v2 only runs on Arbitrum, so attendance cases now go to **Kleros Court v1** on mainnet through Kleros's general-purpose **Dispute Resolver** (ArbitrableProxy `0x4b89e798b10478a839ea0abcf86c4b94a3c782a4`, arbitrator KlerosLiquid `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069`, General Court 0, 3 jurors, fee about 0.0162 ETH today, about 3 weeks per round).

**The mechanism is unchanged:** guests deposit, the organiser curates on Luma, verified and approved guests are registered, declined payers get exactly their deposit back, the whole pool is split equally among stakers who checked in, no-shows lose their deposit; 1-day challenge window, 1-day match window, unmatched = attended, matched = Kleros case; an open case only sets aside one share; appeals funded on Kleros by each funder; `emergencyWithdraw`, `cancel`, `claim`, `refund`, `sweep`, two-step ownership.

**Earlier rehearsals and reviews (v1 to v5, sections below) covered the Arbitrum/USDC/Kleros v2 version only.** v6 needs a new review and a new rehearsal on Ethereum mainnet.

**Contract (`contracts/TruthPaysKickback.sol`, v6; solc 0.8.28, optimizer 200, EVM paris; runtime 15,944 bytes)**
- **Deposits** come in through `receive()` and a payable `deposit()` (same logic): only while the phase is Open (`NotOpen` otherwise, so late ETH stays in the guest's wallet), `msg.value > 0` (`ZeroDeposit`), event `Deposited(from, amount)`. They change no state. The verify script reads `Deposited` events instead of USDC `Transfer` logs. The amount getter is `depositAmount()`; `token()` is gone.
- **One ETH balance.** Pool ETH, challenge ETH and owed ETH share the contract balance. `reserved() = (Open or Listed ? depositAmount × stakerCount : heldBack) + owedTotal + challengeEscrow`; `spare() = balance − reserved()`. `refund`, `sweep` and `rejectAndRefund` of an unregistered payer can only move spare ETH. `registerStakers` still only checks that the balance covers every staker (counted in total, not per wallet).
- **Payments.** Batch payments and challenge money (`releasePayouts`, `rejectAndRefund`, `cancel`, `resolveChallenge`, `addAttendees`, surplus refunds in `challenge`/`matchChallenge`) use a low-level call with `PAYOUT_GAS = 100,000` and copy no return data. A failure is recorded in `owed[to]` / `owedTotal` with `PayoutFailed`, and `claim(to)` (all gas forwarded) pays it to any address; `withdrawEth`/`ethOwed` are merged into `claim`/`owed`. If a send fails while less than `PAYOUT_GAS / 63` gas is left, the call reverts with `NotEnoughGas`, so a caller cannot starve a payment into `owed`. `refund`, `claim`, `sweep` and `emergencyWithdraw` forward all gas and revert on failure; their target may not be 0 or the contract itself. `Payout` now logs only pool shares and deposit refunds; `PayoutFailed` covers every failed send.
- **Reentrancy.** `nonReentrant` is the first modifier on every state-changing function except `deposit`/`receive` (event only) and the ownership functions. `registerStakers` and `rejectAndRefund` refuse `address(this)`.
- **Kleros v1.** `matchChallenge` sends exactly the fee: `disputeResolver.createDispute{value: cost}(arbitratorExtraData, metaEvidenceURI, 2)` (KlerosLiquid keeps everything sent), then stores the arbitrator dispute ID and the Dispute Resolver's local ID (`externalIDtoLocalID`); `ChallengeMatched` logs both. `resolveChallenge` reads `disputes(localDisputeID)` (`isRuled`, `ruling`); the Dispute Resolver sets `isRuled` only when KlerosLiquid executes the final ruling, and overrides it with the only funded side when exactly one side funded the last appeal round. `appealStatus(staker)` returns `(ruling, start, end, loserEnd, costAttended, costAbsent)` (the `round` value is gone), computed with the Dispute Resolver's `getMultipliers` and saturating maths like its CappedMath. The held-share logic (`heldShare`, `_settleHeldShare`) and the `cost ≤ 2 × deposit` guard are unchanged. The Kleros v2 interfaces, the on-chain dispute-template builder and `disputeKitID` are removed.
- **Static metaevidence.** One ERC-1497 file per deployment (`docs/metaevidence.json`, `fileURI` = the juror policy), passed to the constructor (`metaEvidenceURI`, `policyURI`) and used for every case. The contract submits no evidence: jurors learn the wallet from the "Challenge details" evidence the console offers to send right after a match, and from the contract's `Challenged` / `ChallengeMatched` events, which the description and the policy point them to (the events prevail if evidence disagrees).
- **Constructor:** `(depositAmount, eventName, owner, eventStart, claimDeadline, (disputeResolver, extraData, metaEvidenceURI, policyURI))`, extra data = `abi.encode(uint256 court, uint256 jurors)`. It reads `arbitrator()` from the Dispute Resolver. In live mode `deployArgs` refuses unless both URIs are `/ipfs/…` paths, and it always refuses the old Arbitrum/USDC policy pin.

**Scripts, console and guest page.** `scripts/lib.mjs`: `chain: "ethereum"` only, ETH units (18 decimals), `logChunk` (default 5,000 blocks, because free mainnet RPCs only serve old logs in small ranges; default RPC `https://rpc.mevblocker.io`), Kleros v1 addresses and settings. The verify script, payout script, console and guest page move to ETH on mainnet in the same change: deposits from `Deposited` events, Etherscan links, evidence and appeals sent to the Dispute Resolver with `challenges(staker).localDisputeID` from each person's own wallet, the final ruling delivered with KlerosLiquid `passPeriod` then `executeRuling` on the arbitrator dispute ID, case links `https://court.kleros.io/cases/<arbitrator dispute ID>`. The Arbitrum Sepolia test-network mode (`config.testnet.json`, `npm run console:testnet`) is removed.

**Configs.** `config.json` (live), `config.rehearsal.json` (throwaway rehearsal on mainnet, `poolCap` 0.25 ETH) and `config.example.json`: `chain` "ethereum", mevblocker RPC, `logChunk` 5000, `deposit` "0.01", `kleros {court: 0, jurors: 3, policyURI: "", metaEvidenceURI: ""}` until both files are pinned.

**Docs.** `docs/attendance-policy.md` rewritten for Ethereum mainnet, ETH and Kleros v1 appeals (same rules for jurors; how to find the wallet; any side the jurors did not vote for has only the first half of the appeal period; an appeal funded by only one side wins; refusal counts like "Did not attend"). New `docs/metaevidence.json`. README: guest instructions, wrong-network section flipped (Ethereum only; the owner wallet was already used on Arbitrum One, so ETH sent there to the contract address is treated as lost), issue codes for ETH, "How a Kleros case works", trust model, rehearsal.

**Please look at in particular:**
1. **ETH accounting in one balance:** that `reserved()` counts every liability in every phase (Open, Listed, Finalized with open cases, Cancelled), so `refund`, `sweep` and the unregistered branch of `rejectAndRefund` can never move pool, set-aside, challenge or owed ETH; the `challengeEscrow` bookkeeping in `challenge`, `matchChallenge`, `addAttendees`, `_acceptUnmatched` and `resolveChallenge` (`2 × deposit − fee`).
2. **The open `receive()`:** anyone can send ETH while Open (it stays spare unless the sender is registered); it is refused afterwards; a recipient re-depositing during a refund batch only adds spare ETH.
3. **The payout gas stipend:** 100,000 gas per batch payment, `NotEnoughGas`, `owed`/`claim`, gas for a 150-guest `releasePayouts` on mainnet, and griefing by recipients that burn their stipend.
4. **The Kleros v1 Dispute Resolver integration:** exact-fee `createDispute`, `externalIDtoLocalID`, reading `disputes(localID)`, `appealStatus` against the Dispute Resolver's own `appealCost`/`checkAppealPeriod` (including a tied vote or a refusal, where both sides pay the loser stake), and the trust placed in the Dispute Resolver (its arbitrator is immutable; its governor can change the multipliers).
5. **The static metaevidence:** whether jurors can reliably tell which wallet a case concerns from the "Challenge details" evidence and the contract's events, and what happens if nobody sends that evidence.

**Known points for the rehearsal and the review:**
- The Dispute Resolver pays appeal refunds, rewards and fund-appeal overpayments with `send` (2,300 gas) and ignores failures (`ArbitrableProxy.withdrawFeesAndRewards` and `fundAppeal`). A Safe or smart-contract wallet that funds an appeal can lose them. The README tells funders to use a normal wallet.
- The local Kleros mocks (`test/MockKleros.sol`) follow the deployed KlerosLiquid and Dispute Resolver ABIs, but the indexed flags of the Dispute Resolver's events were written from the ERC-1497/ERC-792 standards: check them against the deployed contract on Etherscan before the console decodes real mainnet logs (in the rehearsal).
- A challenge matched in the mainnet rehearsal opens a real Kleros General Court case (about 0.0162 ETH, real jurors, about 3 weeks) with whatever metaevidence is set: pin it first, or leave the challenge unmatched.
- The contract address on mainnet depends on the deploying wallet's transaction count there; the same address on Arbitrum One may already hold an old rehearsal contract. ETH sent on the wrong network is treated as lost (README "Wrong network").

**Tests (contract, on the v6 code):** `node --test test/contract.test.mjs` 30/30 on a local ganache chain, with mocks of KlerosLiquid and the Dispute Resolver (`test/MockKleros.sol`) and a test wallet that accepts, refuses, burns gas, needs about 66k gas or re-enters (`test/TestWallet.sol`). Every earlier behaviour is ported to ETH and Kleros v1, plus: deposit/receive events and refusals in every phase; refund/sweep/rejectAndRefund never touching the pool, owed, challenge escrow or held shares; refusing and gas-burning recipients (owed + claim) and a heavy smart wallet paid directly; `NotEnoughGas`; reentrancy from recipients; the full Kleros v1 flow (case creation with metaevidence and extra data, evidence under the local ID, appeals funded and withdrawn from funders' wallets, the one-side override, refusal to rule, fee more than doubled, non-payable appeal maths); held cases settled in every order.

**Tests (all suites, after merging contract, scripts, console, guest page and docs):** from a clean build (`rm -rf build && npm run compile`), `npm test` 38/38 (contract 30 + scripts end to end 8), `npm run test:site` 120/120, `npm run test:console` 97/97, all on local ganache.

**Before going live (v6):**
1. She confirms the deposit amount; set `deposit` in config.json (it is fixed in the contract at deploy).
2. Re-pin the juror policy and pin `docs/metaevidence.json` (its `fileURI` set to the policy pin first) through Kleros's upload service; set `kleros.policyURI` and `kleros.metaEvidenceURI`.
3. Short v6 rehearsal on Ethereum mainnet (`npm run console:rehearsal`, 0.25 ETH cap): deploy, deposit, register, refund a declined guest, post list, a challenge left unmatched, release payouts; Zerion accepting `chainId`; the Dispute Resolver's event layout.
4. Developer review of v6 (`contracts/TruthPaysKickback.sol`, `console/index.html`, `site/index.html`, `scripts/lib.mjs`).
5. Owner wallet funded with a little ETH on mainnet. Deploy the live contract from `npm run console`, verify the source on Etherscan (`build/TruthPaysKickback.standard-input.json`, 0.8.28, optimizer 200, paris), record `contract`, `receiver`, `deployBlock` and `depositOpensAt` in config.json, update the Luma copy and put the address on Luma while the event stays Private.
6. Go Public only when the organiser says so.

## v5: second review round (26 Oct, Arbitrum One / USDC version)

Two independent reviews ran on v4 (`423497f`): a multi-agent audit (8 reviewers, each finding re-checked) and a separate read-only review. Nothing critical. The confirmed findings and their fixes:

**Contract (`contracts/TruthPaysKickback.sol`)**
- **Appeal money no longer passes through the contract (high).** Kleros's own keeper bot (`kleros-v2/contracts/scripts/keeperBot.ts`, `withdrawAppealContribution`) calls `DisputeKitClassic.withdrawFeesAndRewards` for every contributor once a case is ruled. With v4's wrapper the contract was the contributor, so the bot (or anyone) pushed the refunds and rewards into the empty `receive()` before `collectAppealFunds` ran; the balance-delta accounting then saw 0 and every funder's ETH was stuck for good. Removed `fundAppeal`, `collectAppealFunds`, `claimAppealRewards`, `appealRewardOf`, their storage, events and errors, and `receive()`. Funders call `DisputeKitClassic.fundAppeal(arbitratorDisputeID, side)` from their own wallets (console and guest page do this), so Kleros pays them directly. `appealStatus` stays. This also removes the 3-argument split issue and the "stray ETH is lost" issue: plain ETH sent to the contract now reverts.
- **Fair held shares (low).** With several Kleros cases open at payout, a lost case's share used to go only to the attendees listed at that moment, so a challenger who won later got less than everyone else. `Challenge.shareHeld` (bool) is now `heldShare` (uint256, still the last field): a lost case's amount is split over attendees + cases still open, and each open case's `heldShare` grows by one part. Every final attendee gets the same total whatever order the cases settle in (tested with 2 and 3 cases in every order).
- Constructor requires `deposit_ > 0` (`ZeroDeposit`). Runtime bytecode 19,763 bytes (was 23,441).

**Evidence ID (medium, console and guest page).** The deployed DisputeResolverNeo emits `DisputeRequest(arbitrator, arbitratorDisputeID, localDisputeID, …)`; the court subgraph stores that third value as `dispute.externalDisputeId`, and the court app reads evidence by it. v4 filed evidence under the core dispute ID, so jurors would not have seen it. Both frontends now call `EvidenceModule.submitEvidence(challenges(staker).localDisputeID, …)` (checked against kleros-v2 `master`: `deployments/arbitrum/DisputeResolverNeo.json`, `subgraph/core/src/entities/Dispute.ts`, `web/src/pages/Cases/CaseDetails/Evidence`).

**Verify script (`scripts/verify-deposits.mjs`, `lib.mjs`, `build-payout.mjs`)**
- **Deposits returned with `refund()` were still treated as held (medium).** A stray returned with "Return a stray transfer" and later pasted on Luma could be registered with no money behind it (the contract only checks the total). Deposits are now paired with `Rejected` and `Refunded` events per wallet, by amount, oldest first; a returned deposit becomes `RETURNED_EARLIER` and is never listed again. `PAID_AGAIN_DECLINED` clears once returned.
- **A copied tx link could knock out the real guest (medium).** The wallet that sent the deposit (or is registered) now keeps it; a declined copy never wins; build-payout matches check-ins through `out/claims.csv`.
- Inferred wallets: 0x0 or contract senders become `UNUSUAL_SENDER`. Money to give back that used to fall through (short, overpaid, late, paid twice) is listed in `out/returns.csv`, net of returns already made; declined late payers go to `refunds.json`. All log scans are chunked; the script refuses to run on a real network without a deploy block and deletes stale outputs first. CSV formula injection neutralised. Free guests answering "N/A" are no longer flagged. `owner.mjs` checks chain id and live status.

**Guest page (`site/index.html`)**: appeals funded and collected directly on the kit (offered whenever the case is over, including when the challenger won and was paid); evidence under the local ID; every transaction pinned with `chainId` and the network re-read right before sending; the earlier-deposit check fails closed and is re-run before sending (build refuses a live page without `deployBlock`); returned deposits no longer block a new deposit; "Copy link and go back to Luma" only leaves after a successful copy; account switch clears the old tx; undeliverable USDC can be claimed for every status; a "Release payouts" button for anyone once it would succeed; error strings escaped.

**Owner console (`console/index.html`)**: appeals funded from her wallet straight to the kit, rewards collected only where something is due; evidence under the local ID; deploy re-checks the config on disk, shows name/policy/dates/mode, and asks to type SECOND before a second deploy; "Remove and refund" only for registered stakers; "Return a stray transfer" shows earlier returns to that address; leftover and cancel warnings; every transaction carries `chainId`.

**Docs**: juror policy says an appeal funded by only one side wins, and that a refusal to arbitrate counts like "No". Re-pinned at `/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg`. README runbook: cancel steps for unregistered payers, returns list, appeals.

**Final cross-check after merging (no contract change):** a read-only pass over the seams between the four parts found 6 small issues, all fixed: the console and `owner.mjs` linked a challenge settled without a match to "Kleros case #0"; after the list is posted, a declined staker went into `refunds.json` and made the whole "Refund declined guests" batch revert (now reported as `DECLINED_AFTER_LIST`); `build-payout.mjs` left an old `payout-plan.json` behind when a re-run failed (outputs are now deleted first); a deposit pasted by a guest whose wallet did not send it (`WRONG_SENDER` / `UNUSUAL_SENDER` / `AMBIGUOUS_SENDER`) appeared in no list of money to give back (now in `unmatched.csv`, naming the guest); README issue table now covers `TX_FAILED`, `AMBIGUOUS_SENDER`, `RPC_ERROR`, and says only the console offers "Deliver final ruling".

**Tests (v5, all on the merged code):** `npm test` 31/31 (25 contract tests + 6 script tests, including the full flow verify → curate → register/refund → check-ins → post list → challenge → release), guest page 100/100 and owner console 70/70 browser checks (`npm run test:site`, `npm run test:console`). The Kleros mock now follows Kleros's one-side-funded override in `currentRuling`.

**Still to check live:** evidence showing on the Kleros court page for a real DisputeResolver case, and Zerion accepting transactions with a `chainId` field (both in the rehearsal).

Please look at: `_settleHeldShare` and `releasePayouts` (held shares), `resolveChallenge`, the removed appeal surface, and `pairReturns` / `resolveClaims` in `scripts/lib.mjs`.

## Rename (26 Oct, no contract logic change)

- **New event name, Truth Pays.** The contract is renamed `GroundTruthKickback` → `TruthPaysKickback` (file, NatSpec and build artifacts; bytecode logic unchanged), `eventName` in the configs is now "Truth Pays: …", and the console, guest page, scripts and docs use the new name.
- **Juror policy** updated with the new event name and re-pinned (byte-identical, checked via cdn.kleros.link); `kleros.policyURI` updated in config.json and config.rehearsal.json. The current pin, after the v5 appeals wording, is `/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg`.
- **Guest page (`site/index.html`) has two modes.** The default page only does the deposit: connect, switch to Arbitrum One, send 25 USDC, then "Copy link and go back to Luma" (copies the Arbiscan tx link and returns to the Luma event, where the guest picks the Committed Spot ticket and pastes it; Luma then shows the registration as pending approval). After-event tools (deposit lookup, Kleros challenge, evidence, appeals) moved to `#status` on the same file.
- **v4 rehearsal on Arbitrum One** (throwaway contract `0xc49531098132c0aa1E5eA4d061eA1B6C68076c5C`): deploy, deposit, register, refund, deposit again, register, post attendance list all passed; release payouts is due after the challenge window.

## What changed in v4 (25 Oct; the appeal wrapper below was removed in v5)

Requested by the organiser ("it is missing appeals: the whole A to Z, contract, frontend, full Kleros dispute protocol"), plus every fix from the developer review of v3 (`/mnt/project-files/reviews/dev-review-2026-10-25.md`, findings F1 to F12).

**Kleros appeals in the contract.** In Kleros v2 only the dispute kit can appeal (`KlerosCore.appeal` is restricted to it), and `DisputeKitClassic.fundAppeal(coreDisputeID, choice)` crowdfunds each answer (losing answer: appeal cost + 2×, first half of the appeal period only; winning answer: cost + 1×; a new round starts once both are funded). The contract now wraps it:
- `fundAppeal(staker, side)` (payable, anyone, while the challenge is `Disputed`): forwards to the kit, measures what the kit kept by balance delta (the kit refunds any surplus to the contract), records it per staker / round / side / funder (`appealPaid`, `appealContribution`, `appealRounds`) and returns the surplus to the funder. Kleros's own errors (`NotAppealPeriod`, `NotAppealPeriodForLoser`, `AppealFeeIsAlreadyPaid`) bubble up.
- `collectAppealFunds(staker)` (anyone, once, after `resolveChallenge`): calls `withdrawFeesAndRewards` for the contract as beneficiary, per round and side. Uses the 4-argument version deployed on Arbitrum One (proxy `0x70B464be85A547144C72485eBa2577E5D3A45421`) and falls back to the newer 3-argument one (all rounds at once, then spread over the rounds by what was paid). Stored in `appealReturned`.
- `claimAppealRewards(staker, to)`: each funder takes `contribution × returned ÷ paid` per round and side (collects first if nobody has). `appealRewardOf(staker, funder)` previews it.
- `appealStatus(staker)`: round, current vote, appeal period, the losing side's deadline and the total needed per side, read from KlerosCore and the kit's multipliers. `disputeKitID` comes from the arbitrator extra data.
- An empty `receive()` takes the kit's refunds and rewards (the kit sends with a 2300-gas `send`). All ETH maths uses balance deltas or tracked amounts, so stray ETH does not interfere.
- The DisputeResolver sets `isRuled` only when KlerosCore executes the final ruling after the last appeal period, so nothing settles on a vote that is later overturned.

**Evidence.** The console and guest page send evidence straight to Kleros's EvidenceModule (`submitEvidence(coreDisputeID, json)`, Arbitrum One `0x48e052B4A6dC4F30e90930F1CeaAFd83b3981EB3`, `kleros.evidenceModule` in the config), so Kleros shows the real sender. Not routed through the contract on purpose: the court would then show the contract as the party.

**Review fixes.**
- **F7 (medium), anyone could freeze every payout by matching, then appealing:** `releasePayouts` no longer waits for Kleros cases. It needs the challenge window over and no challenge still waiting for a match (expired ones are accepted, as before). Share = pool ÷ (attendees + open cases); everyone on the list is paid and one share per open case is set aside (`payoutShare`, `heldBack`, `Challenge.shareHeld`; `reserved()` keeps `heldBack` after finalization, so `refund`/`sweep` cannot touch it). `resolveChallenge` on such a case pays the share to the challenger if the final ruling is "attended" (added to the list, status Paid), otherwise splits it equally among everyone on the list (dust stays spare). Events `ShareHeldBack`, `HeldShareSplit`.
- **F1 (medium), an unanswered appeal decides the case:** "defend your side" guidance in the README runbook, the console (static warning plus a live ⚠ line when only one side is being funded) and the guest page.
- **F4:** `_sendEth` uses an assembly `call` that copies no return data.
- **F5:** `addAttendees` now refuses a staker whose challenge is in a Kleros case (`InDispute`), so a "No" ruling always means off the list, matching the template and the policy. The organiser concedes in the case instead (the policy already says to rule Yes when the organiser confirms). README wording fixed.
- **F6:** `_sendOrRevert`, `withdrawEth` and `claimAppealRewards` refuse `to == address(this)`.
- **F9:** template question now "Did the person who registered with wallet 0x… attend …?", and the answer texts match the policy; the policy names the event as it appears in the dispute.
- **F10:** `challengeDeposit()` NatSpec says matching takes `challenges(staker).deposit`. **F12:** `stakers()` NatSpec notes a re-registered wallet appears twice.
- **F2, F8, F11, F3 (README):** emergency withdrawal only applies when no list was posted; `PAID_AGAIN_DECLINED` in the issue table; a last-minute challenge can delay the payout by its own 1-day match window; a match is refused if the Kleros fee more than doubles within that day.

**Juror policy:** new "Appeals" section, the F5/F7/F9 wording. Re-pinned at `/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg` (byte-identical to the file, checked via cdn.kleros.link) and set as `kleros.policyURI` in config.json and config.rehearsal.json.

**Size:** runtime bytecode 23,441 bytes (limit 24,576), optimizer 200, EVM paris, solc 0.8.28.

**Tests:** 23 contract tests + the script end-to-end run (`npm test`, 24/24), including: an appeal funded directly on the kit; appeals funded through the contract by a crowd and the guest with surplus refunds and rewards shared by contribution; the losing side's deadline, an unfunded side refunded, the newer 3-argument kit; payouts with a case open and the set-aside share going to the winner or split among attendees; a last-minute challenge holding the payout; `InDispute`; `to == address(this)`. Owner console 40/40 and guest page 55/55 browser checks (evidence, appeal funding through the contract, payout during a case, final ruling, settle, rewards). The Kleros mock models KlerosCore's appeal views and DisputeKitClassic's funding and reward rules.

Please look at: the balance-delta accounting in `fundAppeal` and `_collectAppealFunds`, the 3-argument fallback, `_settleHeldShare`, and the `pendingChallenges == open` check in `releasePayouts`.

## What changed in v3

Requested by the organiser on 25 Oct:

1. **`require(condition, CustomError(...))` everywhere** instead of `if (!condition) revert CustomError(...)`. Needs Solidity ≥ 0.8.27 on the legacy pipeline; the compiler is now **0.8.28** (optimizer 200, EVM `paris`).
2. **Attendance challenges on Kleros**, integrated directly in the contract:
   - `postAttendance(list, share)` (owner, from `eventStart`) replaces `finalize`. It publishes the attendance list and opens a **1-day challenge window** (`challengeEndsAt`). Phase becomes `Listed`. The enum is now `Open, Listed, Finalized, Cancelled`.
   - `challenge()` (a registered staker not on the list, within the window, `msg.value ≥ challengeDeposit()` = the Kleros arbitration cost; excess refunded).
   - `matchChallenge(staker)` (anyone, within 1 day of that challenge, same ETH amount). Creates the dispute through Kleros v2's **DisputeResolver** (`createDisputeForTemplate`, 2 options) with a JSON template built on-chain (event name, wallet, question, answers, `policyURI`). KlerosCore on Arbitrum only accepts whitelisted arbitrables (a direct `createDispute` reverts `ArbitrableNotWhitelisted`, checked with an `eth_call` against mainnet), and the DisputeResolver is the open, whitelisted entry point; we verified with a mainnet simulation that it returns a dispute ID for our template.
   - `resolveChallenge(staker)` (anyone): unmatched after its 1-day match window → counts as attended, deposit back; ruled → ruling 1 adds the staker and pays them the remaining ETH, ruling 2 pays the matcher, ruling 0 splits it.
   - `addAttendees(list)` (owner, during the window): fixes an honest mistake; a waiting challenger's deposit goes straight back.
   - `releasePayouts()` (anyone, after the window): auto-accepts unmatched challenges whose match window ran out, requires `pendingChallenges == 0`, then pays `pool / attendeeCount` to everyone on the list.
   - ETH transfers use a 30k-gas call; if it fails the amount is kept in `ethOwed` for `withdrawEth(to)`. All ETH-moving functions are `nonReentrant`.
   - `cancel` and `emergencyWithdraw` only while `Open` (before the list is posted). After posting, payout no longer depends on the owner.
3. Owner console: **Post attendance list** (locked until the event starts, type POST), challenge list with Kleros case links, **Add to the list**, **Dispute**, **Settle**, **Release payouts** (locked until the window ends and no case is pending, type PAY). Deploy passes the Kleros settings from `config.kleros`.
4. Guest page: challenge / dispute / settle from "Check a deposit", an "Open challenges" list, and an explainer.

Points we would like reviewers to look at in particular: the ETH accounting in `resolveChallenge` (2 × deposit − fee, rounding on the split), the `cost ≤ 2 × deposit` guard if the Kleros fee rises between challenge and match, the unbounded loop over `_challengers` in `releasePayouts` (bounded by the number of stakers, at most 150), and the template JSON (no user-controlled strings except the owner-set event name and policy path).

**Tradeoffs the organiser accepted:** a fee of about 0.015 ETH per side; a matched challenge holds that challenger's share for about 3 weeks (one Kleros round; each appeal adds another round); since v4 everyone else is paid on time; the juror policy (`docs/attendance-policy.md`, approved by the organiser) is pinned on IPFS at `/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg` and set in `config.kleros.policyURI` (the live deploy refuses without one).

Tests: 19 contract tests (including every challenge path against a mock DisputeResolver and an ETH-refusing wallet), the end-to-end script test (posts the list, an unmatched challenge, release), 43 browser checks on the guest page and 19 on the owner console (deploy with Kleros settings → register → post → challenge → dispute → ruling → settle → release).

## What changed in v2 (since the rehearsal of v1)

| Area | v1 (rehearsal contract 0x1F04…620f) | v2 (this zip) |
|---|---|---|
| Declining a paying guest | Remove staker, then a separate free-form refund (typos possible) | `rejectAndRefund`: exactly the deposit, back to the guest's own wallet, one click for the whole list |
| Owner refunds | `refund` could, together with `removeStaker`, move other guests' money | `refund` and `sweep` only move *spare* money, never the staked pool or unclaimed payouts |
| Payout | `finalize(list)`, one blocked USDC address made the whole payout fail | `finalize(list, share)`: the share she confirmed must match; a failed transfer is kept for that guest to `claim` elsewhere |
| Timing | none | payout only from `eventStart`; after `claimDeadline` (at least 7 days later) the organiser can no longer settle and each staker can withdraw their own deposit, so a lost owner wallet cannot lock the pool |
| Ownership | one step | two steps (`transferOwnership` + `acceptOwnership`) |
| Curation | none | the scripts register only guests who are verified **and** approved on Luma; declined payers go to a refund list |

## How it was reviewed

1. First review of v1 (security, edge cases, operations), each finding double-checked by a second reviewer. Ten issues, all fixed in v2.
2. Second review of v2. Six issues (deadline race, emergency withdraw to another address, a blocked wallet stopping a refund batch, late payers after settlement, re-registering a refunded guest, odd token return values), all fixed.
3. Final review of the whole project from four angles (contract, owner console, scripts, launch readiness), each finding re-checked by an independent reviewer that tried to disprove it:
   - **Contract: no issues found.**
   - Console (8 confirmed): error text could say "rate limited" for a real contract error; buttons could be clicked twice during an action; an old list could be sent after things changed; lists were not tied to one contract and network; deploy could make the wrong wallet the owner; the local server could be crashed by a bad link; a 5-minute timeout showed a raw error; "Collect leftovers" could take unrefunded deposits. **All fixed.**
   - Scripts (8 confirmed): two Luma rows for the same wallet could refund a registered guest; a refunded guest who paid again could never be registered; check-ins were matched through other people's rows; the door list needed exact headers; bad dates switched off the deposit window; column detection picked the wrong column. **All fixed.**
   - Launch readiness (5 confirmed): deploy block not saved; no step to refund pending, waitlisted or late payers before the payout; README pointed to developer-only commands; `cp` could overwrite the config; receiver and contract could differ. **All fixed.**

## Tests

- `npm test`: contract tests (guards, blocklisted wallets, tokens returning false or nothing, deadlines, two-step ownership, 150 guests) and an end-to-end run of the scripts with a fake Luma export (approved, declined, pending, duplicates, refund then pay again, door list). Gas with 150 guests: register about 7.2M in three batches, payout to 120 attendees about 2.4M, well inside an Arbitrum block.
- The owner console was also driven in a real browser against a local chain (21 checks, plus the payout lock before the event: deploy, safety cap, register, refund declined, out-of-date and wrong-contract lists refused, remove one guest, return a stray transfer, payout with a stale and a correct plan, cancel and leftovers).

## Rehearsal on Arbitrum One (23 Oct, real USDC, throwaway contract 0x922aA26EFeF7F688e0290eb6eBdCE51a94925430)

Deploy, 25 USDC deposit, verify, decline + refund (`rejectAndRefund`, tx 0x4c738e33…f582), deposit again, register, payout (tx 0x6fcf23b4…6c7d). Every USDC accounted for, contract left at 0, total fees under $0.01. It found one small bug, fixed afterwards: `unmatched.csv` listed an already-refunded deposit as unclaimed. Also added after the rehearsal: "Pay attendees" is greyed out in the console until the event starts and needs PAY typed to confirm (the contract itself already refuses any payout before `eventStart`).

## Known limits (v2 to v5, Arbitrum/USDC version; see v6 above)

- The contract counts money in total, not per wallet: deposits are plain USDC transfers verified off-chain from the Luma tx links. Only register wallets the verify script lists.
- Guests who paid but were never registered depend on the organiser to refund them (the console and scripts make this one click).
- The owner is a single wallet, not a multisig (organiser's choice for a side event).
- Attendance is published by the organiser from the Luma check-in; stakers left off can challenge on Kleros (see v3 above).

## Before going live (v3 to v5, Arbitrum/USDC version; superseded by the v6 list above)

1. Short v3 rehearsal on Arbitrum One (`npm run console:rehearsal`, 500 USDC cap, throwaway contract), including one challenge left unmatched.
2. Developer review of `contracts/TruthPaysKickback.sol` and `console/index.html`.
3. Juror policy: pinned again for v4 (path in config.json `kleros.policyURI`); re-pin only if the file changes. Deploy the live contract from `npm run console`, verify the source on Arbiscan (`build/TruthPaysKickback.standard-input.json`, compiler 0.8.28), record `contract`, `receiver`, `deployBlock` and `depositOpensAt` in `config.json`, and put the address on Luma while the event stays Private.
4. Go Public only when the organiser says so.
