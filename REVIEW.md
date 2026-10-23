# Ground Truth Kickback v2: review summary (23 Oct 2026, deposit 25 USDC on Arbitrum One)

For Wei Wei and the developers reviewing the code before the live deployment.

## What changed since the rehearsal (v1)

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
- Attendance is decided by the organiser from the Luma check-in; publish `payout-summary.md` and the payout transaction.

## Before going live

1. Short v2 rehearsal on Arbitrum One (`npm run console:rehearsal`, 500 USDC cap, throwaway contract).
2. Developer review of `contracts/GroundTruthKickback.sol` and `console/index.html`.
3. Deploy the live contract from `npm run console`, verify the source on Arbiscan (`build/GroundTruthKickback.standard-input.json`, compiler 0.8.24), record `contract`, `receiver`, `deployBlock` and `depositOpensAt` in `config.json`, and put the address on Luma while the event stays Private.
4. Go Public only when the organiser says so.
