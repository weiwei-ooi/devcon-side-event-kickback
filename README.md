# Truth Pays: Kickback-style deposits for Luma

Guests who want a guaranteed spot send a **$25 USDC refundable deposit**. Guests who show up get their deposit back, **plus an equal share of the no-shows' deposits**. Everyone else can still request a free spot, which the hosts approve by hand. A staker who was there but missed at check-in can challenge the attendance list on **Kleros**.

```
 Guest                       Organisers                              Contract (on-chain)
 ─────                       ──────────                              ───────────────────
 send 25 USDC ───────────────────────────────────────────────────▶  holds deposits
 register on Luma, paste
 wallet + tx link ─────────▶ verify-deposits.mjs ──▶ organiser approves / declines on Luma
                                                ├─▶ approved: registerStakers()  ─▶ public staker list
                                                └─▶ declined: rejectAndRefund()  ─▶ 25 USDC straight back
 check in at the door ─────▶ Luma check-in app
                             build-payout.mjs ─────▶ postAttendance(attendees, share)
                                                     │  1 day: a staker left off the list can challenge() (ETH deposit = Kleros fee)
                                                     │  1 day: anyone can matchChallenge() → Kleros dispute; unmatched = attended
                                                     │  Kleros: evidence, votes, appeals (funded on Kleros), final ruling → resolveChallenge()
                                                     ▼
                             anyone ───────────────▶ releasePayouts() once no challenge waits for a match
                                                     ─▶ pool ÷ (attendees + open cases); one share set aside per open case
```

**Example:** 100 stakers make a 2,500 USDC pool. If 80 show up, each of them gets **31.25 USDC** back: their own 25 plus 6.25 from the no-shows.

## What's here

| File | What it does |
|---|---|
| `contracts/TruthPaysKickback.sol` | Holds the deposits, keeps a public staker list, publishes the attendance list, runs the Kleros challenge window, and splits the pool equally among attendees. It also refunds declined guests, handles cancellation (full refunds), returns mistaken transfers (spare money only), keeps failed payouts for the guest to claim, lets stakers withdraw their own deposit if the organiser never posts the attendance list, and sweeps rounding dust after settlement. |
| `scripts/verify-deposits.mjs` | Reads the Luma guest CSV and checks every pasted tx on-chain: correct token, correct receiver, sent from the guest's wallet, at least $25, inside the deposit window, and not reused. It also lists deposits that nobody claimed. |
| `scripts/build-payout.mjs` | Matches the Luma check-in export (plus an optional manual list) against the stakers and computes each payout. |
| `scripts/owner.mjs` | Sends the owner transactions directly, if the owner is a normal wallet. |
| `scripts/deploy.mjs` | Deploys the contract. |
| `console/` + `scripts/console.mjs` | The owner console: a local page where the organiser clicks buttons and confirms in her wallet. |
| `site/index.html` + `scripts/build-site.mjs` | The public guest deposit page: switches the wallet to Arbitrum One, checks the contract, sends exactly 25 USDC and gives the tx link for Luma. See "Guest deposit page". |
| `docs/attendance-policy.md` | The policy Kleros jurors apply in an attendance dispute. Pinned on IPFS at `/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg` (set as `kleros.policyURI` in config.json; check it at https://cdn.kleros.link/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg). If the file changes, it must be uploaded again and the new path set before the deploy. |
| `test/` | Contract tests (guards, blocklisted wallets, odd tokens, 150 guests, every challenge path with a mock Kleros), an end-to-end test of the scripts on a local chain, and browser tests of the guest page and the owner console. |

All the owner transactions are also written out as **Safe Transaction Builder** files (`out/safe-*.json`), so a Kleros or Arkiv Safe can own the contract and sign the payouts.

## Setup

```bash
npm install
npm run compile
npm test            # ~4 min, runs on a local in-memory chain
cp -n config.example.json config.json   # only if config.json is missing; then fill it in
```

### Owner console (no code, no private keys)

```bash
npm run console      # opens http://localhost:8787
```

The owner console is a local page: **Connect wallet**, **Deploy contract**, **Register stakers**, **Refund declined guests**, **Post attendance list** and, after the challenge window, **Release payouts** (with a challenge list, **Add to the list**, **Dispute** and **Settle** in between), plus (folded away) remove-and-refund one guest, return a stray transfer, collect leftovers and cancel. Every button simulates the transaction first and explains any problem in plain words before the wallet opens; reads and fee estimates go through the public RPC so the wallet only signs. A banner shows whether it is LIVE, a REHEARSAL (optional `poolCap` safety cap) or a test network.

### Developer alternative (private key in the environment)

Deploy once. The deployer only pays gas, and the Safe becomes the owner:

```bash
PRIVATE_KEY=0x… node scripts/deploy.mjs --owner 0xYourSafe   # uses eventStart / claimDeadline from config
```

Put the deployed address in `config.json` as **both** `receiver` and `contract`, the deploy block as `deployBlock` (used to find deposits nobody claimed), set `depositOpensAt` to the deploy time, and share the address as the deposit address. Verify the source on Arbiscan (Solidity 0.8.28, optimizer on, 200 runs, EVM `paris`) so guests can use `claim` / `emergencyWithdraw` from Arbiscan's "Write contract" tab if they ever need to.

> **Without the contract:** set `receiver` to a Safe and leave out `contract`. Verification works the same way, and `build-payout.mjs` writes a batched Safe transaction of USDC transfers instead of a `postAttendance()` call (no Kleros challenges then).

## Luma setup

1. **Ticket types** (all free on Luma, since the money moves on-chain):
   - `Committed Spot ($25 USDC refundable deposit)`: requires approval. You approve it once the script verifies the deposit.
   - `Request to Join (Free)`: requires approval and is curated by hand.
2. **Registration questions:** Turn on the built-in `ETH Address` field. Add a text question named `Deposit tx link`, so the column header contains "tx" or "transaction". If your names differ, set them in `config.columns`, for example `{ "tx": "Your question text", "wallet": "eth_address" }`.
3. **Exporting:** Go to Guests → Export CSV whenever you want to verify. After the event, export again; the `checked_in_at` column is filled for everyone scanned at the door.

## Running it

**During registration** (re-run as often as you like; it skips anyone already registered):

```bash
node scripts/verify-deposits.mjs --guests ~/Downloads/luma-guests.csv --scan-from-block <deploy block>
```

- `out/verified.csv`: every verified payer, with their Luma decision and on-chain status.
- `out/to-review.csv`: verified payers waiting for your approve / decline on Luma.
- `out/new-stakers.json`: approved and verified, not yet registered (console: **Register stakers**).
- `out/refunds.json`: declined payers whose deposit is still held (console: **Refund declined guests**).
- `out/issues.csv`: email these guests. The codes are explained below.
- `out/unmatched.csv`: deposits that arrived but that no registration's own wallet claims (amount still to return, net of returns already made). A deposit pasted on Luma by a guest whose wallet did not send it (`WRONG_SENDER`, `UNUSUAL_SENDER`, `AMBIGUOUS_SENDER`) is listed here too, with a note naming the guest: sort it out with them before returning it.
- `out/returns.csv`: every other amount to give back with **Return a stray transfer**: short payments, overpaid excess, late payers not declined, a second deposit from the same wallet, paid-again declines, partly returned deposits. Net of what was already returned, so nothing is asked twice.
- `out/claims.csv`: every Luma row that verified a wallet (duplicates included); `build-payout.mjs` uses it to match check-ins.

All output files are deleted at the start of each run, so a failed run never leaves stale lists. On a real network (`mode` set in the config) the script refuses to run without `deployBlock` or `--scan-from-block`. Deposits already returned (declined, or **Return a stray transfer**) are never listed for registration or refund again (`RETURNED_EARLIER`).
- `out/safe-register.json`: upload this in Safe → Apps → Transaction Builder, or run `node scripts/owner.mjs register`.

**After the event:**

```bash
node scripts/build-payout.mjs --checkins ~/Downloads/luma-guests-after.csv [--extra-checkins door-list.csv]
```

- `out/payout-summary.md`: the numbers to post publicly.
- `out/payout-plan.json`: the attendee list and per-person share that **Post attendance list** sends; it refuses if the on-chain numbers changed.
- `out/safe-post-attendance.json`: upload and sign this, or run `node scripts/owner.mjs post-attendance`.
- **Challenge window (1 day after posting):** watch the challenge list in the console. If a challenger really was there (you recognise them, a host saw them), click **Add to the list** before anyone matches: their ETH deposit goes back and no Kleros case is needed. Once a challenge is matched, the Kleros case runs and **Add to the list** is refused for that wallet. If you then realise they were there, say so in the case with **Send evidence to the Kleros jurors** (the policy tells jurors to rule "attended" when the organiser confirms it). If you are sure they were not there, **Dispute** sends the case to Kleros (0.015 ETH from your wallet; jurors take about 3 weeks). Otherwise do nothing: an unmatched challenge counts as attended after 1 day. If the Kleros fee more than doubles within a challenge's 1-day match window, the match is refused and the challenge counts as attended.
- **Kleros appeals:** after each jury vote the challenge list shows the vote, the appeal deadline and how much ETH each answer has raised. Either side (or anyone) can **Fund appeal** for an answer; the answer that lost the vote needs the appeal fee + 2× and only has the first half of the window, the answer that won needs the fee + 1×. When both are fully funded, a larger jury votes again (about 3 more weeks). If the window ends with no funded appeal, the vote is final: **Deliver final ruling** (Kleros's bots usually do it), then **Settle**. Appeal money goes straight from the funder's wallet to Kleros's dispute kit (`DisputeKitClassic.fundAppeal`), never through the deposit contract, so Kleros records each funder and pays refunds and rewards to them directly (Kleros's bots usually do this on their own; **Collect appeal rewards** does it by hand).
- **Defend every appeal (important):** if the other side funds an appeal and yours is not fully funded when the window closes, the other side wins the case, whatever the jurors voted. After each vote, check the challenge list until the appeal window ends. If the other side starts funding, fund yours: about 0.07 ETH when the vote went your way, or about 0.105 ETH within the first half of the window when it went against you or was tied (the console shows the exact amounts and deadlines). Money for a side that ends up fully funded and winning comes back with a reward; money for a side never fully funded comes back.
- **Evidence:** while a case is open, **Send evidence to the Kleros jurors** (console) or the evidence box on the guest page sends a title, a description and an optional file link to Kleros's EvidenceModule, filed under the case's DisputeResolver ID (the `_externalDisputeID` the Kleros court uses to show evidence). It is public and permanent.
- **Release payouts:** once the window is over and no challenge is still waiting for a match, click **Release payouts** (anyone can, so guests are not stuck if the owner wallet is lost). A challenge opened at the last minute keeps its own 1-day match window, so payouts can start up to one day after the challenge window ends. A Kleros case does not hold the payout: share per person = pool ÷ (attendees + open Kleros cases). Everyone on the list is paid at once and one share per open case is set aside (shown in the console). When a case is settled, that share goes to the challenger if Kleros rules they attended; otherwise it is split equally among everyone on the list and the cases still open (their part is added to what is set aside for them), so everyone who ends up on the list gets the same total whatever order the cases finish in.
- **Before paying out:** decline on Luma every payer who is still pending or waitlisted, and every late (`OUTSIDE_WINDOW`) payer you won't admit; re-run verify and click **Refund declined guests**. Then return everything in `out/returns.csv` (short payments, overpaid excess, strays) with **Return a stray transfer**, so nobody's money is left behind as "spare".
- When it's done, click **Collect leftovers** in the console (it refuses to quietly sweep anything that looks like a guest's deposit).

**If the event is cancelled:** click **Cancel event and refund registered stakers** in the console (it is refused once the list is posted). Every registered staker gets their 25 USDC back. Payers who were not registered yet are not covered by Cancel: decline them all on Luma, re-run verify, click **Refund declined guests**, and return what `out/returns.csv` and `out/unmatched.csv` list with **Return a stray transfer**.

(`scripts/owner.mjs`, `scripts/deploy.mjs` and the `out/safe-*.json` files do the same from the command line or a Safe, for developers. The organiser never needs a private key.)

### Issue codes

| Code | Meaning | What to do |
|---|---|---|
| `NO_TX` / `BAD_TX_HASH` | No tx link, or the answer has no 0x… hash | Ask the guest for the link |
| `TX_NOT_FOUND` | The tx isn't on the configured chain | They most likely sent on Ethereum mainnet (an etherscan.io link) or another network. Ask them to send 25 USDC again **on Arbitrum One**. Their first transfer did not reach the contract, so we can't refund it from there. Getting it back is possible only case by case (see below). |
| `NO_DEPOSIT_TRANSFER` | The tx doesn't send USDC to the deposit address | Wrong token or wrong address |
| `WRONG_SENDER` | The USDC came from a different wallet than the one they entered | If the sender is their own wallet, ask them to put that address as their ETH address on Luma; it then verifies. If it came from an exchange or someone else, it can't hold a spot (refunds and payouts would go to that sender): the money is listed in `out/unmatched.csv` to return to the sender once agreed, and they send a new 25 USDC from their own wallet. |
| `AMBIGUOUS_SENDER` | No wallet given, and the tx has several senders | Ask the guest which wallet is theirs and to add it on Luma. Until then the money is listed in `out/unmatched.csv`. |
| `TX_FAILED` | The pasted tx reverted, so no money arrived | Ask for a new 25 USDC transfer on Arbitrum One and its link |
| `RPC_ERROR` | The script could not read that tx (a network problem on our side) | Don't email the guest; re-run verify |
| `AMOUNT_TOO_LOW` | They sent less than 25 | Return it (listed in `out/returns.csv`) and ask for one new transfer of exactly 25 USDC. A top-up in a second transaction can't be verified. |
| `OUTSIDE_WINDOW` | Sent before deposits opened or after the deadline | Decide case by case |
| `DUPLICATE_TX` / `DUPLICATE_WALLET` | The tx or wallet is already used by another guest | Likely a copy-paste or someone gaming the system. The row whose wallet sent the deposit (or is already registered) keeps it; a declined copy never wins. No on-chain action for the copy. |
| `DUPLICATE_CLAIM` | Several rows that aren't declined claim the same deposit and the script can't tell which is real | Decide by hand: decline the copy on Luma and re-run verify |
| `REFUNDED_EARLIER` / `RETURNED_EARLIER` | This deposit was already refunded (declined) or returned with **Return a stray transfer** | Never registered or refunded again. They need to send a new deposit. |
| `UNUSUAL_SENDER` | No wallet given (or 0x0), and the USDC came from a contract or was minted by a bridge | If it is their own smart wallet (e.g. a Safe), they put that address on Luma and it verifies. Otherwise it can't hold a spot: it is listed in `out/unmatched.csv` (never send it back to 0x0 or a bridge; find out with the guest where it should go), and they send a new 25 USDC from their own wallet. |
| `OVERPAID` | They sent more than 25 | Registered normally; the excess is listed in `out/returns.csv` |
| `REGISTERED_NOT_APPROVED` | Registered on-chain but no longer approved on Luma | Approve again, or decline to refund (only possible before the attendance list is posted) |
| `DECLINED_AFTER_LIST` | Registered, no longer approved on Luma, and the attendance list is already posted | Nothing to do: the contract can't refund a staker any more, so they are not in `refunds.json`. Their deposit stays in the pool; they are paid only if they are on the list. |
| `PAID_AGAIN_DECLINED` | Declined, refunded once already, then paid again and declined again | Not in the refund list (`rejectAndRefund` would refuse the whole batch). Return the new deposit with **Return a stray transfer** (`refund(wallet, 25 USDC)`); the issue disappears once it has been returned. |

A copied tx link does not knock out the real guest: the wallet that sent the deposit (or is already registered) keeps it, and the copy is flagged. `out/returns.csv` lists every amount still to give back with **Return a stray transfer** (net of anything already returned), and is rewritten on every run.

**Wrong network (USDC sent on Ethereum mainnet to the contract address):** the money sits at that address on Ethereum, where no contract exists. The only way to recover it is to deploy the same contract on Ethereum from the owner wallet at the same nonce, so that it lands at the same address, then `refund` it from there. This costs Ethereum gas and only works while the owner wallet has made fewer Ethereum mainnet transactions than that nonce. So **don't use the owner wallet on Ethereum mainnet** before settlement. Decide case by case.

## Guest deposit page

`site/index.html` is a single static page for guests, with no dependencies and no build step beyond baking in the address:

1. Connect wallet (any injected wallet; on phones, the wallet app's own browser).
2. Switch to Arbitrum One (`wallet_switchEthereumChain`, adds the network if missing). Sending is blocked on any other network, and the network is checked again right before the wallet prompt.
3. Check balance: at least 25 USDC and some ETH on Arbitrum One. It also refuses a second deposit from a wallet that already has one or is already registered.
4. Send exactly 25 USDC (a plain `USDC.transfer(contract, 25e6)`), wait for the receipt.
5. Copy the Arbiscan tx link and wallet address for Luma.

Before enabling the send button, the page reads the contract over the public RPC and checks there is code at the address, that `token()` is native USDC, that `deposit()` is exactly 25 USDC, and that `phase()` is Open with `eventStart` in the future. A "Check a deposit" box shows any wallet's status (received, confirmed, refunded, on the list, challenged, in a Kleros case, paid, no-show) and lets a guest `claim` an undeliverable payout, `emergencyWithdraw` after the deadline, or `withdrawEth` a challenge refund that could not be sent.

After the list is posted, the same box is how challenges work: a staker left off the list sees **Challenge** (pays `challengeDeposit()` in ETH); anyone looking up a challenger sees **Dispute this claim** (matches the deposit, creating the Kleros case) and later **Settle**. An "Open challenges" list shows who challenged, with a link to each Kleros case for evidence. While a case is in its appeal window, the lookup shows the jury's vote, the deadlines and how much each answer has raised, with one-click **Appeal** buttons for each answer that can still be funded (paid from the guest's own wallet straight to Kleros), and **Collect my appeal rewards** once the case is over. Once the challenge window is over, anyone can press **Release payouts** there too.

The deposit address is compiled into the page (`npm run site` writes `site/dist/index.html` from `config.json`); it is never read from the URL, so a look-alike link can't redirect deposits. Re-run after deploying. `npm run site -- --preview` builds a page without an address. Browser test: `npm run test:site` (needs Playwright: `npm i --no-save playwright && npx playwright install chromium`).

## Trust model

This setup isn't trustless, but anyone can check it:

- **Deposits:** Every deposit and every registered staker is public on-chain (`StakerRegistered` events and `stakers()`).
- **The pool:** `refund` and `sweep` can only move *spare* money: balance above the staked pool and unclaimed payouts. Declined guests are refunded exactly their deposit, to their own wallet.
- **Attendance:** The organiser publishes who attended (`postAttendance`), based on the Luma check-in, with the exact per-person share she confirmed. A staker left off the list has 1 day to challenge; anyone has 1 day to match, which creates a Kleros dispute decided by jurors under `docs/attendance-policy.md`. An unmatched challenge counts as attended. `releasePayouts` (callable by anyone) pays out after the window once no challenge waits for a match; a share per open Kleros case is set aside until its final ruling, so no one can freeze everyone's payout by disputing or appealing.
- **Kleros integration:** permissionless, through Kleros v2's `DisputeResolver` on Arbitrum One (`0xb5526D022962A1fFf6eD32C93e8b714c901F4323`): KlerosCore only accepts whitelisted arbitrables, and the DisputeResolver is the whitelisted, open entry point. The contract sends its own dispute template (event, wallet, question, policy) and reads the ruling back from `disputes(localID)`. Defaults: General Court, 3 jurors, classic dispute kit; fee about 0.015 ETH, paid in ETH (USDC is not accepted). A round takes about 3 weeks (evidence, commit, vote, appeal periods), and appeals can add rounds.
- **Appeals:** handled entirely by Kleros. In Kleros v2 only the dispute kit can appeal (`KlerosCore.appeal` is restricted to it), so appeals are crowdfunded with `DisputeKitClassic.fundAppeal(disputeID, choice)` (Arbitrum One proxy `0x70B464be85A547144C72485eBa2577E5D3A45421`, found at runtime via `KlerosCore.disputeKits(1)`). Losing answer: appeal cost + 2×, first half of the appeal period only; winning answer: cost + 1×; a new round starts once both are funded. Contributors withdraw with `withdrawFeesAndRewards`. The DisputeResolver records `isRuled` only when KlerosCore executes the final ruling, after the last appeal period, so `resolveChallenge` and `releasePayouts` can never act on a vote that is later overturned. No appeal money passes through this contract (it has no `receive()`, so plain ETH sent to it by mistake is refused). The console and guest page read the round, current ruling, `appealPeriod`, `appealCost`, `getFundedChoices` and `Contribution` events, and offer funding and reward withdrawal; the console also offers `passPeriod` + `executeRuling` (**Deliver final ruling**, normally done by Kleros bots).
- **Challenge money:** both sides put in the same ETH. The Kleros fee comes out of the two deposits; the winner gets the rest (split if jurors refuse to arbitrate). ETH that cannot be sent is kept for `withdrawEth`.
- **Deadlines:** the list can be posted from `eventStart`. If no list is posted by `claimDeadline` (at least 7 days later), every staker can withdraw their own deposit, so a lost owner key cannot lock the pool. Once the list is posted, payouts no longer depend on the owner.
- **Failed transfers:** if USDC refuses a payout (blocklisted address), the amount is kept for that guest to `claim` to another address; nobody else is blocked.
- **Known limits:** balances are counted in total, not per wallet, so the organiser must only register wallets the verify script lists. Unregistered payers depend on the organiser to refund them. The owner is a single wallet (no multisig), by the organiser's choice. A matched challenge holds only that challenger's share until Kleros's final ruling (about 3 weeks per round; each appeal adds a round, up to several months). If Kleros never rules on a case (for example, the DisputeResolver's arbitrator is changed mid-case), that one set-aside share stays locked; everything else is paid. `emergencyWithdraw` only applies when no list was posted.

## Guest instructions (for the Luma page)

> **Committed Spot: $25 refundable deposit**
> ⚠️ **Network: Arbitrum One only, NOT Ethereum mainnet.** Most wallets open on Ethereum mainnet by default. Switch your wallet to **Arbitrum One** (chain ID 42161) *before* you send. USDC sent on Ethereum mainnet or any other network does not reach the deposit contract, and we can't promise to get it back.
>
> 1. Send **exactly 25 USDC (native USDC) on Arbitrum One** to `<contract address>`, **from your own wallet**, before **Wed 4 Nov, 18:00 IST**. Don't send it from an exchange, because the refund goes back to that wallet.
> 2. Register with the *Committed Spot* ticket. Enter that wallet address and paste the transaction link. It should start with **https://arbiscan.io/tx/**. If your link starts with etherscan.io, you sent it on the wrong network.
> 3. Every registration is reviewed. If you are declined or not admitted from the waitlist, your 25 USDC goes back to the same wallet.
> 4. If you don't check in, you lose your 25 USDC. If the organisers never post the attendance list, you can withdraw it yourself after 18 Nov.
> 5. Check in at the door. After the event, everyone who showed up gets their 25 USDC back, plus an equal share of the no-shows' deposits. If your registration is declined, your 25 USDC is sent back to the same wallet.
> 6. **Missed at check-in?** The attendance list is published on-chain after the event. If you were there but are not on it, you have 1 day to challenge it from the deposit page with a small ETH deposit (the Kleros fee, about 0.015 ETH). If nobody disputes it within a day, you count as attended and get the ETH back. If someone does, independent Kleros jurors decide from the evidence (photos, messages, hosts' statements). Either side can appeal the jurors' vote to a larger jury from the same page. If one side funds an appeal and the other doesn't, the funded side wins, so watch your case until the final ruling. Everyone else is paid on time; only the challenger's share waits for the final ruling.
