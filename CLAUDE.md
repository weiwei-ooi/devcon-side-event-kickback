# Proof of Presence (project brief for Claude)

Refundable event deposits with a Kleros attendance-challenge layer, as a permissionless protocol: any organiser creates an event from the factory (deposit in ETH or any ERC-20, own dates and capacity), guests book on the deposit page, the organiser posts who came, guests left off can challenge, Kleros decides. README.md explains the mechanism, trust model and layout.

## Who you're working with
- **Wei Wei**, Event Manager at **Kleros**. She is **not a developer**: do all technical work yourself and explain in plain language. Ask her only for what a human must do (confirm wallet transactions, decisions).
- **Never ask for, read or store a private key or recovery phrase.** She signs in her browser wallet through the pages (`deploy.html`, `organiser.html`). `scripts/deploy.mjs` with `PRIVATE_KEY` is for other developers only.
- Her rules: **no PRs, push final versions straight to `main`**; never commit guest data or secrets; the repo must **always build on Netlify** (`netlify.toml`: `npm run build`, publish `dist/`); nothing that only works on localhost.
- **Do not deploy anything to mainnet without her explicit go.** The factory is not deployed yet (deployments/ has no ethereum.json).
- Code style (her request): `require(condition, CustomError())`, not `if (!x) revert`. Solidity 0.8.28, optimizer 200, EVM paris.

## Decisions (Nov 2026)
- Permissionless and generic: no event-specific branding in the core. Kleros challenges are **always on** (fixed in the implementation, not an option).
- **Deposits stay open until the event's end** (`eventEnd`), not its start, so walk-ins can book during the event (bug in the other dev's version, which closed at the start).
- Deposit = booked (her rule "if they stake they're in"); the organiser curates by turning guests away (`reject`, full refund).
- Default network Ethereum mainnet (Kleros Court v1 through the Dispute Resolver `0x4b89…82a4`, KlerosLiquid `0x988b…8069`, General Court, 3 jurors); other chains by fork + `NETWORKS` in scripts/protocol.mjs + `deployments/<network>.json`.
- Not upgradeable, no admin (EIP-1167 clones of a fixed implementation). The other dev's version (github.com/markdavemanansala/proofofpresence, kickback.kleros.io) used UUPS proxies with an immediate-upgrade owner; we chose fixed code for trust.
- Product name: "Proof of Presence", "Powered by Kleros"; domain: **kickback.kleros.io** (her pick, 18 Nov 2026). Site look = Kleros Events (her kleros-events repo): tokens in web/style.css, light + dark, header/footer from web/chrome.js, create flow on web/create.html. `node tools/screenshots.mjs <dir>` takes page screenshots on a local chain.

## How to run things
```bash
npm install
npm test            # contract + helper tests (local ganache)
npm run test:web    # Playwright browser tests of the pages
FORK_URL=<mainnet rpc> npm run test:fork   # real Kleros on a mainnet fork (not from the cloud container: no mainnet RPC there; run on her Mac)
npm run build       # dist/ for Netlify
```

## Legacy
`legacy/truth-pays/` is the single-event Truth Pays version (Devcon Mumbai, 4 Nov 2026) with its own CLAUDE.md, tests and scripts. Its live contract `0xd5c6A73c05FA431c748781DaBAA99Fe2590d677D` is empty and finished. The old gh-pages site still serves its pages.
