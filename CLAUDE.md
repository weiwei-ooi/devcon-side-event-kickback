# Ground Truth: Kickback deposits (project brief for Claude)

## Who you're working with
- **Wei Wei**, Event Manager at **Kleros**. **She is not a developer.** Do all the technical work yourself (installing, compiling, running scripts, editing files). Explain things in plain language. Only ask her to do things a human must do: confirm transactions in her wallet and approve or decline guests on Luma.
- **Never ask for, read or store a private key or recovery phrase.** All signing happens in her browser wallet (Zerion, owner `0x259a1084C2043a7B3b5b288596E05C41b8EFa5d6`) through the owner console (`npm run console`). Do not put a `PRIVATE_KEY` in `.env` for her. `scripts/deploy.mjs` and `scripts/owner.mjs` exist for developers only.

## The event
- **Ground Truth: Queryable Data, Prediction Markets & Decentralised Justice on Ethereum**. This is a Devcon Mumbai side event: a networking dinner.
- When and where: Wed 4 Nov 2026, 18:00–22:00 IST, at Hitchki, BKC, Mumbai (venue via Mirah Hospitality; booking being finalised).
- Hosts: Kleros, Arkiv (Golem Network), and Web3 Mumbai.
- Luma (Private for now): https://luma.com/qewnqhas. Manage page: https://luma.com/event/manage/evt-xjcerzm2NJ0OVdq. The event is on the "Kleros Events" calendar.
- Luma setup:
  - Capacity 150 with a waitlist, and every registration needs approval.
  - Ticket types: **"Committed Spot ($25 Deposit)"** and **"Request to Join (Free)"**.
  - Questions: ETH Address (optional, connected wallet), Company/Project + job title, X, LinkedIn, "What are you building?", and "Deposit tx link (Committed Spot only)…".
- The Luma description still contains the placeholders **[NETWORK]** and **[DEPOSIT ADDRESS]**. Replace them once the contract is deployed: the network is Arbitrum One, and the address is the deployed contract.

## The mechanism (decided with Wei Wei)
- Guests choosing the Committed Spot send **25 USDC** on **Arbitrum One mainnet** from their own wallet to the deposit contract, then paste the tx link on Luma.
- We verify each deposit on-chain. **Wei Wei curates every guest herself, paid or free** (bots get declined). Only guests who are verified **and** approved on Luma are registered in the contract. Paying guests she declines get exactly their 25 USDC back (`rejectAndRefund`, the "Refund declined guests" button); we never keep their money.
- Claude exports the Luma guest CSV (Chrome, manage page) and prepares the lists; she does not export it herself.
- After the event, every staker who **checked in** gets an equal share of the **whole** pool: their 25 back plus a share of the no-shows' deposits. No-shows lose their deposit.
- Free "Request to Join" guests are curated by hand and pay nothing.
- Deposit: **25 USDC** (raised from 15 on 23 Oct 2026, her decision). Network: **Arbitrum One mainnet**, native USDC `0xaf88d065e77c8cC2239327C5EDb3A432268e5831`.
- Owner: a **dedicated wallet with its own recovery phrase** (her Zerion wallet `0x259a…a5d6`), kept separate from her personal wallet, funded with a little ETH on Arbitrum One. No Safe (her decision).

## Status (as of 23 Oct 2026)
- [x] Contract v2 (after two code reviews), scripts and tests: `npm test` passes on a local chain (contract tests + end-to-end with the scripts). The console was also driven end to end in a browser against a local chain.
- [x] Owner wallet set up (Zerion, funded on Arbitrum One). Rehearsal of v1 passed on Arbitrum One with a throwaway contract (`0x1F044c041D873CC906E614c558B7b877E88F620f`, never put on Luma).
- [ ] Short v2 rehearsal on Arbitrum One (`npm run console:rehearsal`, 500 USDC safety cap): deploy, deposit 25, register, refund-declined, deposit again, pay out.
- [ ] Her developers review the code. Zero open issues before going public.
- [ ] Deploy the live contract with `npm run console` (config.json), set `receiver`, `contract`, `deployBlock` and `depositOpensAt` (deploy time), verify the source on Arbiscan (0.8.24, optimizer 200, EVM paris), and put the address on Luma (event stays **Private**).
- [ ] Switch Luma from Private to Public only when she says so.

## How to run things
```bash
npm install && npm run compile      # first time
npm test                            # optional, ~2 min
npm run console                     # live: opens http://localhost:8787 for wallet actions
npm run console:rehearsal           # throwaway contract on Arbitrum One, 500 USDC cap
```
**During registration:** export the Luma guest CSV yourself (Manage → Guests → export) and run:
```bash
node scripts/verify-deposits.mjs --guests <file>.csv --scan-from-block <deploy block>
```
It sorts verified payers by her Luma decision: `out/to-review.csv` (waiting for her), `out/new-stakers.json` (approved → she clicks **Register stakers**), `out/refunds.json` (declined → she clicks **Refund declined guests**). `out/issues.csv` has plain-language codes for guests to email; `out/unmatched.csv` lists deposits nobody claimed (refund with **Return a stray transfer**).

**After the event:** export the CSV again (`checked_in_at` is filled at the door) and run:
```bash
node scripts/build-payout.mjs --checkins <file>.csv [--extra-checkins door-list.csv]
```
Before that, make sure every payer still pending, waitlisted or late has been declined on Luma and refunded (**Refund declined guests**). Show her `out/payout-summary.md`. She clicks **Pay attendees**, which reads `out/payout-plan.json` and refuses if the numbers on-chain changed.

Full details, issue codes and the trust model are in `README.md`.

## Notes
- **Wrong-network risk (her request, 23 Oct):** most wallets default to Ethereum mainnet. Luma shows a ⚠️ "Arbitrum One ONLY, not Ethereum mainnet" line (added 23 Oct); keep it prominent and say the tx link should start with arbiscan.io (see README "Guest instructions"). Keep the owner wallet off Ethereum mainnet (see README "Wrong network").
- **Pay attendees** is greyed out in the console until the event starts (her request, 23 Oct) and needs PAY typed to confirm; the contract also refuses any payout before `eventStart`.
- **Timing (on-chain):** payout is possible from `eventStart` until `claimDeadline` (at least 7 days later; config uses 14). After the deadline the organiser can no longer pay out or cancel, and each staker can withdraw their own deposit (`emergencyWithdraw`) in case the owner wallet is lost.
- **Payouts:** `finalize(attendees, share)` runs once; the share must match what she confirmed. If USDC refuses a transfer (blocklisted wallet), that amount is kept for the guest to `claim` to another address, and everyone else is still paid.
- **Money nobody staked** (overpayments, stray transfers) can be returned with `refund`, which can never touch the staked pool or unclaimed payouts. `sweep` collects rounding dust after settlement.
- **The contract counts money in total, not per wallet.** Only register wallets the verify script lists; registering an unverified wallet could use someone else's unregistered deposit.
- **Ownership** moves in two steps (`transferOwnership`, then `acceptOwnership` from the new wallet).
