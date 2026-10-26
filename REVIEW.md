# Truth Pays Kickback v4: review summary (25 Oct 2026, deposit 25 USDC on Arbitrum One)

For Wei Wei and the developers reviewing the code before the live deployment.

## Since v4 (26 Oct, no contract logic change)

- **New event name, Truth Pays.** The contract is renamed `GroundTruthKickback` → `TruthPaysKickback` (file, NatSpec and build artifacts; bytecode logic unchanged), `eventName` in the configs is now "Truth Pays: …", and the console, guest page, scripts and docs use the new name.
- **Juror policy** updated with the new event name and re-pinned at `/ipfs/QmQmGrayc6kWJqpRgVDoN814by8RYx8pLQ5VcC6qhKR2gJ` (byte-identical, checked via cdn.kleros.link); `kleros.policyURI` updated in config.json and config.rehearsal.json.
- **Guest page (`site/index.html`) has two modes.** The default page only does the deposit: connect, switch to Arbitrum One, send 25 USDC, then "Copy link and go back to Luma" (copies the Arbiscan tx link and returns to the Luma event, where the guest picks the Committed Spot ticket and pastes it; Luma then shows the registration as pending approval). After-event tools (deposit lookup, Kleros challenge, evidence, appeals) moved to `#status` on the same file.
- **v4 rehearsal on Arbitrum One** (throwaway contract `0xc49531098132c0aa1E5eA4d061eA1B6C68076c5C`): deploy, deposit, register, refund, deposit again, register, post attendance list all passed; release payouts is due after the challenge window.

## What changed in v4 (25 Oct, please review this first)

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

**Juror policy:** new "Appeals" section, the F5/F7/F9 wording. Re-pinned at `/ipfs/QmQmGrayc6kWJqpRgVDoN814by8RYx8pLQ5VcC6qhKR2gJ` (byte-identical to the file, checked via cdn.kleros.link) and set as `kleros.policyURI` in config.json and config.rehearsal.json.

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

**Tradeoffs the organiser accepted:** a fee of about 0.015 ETH per side; a matched challenge holds that challenger's share for about 3 weeks (one Kleros round; each appeal adds another round); since v4 everyone else is paid on time; the juror policy (`docs/attendance-policy.md`, approved by the organiser) is pinned on IPFS at `/ipfs/QmQmGrayc6kWJqpRgVDoN814by8RYx8pLQ5VcC6qhKR2gJ` and set in `config.kleros.policyURI` (the live deploy refuses without one).

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

## Known limits (by design, please look at these)

- The contract counts money in total, not per wallet: deposits are plain USDC transfers verified off-chain from the Luma tx links. Only register wallets the verify script lists.
- Guests who paid but were never registered depend on the organiser to refund them (the console and scripts make this one click).
- The owner is a single wallet, not a multisig (organiser's choice for a side event).
- Attendance is published by the organiser from the Luma check-in; stakers left off can challenge on Kleros (see v3 above).

## Before going live

1. Short v3 rehearsal on Arbitrum One (`npm run console:rehearsal`, 500 USDC cap, throwaway contract), including one challenge left unmatched.
2. Developer review of `contracts/TruthPaysKickback.sol` and `console/index.html`.
3. Juror policy: pinned again for v4 (path in config.json `kleros.policyURI`); re-pin only if the file changes. Deploy the live contract from `npm run console`, verify the source on Arbiscan (`build/TruthPaysKickback.standard-input.json`, compiler 0.8.28), record `contract`, `receiver`, `deployBlock` and `depositOpensAt` in `config.json`, and put the address on Luma while the event stays Private.
4. Go Public only when the organiser says so.
