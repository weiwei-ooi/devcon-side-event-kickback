# Truth Pays: Kickback-style deposits for Luma

Guests who want a guaranteed spot send a **refundable deposit in ETH on Ethereum mainnet** (the amount is `deposit` in `config.json`: 0.01 ETH for now, about $23 on 27 Oct 2026). Guests who show up get their deposit back, **plus an equal share of the no-shows' deposits**. Everyone else can still request a free spot, which the hosts approve by hand. A staker who was there but missed at check-in can challenge the attendance list on **Kleros**.

```
 Guest                       Organisers                              Contract (Ethereum mainnet)
 ─────                       ──────────                              ───────────────────────────
 send the ETH deposit ───────────────────────────────────────────▶  holds deposits (Deposited event)
 register on Luma, paste
 wallet + tx link ─────────▶ verify-deposits.mjs ──▶ organiser approves / declines on Luma
                                                ├─▶ approved: registerStakers()  ─▶ public staker list
                                                └─▶ declined: rejectAndRefund()  ─▶ deposit straight back
 check in at the door ─────▶ Luma check-in app
                             build-payout.mjs ─────▶ postAttendance(attendees, share)
                                                     │  1 day: a staker left off the list can challenge() (ETH deposit = Kleros fee)
                                                     │  1 day: anyone can matchChallenge() → Kleros case; unmatched = attended
                                                     │  Kleros Court: evidence, votes, appeals (funded on Kleros), final ruling → resolveChallenge()
                                                     ▼
                             anyone ───────────────▶ releasePayouts() once no challenge waits for a match
                                                     ─▶ pool ÷ (attendees + open cases); one share set aside per open case
```

**Example (with a 0.01 ETH deposit):** 100 stakers make a 1 ETH pool. If 80 show up, each of them gets **0.0125 ETH** back: their own 0.01 plus 0.0025 from the no-shows.

## What's here

| File | What it does |
|---|---|
| `contracts/TruthPaysKickback.sol` | Takes the ETH deposits, keeps a public staker list, publishes the attendance list, runs the Kleros challenge window, and splits the pool equally among attendees. It also refunds declined guests, handles cancellation (full refunds), returns mistaken transfers (spare ETH only), sends back tokens (USDC, for example) sent to it by mistake (`returnToken`, which never moves ETH), keeps failed payments for the guest to claim, lets stakers withdraw their own deposit if the organiser never posts the attendance list, and sweeps rounding dust after settlement. |
| `scripts/verify-deposits.mjs` | Reads the Luma guest CSV and checks every pasted tx against the contract's `Deposited` events: ETH sent to the deposit contract, from the guest's wallet, at least the deposit amount, inside the deposit window, and not reused. It also lists deposits that nobody claimed. |
| `scripts/build-payout.mjs` | Matches the Luma check-in export (plus an optional manual list) against the stakers and computes each payout. |
| `scripts/owner.mjs` | Sends the owner transactions directly, if the owner is a normal wallet (developers only). |
| `scripts/deploy.mjs` | Deploys the contract (developers only). |
| `console/` + `scripts/console.mjs` | The owner console: a local page where the organiser clicks buttons and confirms in her wallet. |
| `site/index.html` + `scripts/build-site.mjs` | The public guest deposit page: switches the wallet to Ethereum mainnet, checks the contract, sends exactly the deposit and gives the Etherscan tx link for Luma. See "Guest deposit page". |
| `docs/attendance-policy.md` | The policy Kleros jurors apply in an attendance case. **Not pinned yet for this version**: pin it on IPFS before the live deploy (see "Pinning the juror policy and the case description"). |
| `docs/metaevidence.json` | The case description Kleros shows for every attendance case (ERC-1497 "metaevidence": question, answers, link to the policy). Pinned on IPFS after the policy, before the live deploy. |
| `test/` | Contract tests against a local copy of Kleros Court v1 and its Dispute Resolver (guards, wallets that refuse ETH or burn gas, reentrancy, 150 guests, a payout to 150 gas-burning wallets inside one transaction's gas cap, tokens sent by mistake, every challenge and appeal path), an end-to-end test of the scripts on a local chain, and browser tests of the guest page and the owner console. |

All the owner transactions are also written out as **Safe Transaction Builder** files (`out/safe-*.json`), for developers who want a Safe to own the contract. The organiser's own setup uses her dedicated Zerion wallet, not a Safe.

## Setup

```bash
npm install
npm run compile
npm test            # ~4 min, runs on a local in-memory chain
cp -n config.example.json config.json   # only if config.json is missing; then fill it in
```

There are two configs:

- `config.json`: the **live** event (`"mode": "live"`).
- `config.rehearsal.json`: a **rehearsal** on Ethereum mainnet with a throwaway contract that is never put on Luma (`"mode": "rehearsal"`, `poolCap` 0.25 ETH safety cap). Run it with `npm run console:rehearsal`.

Both use `"chain": "ethereum"` (chain ID 1, explorer etherscan.io) and the public RPC `https://rpc.mevblocker.io`. Free public RPCs only return old event logs in small pieces, so the scripts read logs in chunks of `logChunk` blocks (5,000 by default) and retry when a request fails. The earlier Arbitrum Sepolia test-network mode (`config.testnet.json`) has been removed.

### Owner console (no code, no private keys)

```bash
npm run console      # opens http://localhost:8787
```

The owner console is a local page: **Connect wallet**, **Deploy contract**, **Register stakers**, **Refund declined guests**, **Post attendance list** and, after the challenge window, **Release payouts** (with a challenge list, **Add to the list**, **Dispute** and **Settle** in between), plus (folded away) remove-and-refund one guest, return a stray transfer, return tokens sent by mistake, collect leftovers and cancel. Every button simulates the transaction first and explains any problem in plain words before the wallet opens; reads and fee estimates go through the public RPC so the wallet only signs. The gas limit is the estimate plus 30%, never above 16,777,216 (2^24), the most one Ethereum transaction may use since EIP-7825 (Fusaka). **Register stakers** and **Refund declined guests** refuse a list made for another deposit amount than the contract's (the lists carry the deposit they were checked against). A banner shows whether it is LIVE or a REHEARSAL.

**The owner wallet needs a little ETH on Ethereum mainnet** for network fees. Fees were very low on 27 Oct 2026 (about 0.04 gwei), but they can rise; keep about 0.05 ETH on it, plus the Kleros fee (about 0.0162 ETH today) for each challenge she disputes, and appeal money if a case is appealed.

### Developer alternative (private key in the environment)

Deploy once. The deployer only pays gas, and the given wallet becomes the owner:

```bash
PRIVATE_KEY=0x… node scripts/deploy.mjs --owner 0xOwnerWallet   # uses eventStart / claimDeadline from config
```

Put the deployed address in `config.json` as **both** `receiver` and `contract`, the deploy block as `deployBlock` (used to find deposits nobody claimed), set `depositOpensAt` to the deploy time, and share the address as the deposit address. Verify the source on Etherscan (Solidity 0.8.28, optimizer on, 200 runs, EVM `paris`) so guests can use `claim` / `emergencyWithdraw` from Etherscan's "Write contract" tab if they ever need to.

## Pinning the juror policy and the case description

Kleros shows jurors one **case description** (`docs/metaevidence.json`, an ERC-1497 "metaevidence" file) for every attendance case, and that file links to the **juror policy** (`docs/attendance-policy.md`). Both are fixed in the contract when it is deployed: changing them later needs a new contract. Before the live deploy:

1. Upload `docs/attendance-policy.md` through Kleros's IPFS upload service (`https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs`, the same service Kleros's own apps use). Check the file at `https://cdn.kleros.link/ipfs/<cid>` and that it is byte-identical.
2. Put that path (`/ipfs/<cid>`) as `fileURI` in `docs/metaevidence.json` (it says `/ipfs/REPLACE_WITH_POLICY_PIN` until then), upload the JSON the same way and check it.
3. Set both paths in `config.json` under `kleros`: `policyURI` and `metaEvidenceURI`.

The deploy refuses in live mode until both look like `/ipfs/…` paths, and it refuses the old Arbitrum/USDC policy pin (`/ipfs/QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg`), which describes the earlier version. A rehearsal can be deployed without them, but a challenge matched in a rehearsal would open a **real** Kleros case with whatever description is set (see "Rehearsal" below).

## Luma setup

1. **Ticket types** (all free on Luma, since the money moves on-chain):
   - `Committed Spot` with the deposit in its name (for example "Committed Spot (0.01 ETH refundable deposit)"): requires approval. You approve it once the script verifies the deposit.
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

All output files are deleted at the start of each run, so a failed run never leaves stale lists. On a real network (`mode` set in the config) the script refuses to run without `deployBlock` or `--scan-from-block`. It also stops, listing nothing, if `deposit` in the config is not the amount the contract was deployed with (`depositAmount()`): every check of a payment uses it. Deposits already returned (declined, or **Return a stray transfer**) are never listed for registration or refund again (`RETURNED_EARLIER`).
- `out/safe-register.json`: for developers using a Safe (Transaction Builder), or `node scripts/owner.mjs register`.

The contract only accepts ETH while deposits are open (before the attendance list is posted, and not after a cancellation). ETH sent later is refused by the contract and stays in the sender's wallet (they only pay the network fee).

**After the event:**

```bash
node scripts/build-payout.mjs --checkins ~/Downloads/luma-guests-after.csv [--extra-checkins door-list.csv]
```

- `out/payout-summary.md`: the numbers to post publicly.
- `out/payout-plan.json`: the attendee list and per-person share that **Post attendance list** sends; it refuses if the on-chain numbers changed.
- `out/safe-post-attendance.json`: for developers using a Safe, or `node scripts/owner.mjs post-attendance`.
- **Challenge window (1 day after posting):** watch the challenge list in the console. If a challenger really was there (you recognise them, a host saw them), click **Add to the list** before anyone matches: their ETH deposit goes back and no Kleros case is needed. Once a challenge is matched, the Kleros case runs and **Add to the list** is refused for that wallet. If you then realise they were there, say so in the case by sending evidence (the policy tells jurors to rule "Attended" when the organiser confirms it). If you are sure they were not there, **Dispute** sends the case to Kleros (the same ETH deposit as the challenger, about 0.0162 ETH today, from your wallet; one round takes about 3 weeks). Otherwise do nothing: an unmatched challenge counts as attended after 1 day. If the Kleros fee more than doubles within a challenge's 1-day match window, the match is refused and the challenge counts as attended.
- **Challenge details (right after a match):** every case shows jurors the same general description, so they need to be told which wallet the case is about. Right after a match the console offers to send a "Challenge details" evidence (deposit contract, wallet, Kleros case number, with Etherscan links). Send it: it is how jurors find the wallet (they can also check the contract's `Challenged` and `ChallengeMatched` events on Etherscan).
- **Kleros appeals:** after each jury vote the challenge list shows the vote, the appeal deadlines and how much ETH each answer has raised. Either side (or anyone) can fund an answer. The answer the jurors voted for needs the appeal fee + 100% and can be funded until the end of the appeal period (108 hours in the General Court); any other answer (both, after a tie or a refusal) needs the fee + 200% and only has the first half of the period. When both are fully funded, a larger jury votes again (about 3 more weeks). If the period ends without both answers fully funded, the case is over: the vote stands, unless exactly one answer was fully funded, which then wins. Then the final ruling is delivered to the contract (often done by Kleros's own bots; the console can do it too), and **Settle**. Appeal money goes straight from the funder's wallet to Kleros's Dispute Resolver (`fundAppeal`), never through the deposit contract, so Kleros records each funder and pays refunds and rewards to them directly; each funder collects them once the case is over (the console and the guest page offer this).
- **Defend every appeal (important):** if the other side funds an appeal and yours is not fully funded when the period closes, the other side wins the case, whatever the jurors voted. After each vote, check the challenge list until the appeal period ends. If the other side starts funding, fund yours. For a first appeal at today's fees (7 jurors at about 0.0054 ETH each, so an appeal fee of about 0.0378 ETH) that is about 0.076 ETH when the vote went your way, or about 0.113 ETH within the first half of the period when it went against you or was tied; the console shows the exact amounts and deadlines. Money for a side that ends up fully funded and winning comes back with a reward; money for a side never fully funded comes back. **Fund appeals from a normal wallet (like Zerion), not a Safe or other smart-contract wallet:** the Dispute Resolver sends refunds, rewards and any overpayment with a basic transfer and does not retry if it fails, so a smart-contract wallet could lose them.
- **Evidence:** while a case is open, the console or the guest page uploads a short evidence file (title, description, optional file link) to Kleros's IPFS service and sends its path to the Dispute Resolver (`submitEvidence`, filed under the case's Dispute Resolver number), from the sender's own wallet. It is public and permanent. Send it early: jurors start voting after the evidence period (78 hours in the General Court), and evidence is refused once the case is ruled.
- **Release payouts:** once the window is over and no challenge is still waiting for a match, click **Release payouts** (anyone can, so guests are not stuck if the owner wallet is lost). A challenge opened at the last minute keeps its own 1-day match window, so payouts can start up to one day after the challenge window ends. A Kleros case does not hold the payout: share per person = pool ÷ (attendees + open Kleros cases). Everyone on the list is paid at once and one share per open case is set aside (shown in the console). When a case is settled, that share goes to the challenger if Kleros rules they attended; otherwise it is split equally among everyone on the list and the cases still open (their part is added to what is set aside for them), so everyone who ends up on the list gets the same total whatever order the cases finish in.
- **Before paying out:** decline on Luma every payer who is still pending or waitlisted, and every late (`OUTSIDE_WINDOW`) payer you won't admit; re-run verify and click **Refund declined guests**. Then return everything in `out/returns.csv` (short payments, overpaid excess, strays) with **Return a stray transfer**, so nobody's money is left behind as "spare". (Declined payers can still be refunded after the list is posted, as long as they were never registered.)
- When it's done, click **Collect leftovers** in the console (it refuses to quietly sweep anything that looks like a guest's deposit; the contract itself never lets it touch anything still owed).

**If the event is cancelled:** click **Cancel event and refund registered stakers** in the console (it is refused once the list is posted). Every registered staker gets their deposit back. Payers who were not registered yet are not covered by Cancel: decline them all on Luma, re-run verify, click **Refund declined guests**, and return what `out/returns.csv` and `out/unmatched.csv` list with **Return a stray transfer**. After a cancellation the contract refuses new deposits.

(`scripts/owner.mjs`, `scripts/deploy.mjs` and the `out/safe-*.json` files do the same from the command line or a Safe, for developers. The organiser never needs a private key.)

### Issue codes

| Code | Meaning | What to do |
|---|---|---|
| `NO_TX` / `BAD_TX_HASH` | No tx link, or the answer has no 0x… hash | Ask the guest for the link |
| `WRONG_NETWORK` | The link is from another network (arbiscan.io, basescan.org, optimistic.etherscan.io and similar), not Ethereum mainnet | That ETH never reached the deposit contract, and the contract can't send it back (see "Wrong network"). Ask them to send a new deposit **on Ethereum mainnet** and paste its etherscan.io link. |
| `TX_NOT_FOUND` | The tx isn't on Ethereum mainnet | Most likely sent on another network, or a typo in the link. Ask the guest for their **etherscan.io** link; if it was another network, they send a new deposit on Ethereum mainnet. |
| `TX_PENDING` | Sent, but not confirmed yet | Nothing to do: re-run verify a bit later |
| `NO_DEPOSIT_TRANSFER` | The tx doesn't send ETH to the deposit contract | Wrong address, or they sent a token instead of ETH. If a token (USDC, for example) reached the deposit contract, the note names the token contract: it is not a deposit; send it back with **Return tokens sent by mistake** in the console and ask for a deposit in ETH. |
| `WRONG_SENDER` | The ETH came from a different wallet than the one they entered (often an exchange withdrawal) | If the sender is their own wallet, ask them to put that address as their ETH address on Luma; it then verifies. If it came from an exchange or someone else, it can't hold a spot (refunds and payouts would go to that sender): the money is listed in `out/unmatched.csv` to return to the sender once agreed, and they send a new deposit from their own wallet. |
| `AMBIGUOUS_SENDER` | No wallet given, and the tx has several senders | Ask the guest which wallet is theirs and to add it on Luma. Until then the money is listed in `out/unmatched.csv`. |
| `TX_FAILED` | The pasted tx failed, so no ETH arrived and the guest only paid the network fee (for example 0 ETH sent, sent after deposits closed, or a wallet that sent a plain transfer with a fixed 21,000 gas limit, which is too little for the contract's `Deposited` event: the note then says it ran out of gas) | Ask for a new deposit on Ethereum mainnet and its link (from the deposit page, or with the gas limit the wallet suggests) |
| `RPC_ERROR` | The script could not read that tx (a network problem on our side) | Don't email the guest; re-run verify |
| `AMOUNT_TOO_LOW` | They sent less than the deposit | Return it (listed in `out/returns.csv`) and ask for one new transfer of exactly the deposit amount in ETH (a wallet showing dollars may have rounded it). A top-up in a second transaction can't be verified. |
| `OUTSIDE_WINDOW` | Sent before deposits opened or after the deadline | Decide case by case |
| `DUPLICATE_TX` / `DUPLICATE_WALLET` | The tx or wallet is already used by another guest | Likely a copy-paste or someone gaming the system. The row whose wallet sent the deposit (or is already registered) keeps it; a declined copy never wins. No on-chain action for the copy. |
| `DUPLICATE_CLAIM` | Several rows that aren't declined claim the same deposit and the script can't tell which is real | Decide by hand: decline the copy on Luma and re-run verify |
| `REFUNDED_EARLIER` / `RETURNED_EARLIER` | This deposit was already refunded (declined) or returned with **Return a stray transfer** | Never registered or refunded again. They need to send a new deposit. |
| `UNUSUAL_SENDER` | No wallet given, and the ETH came from a contract (for example a smart wallet or an exchange's contract) | If it is their own smart wallet (e.g. a Safe), they put that address on Luma and it verifies. Otherwise it can't hold a spot: it is listed in `out/unmatched.csv` (find out with the guest where it should go), and they send a new deposit from their own wallet. |
| `OVERPAID` | They sent more than the deposit | Registered normally; the excess is listed in `out/returns.csv` |
| `REGISTERED_NOT_APPROVED` | Registered on-chain but no longer approved on Luma | Approve again, or decline to refund (only possible before the attendance list is posted) |
| `DECLINED_AFTER_LIST` | Registered, no longer approved on Luma, and the attendance list is already posted | Nothing to do: the contract can't refund a staker any more, so they are not in `refunds.json`. Their deposit stays in the pool; they are paid only if they are on the list. |
| `PAID_AGAIN_DECLINED` | Declined, refunded once already, then paid again and declined again | Not in the refund list (`rejectAndRefund` would refuse the whole batch). Return the new deposit with **Return a stray transfer** (`refund(wallet, deposit)`); the issue disappears once it has been returned. |

A copied tx link does not knock out the real guest: the wallet that sent the deposit (or is already registered) keeps it, and the copy is flagged. `out/returns.csv` lists every amount still to give back with **Return a stray transfer** (net of anything already returned), and is rewritten on every run.

**Wrong network (ETH sent on Arbitrum, Base, Optimism or another network to the contract address):** the deposit contract only exists on Ethereum mainnet. On another network the ETH lands at the same address, where our contract does not exist, so it never reaches the pool and we cannot refund it with the contract. Recovering it is only sometimes possible: the contract's address comes from the wallet that deployed it (the owner wallet, when deployed from the console) and that wallet's transaction count, so deploying a copy from the same wallet at the same transaction count on that network would land at the same address and could then `refund` it. This costs that network's fees and only works while the wallet's transaction count on that network has not yet passed the count it had on Ethereum when it deployed. The owner wallet was already used on Arbitrum One (rehearsals of the earlier version), so on Arbitrum One that address may already hold an old rehearsal contract or be out of reach: **treat ETH sent on Arbitrum One as lost**. **Don't use the owner wallet on any other network** (Base, Optimism, and so on) before settlement, to keep this option open there. Decide case by case, and say plainly on Luma that ETH sent on another network can be lost.

## Guest deposit page

`site/index.html` is a single static page for guests, with no dependencies and no build step beyond baking in the address:

1. Connect wallet (any injected wallet; on phones, the wallet app's own browser).
2. Switch to Ethereum mainnet (chain ID 1). Sending is blocked on any other network, and the network is checked again right before the wallet prompt.
3. Check balance: at least the deposit plus some ETH for the network fee. It also refuses a second deposit from a wallet that already has one or is already registered.
4. Send exactly the deposit to the contract, and wait for the receipt.
5. Copy the Etherscan tx link and wallet address for Luma.

Before enabling the send button, the page reads the contract over the public RPC and checks there is code at the address, that `depositAmount()` is the expected amount, and that `phase()` is Open with `eventStart` in the future. A "Check a deposit" view shows any wallet's status (received, confirmed, refunded, on the list, challenged, in a Kleros case, paid, no-show) and lets a guest `claim` a payment that could not be delivered (a payout, a refund or challenge money) to any address, or `emergencyWithdraw` after the deadline.

After the list is posted, the same view is how challenges work: a staker left off the list can challenge (pays `challengeDeposit()` in ETH); anyone looking up a challenger can dispute the claim (matches the deposit, creating the Kleros case) and later settle it. A list of open challenges shows who challenged, with a link to each Kleros case (`https://court.kleros.io/cases/<case number>`). While a case is open, the page can send evidence; while it is in its appeal period, it shows the jury's vote, the deadlines and how much each answer has raised, and lets the guest fund an answer from their own wallet straight to Kleros's Dispute Resolver, and collect their appeal refunds and rewards once the case is over. When the appeal period is over it says which answer wins (an answer funded alone for an appeal wins over the jurors' vote) and offers to deliver the final ruling. Once the challenge window is over, anyone can release the payouts there too.

The deposit address is compiled into the page (`npm run site` writes `site/dist/index.html` from `config.json`); it is never read from the URL, so a look-alike link can't redirect deposits. Re-run after deploying. `npm run site -- --preview` builds a page without an address. Browser test: `npm run test:site` (needs Playwright: `npm i --no-save playwright && npx playwright install chromium`).

## How a Kleros case works (Kleros Court v1 on Ethereum mainnet)

- **Who decides:** Kleros Court (KlerosLiquid, `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069`), General Court (court 0), 3 jurors in the first round. The contract opens the case through Kleros's general-purpose **Dispute Resolver** (`0x4b89e798b10478a839ea0abcf86c4b94a3c782a4`), which anyone can use and whose arbitrator is fixed to KlerosLiquid. (Kleros v2, used by the earlier Arbitrum version, only runs on Arbitrum.)
- **Two numbers per case:** the Kleros case number (`challenges(staker).arbitratorDisputeID`, shown on `https://court.kleros.io/cases/<number>`) and the Dispute Resolver's own number for it (`challenges(staker).localDisputeID`), which evidence, appeals and appeal withdrawals use. `ChallengeMatched` logs both.
- **Cost:** the case fee is about **0.0162 ETH** today for 3 jurors (`challengeDeposit()` reads the live value from Kleros). The challenger and the matcher each put in that amount; the fee comes out of the two deposits and the rest goes to the winner (split in half if the jurors refuse to arbitrate).
- **Time:** one round in the General Court takes about **3 weeks**: evidence 78 h, commit 162 h, vote 162 h, appeal 108 h (votes are hidden, then revealed), sometimes a little longer while jurors are drawn. Each appeal adds another round with a larger jury (2n + 1 jurors).
- **Case description:** every case uses the same pinned description (`metaEvidenceURI`, from `docs/metaevidence.json`), which links to the juror policy (`policyURI`). The contract sends no evidence itself; the "Challenge details" evidence tells jurors which wallet the case is about.
- **Evidence:** ERC-1497 JSON files (`{ "name", "description", "fileURI" }`) pinned through Kleros's IPFS upload service, sent with `submitEvidence(localDisputeID, "/ipfs/<cid>/<file>.json")` from the sender's own wallet.
- **Appeals:** `fundAppeal(localDisputeID, answer)` on the Dispute Resolver from each funder's wallet (1 = attended, 2 = did not attend). Today's Dispute Resolver multipliers: the answer the jurors voted for pays the appeal fee + 100% until the end of the appeal period; any other answer pays the fee + 200% and only during the first half. If exactly one answer is fully funded when the period ends, the Dispute Resolver records that answer as the ruling. Funders collect with `withdrawFeesAndRewardsForAllRounds(localDisputeID, funder, [1, 2])` once the case is ruled (`getTotalWithdrawableAmount` shows what is due).
- **Final ruling:** after the last appeal period, someone moves the case to its execution period (`KlerosLiquid.passPeriod(caseNumber)`) and delivers the ruling (`KlerosLiquid.executeRuling(caseNumber)`). Kleros's bots often do this; anyone can. Only then does the Dispute Resolver record the ruling, and `resolveChallenge` (**Settle**) can act on it.

## Trust model

This setup isn't trustless, but anyone can check it:

- **Deposits:** Every deposit (`Deposited` events) and every registered staker (`StakerRegistered` events and `stakers()`) is public on-chain. The contract accepts ETH (a plain transfer or `deposit()`) only while it is Open, so late ETH stays in the sender's wallet.
- **The pool:** pool ETH, challenge ETH and unclaimed payments share one balance. `reserved()` counts everything someone is owed (the staked pool until paid out, then the shares set aside for open cases; challenge money; unclaimed payments), and `refund`, `sweep` and the refund of an unregistered payer can only move ETH above it. Declined guests are refunded exactly their deposit, to their own wallet.
- **Attendance:** The organiser publishes who attended (`postAttendance`), based on the Luma check-in, with the exact per-person share she confirmed. A staker left off the list has 1 day to challenge; anyone has 1 day to match, which creates a Kleros case decided by jurors under `docs/attendance-policy.md`. An unmatched challenge counts as attended. `releasePayouts` (callable by anyone) pays out after the window once no challenge waits for a match; a share per open Kleros case is set aside until its final ruling, so no one can freeze everyone's payout by disputing or appealing.
- **Kleros integration:** permissionless, through Kleros Court v1's Dispute Resolver on Ethereum mainnet (see "How a Kleros case works"). The contract pays exactly the case fee (`createDispute{value: fee}(extraData, metaEvidenceURI, 2)`, extra data = court 0 and 3 jurors), stores both case numbers, and reads the final ruling back from the Dispute Resolver (`disputes(localDisputeID)`: `isRuled`, `ruling`). The Dispute Resolver records a ruling only when KlerosLiquid delivers it after the last appeal period, so `resolveChallenge` can never act on a vote that is later overturned.
- **Appeals:** handled entirely by Kleros. No appeal money passes through this contract: funders pay the Dispute Resolver and are paid back by it. The console and guest page read the current vote, `appealPeriod`, the costs (`appealStatus` on our contract follows the Dispute Resolver's multipliers) and the Dispute Resolver's `Contribution` and `RulingFunded` events, and offer funding and withdrawal; the console also offers delivering the final ruling.
- **Payments that fail:** batch payments (payouts, refunds of declined guests, cancellation refunds, challenge money) give each wallet up to 40,000 gas, enough for a Safe or a common smart-contract wallet (they need well under 20,000). If a wallet refuses ETH or needs more, the amount is kept in `owed` for that wallet to `claim` to any address it chooses (all gas forwarded); nobody else is blocked. 40,000 also keeps the worst batch inside one Ethereum transaction: since EIP-7825 (Fusaka) a transaction may use at most 16,777,216 gas, and a payout to 150 wallets that each burn their whole allowance needs about 12.6 million (tested, with the console's 30% margin). The console and the guest page never ask for a gas limit above that cap.
- **Tokens:** deposits are ETH only. A token sent to the contract (USDC, for example) is not a deposit and is never counted; the owner can send it back with `returnToken(token, to, amount)` (console: **Return tokens sent by mistake**), which moves only that token and never ETH.
- **Deadlines:** the list can be posted from `eventStart`. If no list is posted by `claimDeadline` (at least 7 days later), every staker can withdraw their own deposit, so a lost owner key cannot lock the pool. Once the list is posted, payouts no longer depend on the owner.
- **Known limits:** balances are counted in total, not per wallet, so the organiser must only register wallets the verify script lists. Unregistered payers depend on the organiser to refund them. The owner is a single wallet (no multisig), by the organiser's choice. A matched challenge holds only that challenger's share until Kleros's final ruling (about 3 weeks per round; each appeal adds a round, up to several months). If Kleros never delivers a ruling on a case, that one set-aside share and that case's challenge money stay locked; everything else is paid. The Dispute Resolver's governor (Kleros) can change the appeal multipliers. `emergencyWithdraw` only applies when no list was posted.

## Rehearsal

`npm run console:rehearsal` deploys a throwaway contract on Ethereum mainnet from `config.rehearsal.json` (never put on Luma, `poolCap` 0.25 ETH), with real ETH and real network fees. Everything can be rehearsed with small amounts: deploy, deposit, register, refund a declined guest, post the list, a challenge left unmatched (it counts as attended after 1 day and the ETH comes back), release payouts. **Matching a challenge in a rehearsal opens a real Kleros case** (about 0.0162 ETH, real jurors, about 3 weeks), so only do it on purpose, after the case description is pinned.

## Guest instructions (for the Luma page)

> **Committed Spot: refundable ETH deposit**
> ⚠️ **Network: Ethereum mainnet only, NOT Arbitrum, Base, Optimism or any other network.** Check that your wallet is on **Ethereum** (chain ID 1) *before* you send. ETH sent on any other network does not reach the deposit contract and may be lost for good.
>
> 1. Send **exactly 0.01 ETH on Ethereum mainnet** to `<contract address>`, **from your own wallet**, before **Wed 4 Nov, 18:00 IST**. Send the amount in ETH, not a dollar value, and **only ETH: not USDC or any other token** (a token is not a deposit and books no spot). Don't send it from an exchange, because the refund goes back to the wallet that sent it.
> 2. Register with the *Committed Spot* ticket. Enter that wallet address and paste the transaction link. It should start with **https://etherscan.io/tx/**. If your link starts with arbiscan.io, basescan.org or anything else, you sent it on the wrong network.
> 3. Every registration is reviewed. If you are declined or not admitted from the waitlist, your deposit goes back to the same wallet.
> 4. If you don't check in, you lose your deposit. If the organisers never post the attendance list, you can withdraw it yourself after 18 Nov.
> 5. Check in at the door. After the event, everyone who showed up gets their deposit back, plus an equal share of the no-shows' deposits.
> 6. **Missed at check-in?** The attendance list is published on-chain after the event. If you were there but are not on it, you have 1 day to challenge it from the deposit page with an ETH deposit equal to the Kleros fee (about 0.0162 ETH today). If nobody disputes it within a day, you count as attended and get that ETH back. If someone does, independent Kleros jurors decide from the evidence (photos, messages, hosts' statements). Either side can appeal the jurors' vote to a larger jury from the same page. If one side funds an appeal and the other doesn't, the funded side wins, so watch your case until the final ruling. Everyone else is paid on time; only the challenger's share waits for the final ruling.

(Replace 0.01 ETH with the final `deposit` amount if it changes, and `<contract address>` with the deployed contract.) Most wallets estimate the gas for a transfer to a contract, so a plain send works; a wallet or exchange that uses a fixed 21,000 gas limit fails (`TX_FAILED`, only the network fee is lost). The guest deposit page avoids this by calling `deposit()`.
