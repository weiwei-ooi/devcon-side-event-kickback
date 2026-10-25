# Ground Truth Kickback v3: review summary (25 Oct 2026, deposit 25 USDC on Arbitrum One)

For Wei Wei and the developers reviewing the code before the live deployment.

## Since v3: Kleros appeals (25 Oct, no contract change)

The organiser noticed appeals were missing. In Kleros v2, appeals are not run by the arbitrable: `KlerosCore.appeal` can only be called by the dispute kit, and the kit (`DisputeKitClassic.fundAppeal`) crowdfunds both answers itself (losing answer cost + 2×, first half of the appeal period; winning answer cost + 1×; contributors are paid by `withdrawFeesAndRewards`). Our contract only reads `isRuled`/`ruling` from the DisputeResolver, which are set when KlerosCore executes the final ruling after the last appeal period, so it already waited through appeals. What was missing was everything around it:

- **Owner console:** each disputed challenge shows its round, the jury's current vote, the appeal deadlines and how much each answer has raised (from `Contribution` events). New buttons: **Fund appeal** (either answer, any amount, defaults to what is missing; type APPEAL), **Deliver final ruling** (`passPeriod` + `executeRuling`, normally done by Kleros bots) and **Collect appeal rewards** (`withdrawFeesAndRewards`, with the 4-argument signature deployed on Arbitrum One and a fallback to the newer 3-argument one). Kleros errors are explained in plain words.
- **Guest page:** the lookup of a disputed challenge shows the same status, with an **Appeal** button for each answer that can still be funded.
- **Tests:** the Kleros mock now models KlerosCore's appeal views and a dispute kit with the same funding rules. A new contract test runs an appealed case (round 1 "absent", appeal funded by a crowd and the guest, round 2 "attended", final) and checks that nothing settles before the final ruling. Browser tests fund appeals from the console and the guest page and follow the case to the payout.
- **Juror policy:** a short "Appeals" section (only the final ruling counts; appeal fees are separate from the challenge deposits). This changes the file, so it has to be pinned again and `kleros.policyURI` updated before the deploy.

Tests now: 20 contract tests + the script end-to-end run (`npm test`, 21/21), 50 guest-page browser checks, 31 owner-console browser checks.

Please check: the appeal funding maths in `appealInfo` (console and site) against DisputeKitClassic, and the addresses read at runtime (`DisputeResolver.arbitrator()` → `KlerosCore.disputeKits(1)`).

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

**Tradeoffs the organiser accepted:** a fee of about 0.015 ETH per side; a matched challenge holds every payout for about 3 weeks (one Kleros round; each appeal adds another round, and everyone's payout waits for the final ruling); the juror policy (`docs/attendance-policy.md`, approved by the organiser) is pinned on IPFS at `/ipfs/Qmed2kuk17XbTeWG56UpWY8jThATEWzfWxgLAKqy5iLKsv` and set in `config.kleros.policyURI` (the live deploy refuses without one).

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
2. Developer review of `contracts/GroundTruthKickback.sol` and `console/index.html`.
3. Juror policy: the "Appeals" section changed the file, so it must be pinned again and the new path set in config.json (the old pin `/ipfs/Qmed2kuk17XbTeWG56UpWY8jThATEWzfWxgLAKqy5iLKsv` is the version without it). Deploy the live contract from `npm run console`, verify the source on Arbiscan (`build/GroundTruthKickback.standard-input.json`, compiler 0.8.28), record `contract`, `receiver`, `deployBlock` and `depositOpensAt` in `config.json`, and put the address on Luma while the event stays Private.
4. Go Public only when the organiser says so.
