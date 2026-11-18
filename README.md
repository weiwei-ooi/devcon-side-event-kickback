# Proof of Presence

*Kickback deposits for events · Powered by Kleros* · planned home: **kickback.kleros.io**

**Refundable event deposits where showing up pays, with the attendance list open to challenge in Kleros Court.**

Guests book a spot with a small deposit (ETH or any ERC-20 token). After the event, everyone who came shares the whole pool: their deposit back plus an equal share of the no-shows' deposits. If the organiser leaves someone off the attendance list, that guest can challenge it, and [Kleros](https://kleros.io) jurors decide.

It is permissionless: anyone creates an event from the factory with their own deposit, dates and capacity, and runs it from the organiser panel. Built by Kleros, MIT licensed.

- **Deposit page** for guests: `event.html?e=<event address>`
- **Organiser panel**: `organiser.html` (create an event, post the list, handle challenges, pay out)
- **Deploy page** (once per network): `deploy.html`

## How an event works

| When | What happens | Who |
| --- | --- | --- |
| From creation **until the event ends** | Guests send exactly the deposit and are booked at once. Walk-ins can still book while the event is running. | Guests |
| Until the list is closed | The organiser can turn a guest away: that guest gets exactly their deposit back. | Organiser |
| From the event's end until the deadline (at least 7 days later) | The organiser posts who came (in several batches if needed) and closes the list. | Organiser |
| Challenge window (1 day) | A guest left off the list who says they came pays a challenge deposit equal to the Kleros fee. | Guest |
| Match window (1 day from each challenge) | Anyone who disagrees pays the same. This opens a Kleros case with a description the contract writes itself (event, wallet, organiser, deposit). If nobody matches, the guest counts as attended and gets the challenge deposit back. | Anyone (usually the organiser) |
| After the challenge window | Anyone releases the payouts. The pool is split into equal shares, one per attendee and one set aside per open Kleros case, so a case never holds anyone else's money. | Anyone |
| When a case is ruled (about 3 weeks per round) | Attended: the guest joins the list and gets the set-aside share plus what is left of both challenge deposits. Did not attend (or refused to arbitrate): the set-aside share is split among everyone else, so all attendees end with the same total. | Anyone settles it |
| Any time after payout | Each person withdraws, or anyone pushes everyone's money in one transaction. A wallet that refuses a payment keeps it claimable. | Anyone |

Safety nets: the organiser can cancel before closing the list (everyone takes their deposit back), and if the list is never closed by the deadline every guest takes their own deposit back. The organiser can never keep deposits: their only powers are giving deposits back, posting the list, matching challenges like anyone else, and returning money sent to the contract by mistake.

## Trust model

- **No admin, no upgrades.** The factory has no owner. Each event is an [EIP-1167](https://eips.ethereum.org/EIPS/eip-1167) minimal clone of one implementation whose code is fixed. Nobody (including Kleros or the authors) can change the rules or move deposits.
- **Kleros is always on.** The Dispute Resolver, court, number of jurors, the [juror policy](docs/attendance-policy.md) and the [case template](docs/metaevidence.template.json) are fixed in the implementation. An organiser cannot create an event without the challenge layer.
- **Each case explains itself.** The contract writes every case's [ERC-1497](https://github.com/ethereum/EIPs/issues/1497) description from the template (event name and page, start and end in UTC, challenged wallet, organiser, deposit, contract) and computes its IPFS path on-chain, so neither side chooses the wording. The pages upload that exact text to Kleros's IPFS service before a case opens.
- **Appeals and evidence** go straight from each person's wallet to Kleros's Dispute Resolver; no appeal money passes through the event contract.
- **Deposits are per wallet.** Deposit = booked: there is no separate registration step that could mix up whose money is whose.
- **Tokens:** the event's token must not take a fee on transfers (checked at every deposit). Challenge deposits are always ETH, because the Kleros fee is paid in ETH.

## Contracts

| Contract | What it does |
| --- | --- |
| [`PresenceFactory`](contracts/PresenceFactory.sol) | `createEvent(config)` makes a new event for the caller. Lists events (`events`, `eventsOf`, `isEvent`). |
| [`PresenceEvent`](contracts/PresenceEvent.sol) | One event: deposits, curation, the attendance list, challenges, Kleros cases, payouts. |
| [`PresenceCaseWriter`](contracts/PresenceCaseWriter.sol) | Holds the case template and writes each case's description and its IPFS path. |

Event settings (`PresenceEvent.Config`): `name` (1 to 200 bytes, no quotes, backslashes or line breaks), `url` (optional), `token` (`0x0` for ETH), `depositAmount` (smallest unit), `eventStart`, `eventEnd`, `claimDeadline` (at least 7 days after `eventEnd`), `capacity` (0 = no limit).

Code style: `require(condition, CustomError())`, Solidity 0.8.28, optimizer 200 runs, EVM paris.

### Deployments

| Network | Factory | Status |
| --- | --- | --- |
| Ethereum mainnet | — | not deployed yet |

Kleros on Ethereum mainnet: Dispute Resolver `0x4b89e798b10478a839ea0abcf86c4b94a3c782a4`, KlerosLiquid `0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069`, General Court (0), 3 jurors.

## Run it yourself

```bash
npm install
npm test               # contract tests on a local chain (~1 min)
npm run test:web       # browser tests of the pages (needs Playwright + Chromium)
FORK_URL=https://ethereum-rpc.publicnode.com npm run test:fork   # against the real Kleros contracts on a mainnet fork
npm run build          # compiles and builds the site into dist/
npm run serve          # serves dist/ on http://localhost:8080
```

### Host the pages (Netlify)

The repository is ready for Netlify: import it, and [`netlify.toml`](netlify.toml) runs `npm run build` and publishes `dist/`. The pages read the deployment from [`deployments/ethereum.json`](deployments/). Set the environment variable `POP_NETWORK` to build for another file in `deployments/`. Any static host works the same way (`npm run build`, then serve `dist/`).

### Deploy the protocol (once per network)

Most people never need to: use the existing mainnet deployment. To run your own (another chain with Kleros, another court, other windows):

1. Upload [`docs/attendance-policy.md`](docs/attendance-policy.md) to IPFS (the deploy page has a button for Kleros's upload service).
2. Open `deploy.html` on your copy of the site, connect a wallet, check the Kleros settings and deploy. It sends three transactions (about 8 million gas in total) and prints the JSON to save as `deployments/<network>.json`.
3. Rebuild the site. Developers can also use `PRIVATE_KEY=… RPC_URL=… POLICY_URI=… npm run deploy` (see [`scripts/deploy.mjs`](scripts/deploy.mjs)).

For a chain that is not in [`scripts/protocol.mjs`](scripts/protocol.mjs) `NETWORKS`, add it there (RPCs, explorer, Kleros addresses) in your fork.

## Using it with Luma (or any registration page)

1. Create the event in the organiser panel and copy the guest link.
2. On Luma, add a paid-style ticket (for example "Committed Spot") whose description says: book at the guest link, then paste the transaction link in the registration question. Luma cannot redirect on a ticket pick, so put the link in the ticket description and in the question.
3. Guests book on the deposit page; deposits stay open during the event for walk-ins.
4. After the event, paste the Luma guest export (it contains the wallets) into "Select from a check-in list" in the panel, then close the list.

## Repository layout

| Path | What |
| --- | --- |
| `contracts/` | The three contracts |
| `web/` | The pages (plain HTML + ES modules, no framework) |
| `scripts/` | `protocol.mjs` (shared by pages, tests and scripts), compile, build, deploy, serve |
| `docs/` | Juror policy and case template (fixed at deployment) |
| `deployments/` | Deployed addresses per network |
| `test/` | Contract, browser and mainnet-fork tests; Kleros stand-ins in `test/mocks/` |
| `legacy/truth-pays/` | The first single-event version, used for Truth Pays (Devcon Mumbai, Nov 2026), kept for reference: its contract is verified on Etherscan at `0xd5c6A73c05FA431c748781DaBAA99Fe2590d677D` |
