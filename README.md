# Ground Truth: Kickback-style deposits for Luma

Guests who want a guaranteed spot send a **$25 USDC refundable deposit**. Guests who show up get their deposit back, **plus an equal share of the no-shows' deposits**. Everyone else can still request a free spot, which the hosts approve by hand.

```
 Guest                       Organisers                              Contract (on-chain)
 ─────                       ──────────                              ───────────────────
 send 25 USDC ───────────────────────────────────────────────────▶  holds deposits
 register on Luma, paste
 wallet + tx link ─────────▶ verify-deposits.mjs ──▶ organiser approves / declines on Luma
                                                ├─▶ approved: registerStakers()  ─▶ public staker list
                                                └─▶ declined: rejectAndRefund()  ─▶ 25 USDC straight back
 check in at the door ─────▶ Luma check-in app
                             build-payout.mjs ─────▶ finalize(attendees, share) ─▶ pool ÷ attendees
                                                                           paid to each attendee
```

**Example:** 100 stakers make a 2,500 USDC pool. If 80 show up, each of them gets **31.25 USDC** back: their own 25 plus 6.25 from the no-shows.

## What's here

| File | What it does |
|---|---|
| `contracts/GroundTruthKickback.sol` | Holds the deposits, keeps a public staker list, and splits the pool equally among attendees. It also refunds declined guests, handles cancellation (full refunds), returns mistaken transfers (spare money only), keeps failed payouts for the guest to claim, lets stakers withdraw their own deposit if the organiser never settles, and sweeps rounding dust after settlement. |
| `scripts/verify-deposits.mjs` | Reads the Luma guest CSV and checks every pasted tx on-chain: correct token, correct receiver, sent from the guest's wallet, at least $25, inside the deposit window, and not reused. It also lists deposits that nobody claimed. |
| `scripts/build-payout.mjs` | Matches the Luma check-in export (plus an optional manual list) against the stakers and computes each payout. |
| `scripts/owner.mjs` | Sends the owner transactions directly, if the owner is a normal wallet. |
| `scripts/deploy.mjs` | Deploys the contract. |
| `console/` + `scripts/console.mjs` | The owner console: a local page where the organiser clicks buttons and confirms in her wallet. |
| `test/` | Contract tests (guards, blocklisted wallets, odd tokens, 150 guests) and an end-to-end test of the scripts on a local chain. |

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

The owner console is a local page: **Connect wallet**, **Deploy contract**, **Register stakers**, **Refund declined guests** and **Pay attendees**, plus (folded away) remove-and-refund one guest, return a stray transfer, collect leftovers and cancel. Every button simulates the transaction first and explains any problem in plain words before the wallet opens; reads and fee estimates go through the public RPC so the wallet only signs. A banner shows whether it is LIVE, a REHEARSAL (optional `poolCap` safety cap) or a test network.

### Developer alternative (private key in the environment)

Deploy once. The deployer only pays gas, and the Safe becomes the owner:

```bash
PRIVATE_KEY=0x… node scripts/deploy.mjs --owner 0xYourSafe   # uses eventStart / claimDeadline from config
```

Put the deployed address in `config.json` as **both** `receiver` and `contract`, the deploy block as `deployBlock` (used to find deposits nobody claimed), set `depositOpensAt` to the deploy time, and share the address as the deposit address. Verify the source on Arbiscan (Solidity 0.8.24, optimizer on, 200 runs, EVM `paris`) so guests can use `claim` / `emergencyWithdraw` from Arbiscan's "Write contract" tab if they ever need to.

> **Without the contract:** set `receiver` to a Safe and leave out `contract`. Verification works the same way, and `build-payout.mjs` writes a batched Safe transaction of USDC transfers instead of a `finalize()` call.

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
- `out/unmatched.csv`: deposits that arrived but that no registration claims.
- `out/safe-register.json`: upload this in Safe → Apps → Transaction Builder, or run `node scripts/owner.mjs register`.

**After the event:**

```bash
node scripts/build-payout.mjs --checkins ~/Downloads/luma-guests-after.csv [--extra-checkins door-list.csv]
```

- `out/payout-summary.md`: the numbers to post publicly.
- `out/payout-plan.json`: the attendee list and per-person share that **Pay attendees** sends; it refuses if the on-chain numbers changed.
- `out/safe-finalize.json`: upload and sign this, or run `node scripts/owner.mjs finalize`.
- **Before paying out:** decline on Luma every payer who is still pending or waitlisted, and every late (`OUTSIDE_WINDOW`) payer you won't admit; re-run verify and click **Refund declined guests**, so nobody's deposit is left behind as "spare".
- When it's done, click **Collect leftovers** in the console (it refuses to quietly sweep anything that looks like a guest's deposit).

**If the event is cancelled:** click **Cancel event and refund everyone** in the console. Every registered staker gets their 25 USDC back.

(`scripts/owner.mjs`, `scripts/deploy.mjs` and the `out/safe-*.json` files do the same from the command line or a Safe, for developers. The organiser never needs a private key.)

### Issue codes

| Code | Meaning | What to do |
|---|---|---|
| `NO_TX` / `BAD_TX_HASH` | No tx link, or the answer has no 0x… hash | Ask the guest for the link |
| `TX_NOT_FOUND` | The tx isn't on the configured chain | They most likely sent on Ethereum mainnet (an etherscan.io link) or another network. Ask them to send 25 USDC again **on Arbitrum One**. Their first transfer did not reach the contract, so we can't refund it from there. Getting it back is possible only case by case (see below). |
| `NO_DEPOSIT_TRANSFER` | The tx doesn't send USDC to the deposit address | Wrong token or wrong address |
| `WRONG_SENDER` | The USDC came from a different wallet than the one they entered | Often an exchange withdrawal. Check by hand: the payout goes to their stated wallet. |
| `AMOUNT_TOO_LOW` | They sent less than 25 | Ask them to top up, or `refund` them |
| `OUTSIDE_WINDOW` | Sent before deposits opened or after the deadline | Decide case by case |
| `DUPLICATE_TX` / `DUPLICATE_WALLET` | The tx or wallet is already used by another guest | Likely a copy-paste or someone gaming the system |
| `REFUNDED_EARLIER` | Approved now, but this deposit was already refunded | They need to send a new deposit |
| `REGISTERED_NOT_APPROVED` | Registered on-chain but no longer approved on Luma | Approve again, or decline to refund |

Overpayments are verified but flagged. Return the excess with `owner.mjs refund`.

**Wrong network (USDC sent on Ethereum mainnet to the contract address):** the money sits at that address on Ethereum, where no contract exists. The only way to recover it is to deploy the same contract on Ethereum from the owner wallet at the same nonce, so that it lands at the same address, then `refund` it from there. This costs Ethereum gas and only works while the owner wallet has made fewer Ethereum mainnet transactions than that nonce. So **don't use the owner wallet on Ethereum mainnet** before settlement. Decide case by case.

## Trust model

This setup isn't trustless, but anyone can check it:

- **Deposits:** Every deposit and every registered staker is public on-chain (`StakerRegistered` events and `stakers()`).
- **The pool:** `refund` and `sweep` can only move *spare* money: balance above the staked pool and unclaimed payouts. Declined guests are refunded exactly their deposit, to their own wallet.
- **Attendance:** The organiser decides who attended, based on the Luma check-in. Publish `payout-summary.md` and the finalize tx so stakers can check it. The payout needs the exact per-person share the organiser confirmed.
- **Deadlines:** payout opens at `eventStart`. After `claimDeadline` (at least 7 days later) the organiser can no longer settle and every staker can withdraw their own deposit, so a lost owner key cannot lock the pool.
- **Failed transfers:** if USDC refuses a payout (blocklisted address), the amount is kept for that guest to `claim` to another address; nobody else is blocked.
- **Known limits:** balances are counted in total, not per wallet, so the organiser must only register wallets the verify script lists. Unregistered payers depend on the organiser to refund them. The owner is a single wallet (no multisig), by the organiser's choice.

## Guest instructions (for the Luma page)

> **Committed Spot: $25 refundable deposit**
> ⚠️ **Network: Arbitrum One only, NOT Ethereum mainnet.** Most wallets open on Ethereum mainnet by default. Switch your wallet to **Arbitrum One** (chain ID 42161) *before* you send. USDC sent on Ethereum mainnet or any other network does not reach the deposit contract, and we can't promise to get it back.
>
> 1. Send **exactly 25 USDC (native USDC) on Arbitrum One** to `<contract address>`, **from your own wallet**, before **Wed 4 Nov, 18:00 IST**. Don't send it from an exchange, because the refund goes back to that wallet.
> 2. Register with the *Committed Spot* ticket. Enter that wallet address and paste the transaction link. It should start with **https://arbiscan.io/tx/**. If your link starts with etherscan.io, you sent it on the wrong network.
> 3. Every registration is reviewed. If you are declined or not admitted from the waitlist, your 25 USDC goes back to the same wallet.
> 4. If you don't check in, you lose your 25 USDC. If the organisers never settle, you can withdraw it yourself after 18 Nov.
> 5. Check in at the door. After the event, everyone who showed up gets their 25 USDC back, plus an equal share of the no-shows' deposits. If your registration is declined, your 25 USDC is sent back to the same wallet.
