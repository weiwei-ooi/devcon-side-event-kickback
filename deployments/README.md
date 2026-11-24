# Deployments

One JSON file per network, read by `scripts/build-web.mjs` (the file name is the network key, e.g. `ethereum.json`):

```json
{
  "chainId": 1,
  "factory": "0x…",
  "implementation": "0x…",
  "caseWriter": "0x…",
  "fromBlock": 0,
  "policyURI": "/ipfs/Qm…",
  "disputeResolver": "0x4b89e798b10478a839ea0abcf86c4b94a3c782a4",
  "subcourt": 0,
  "jurors": 3
}
```

Optional: `name`, `explorer`, `currency`, `rpcs` (for a chain not in `scripts/protocol.mjs`), `ipfsUpload`, `ipfsGateway`.
The deploy page (`deploy.html`) and `npm run deploy` print or write this file.

Ethereum mainnet: v2, deployed 24 Nov 2026 after the second security review (implementation and factory new; the
case writer from v1 is reused, unchanged). `ethereum-standard-input.json` is the standard-JSON input it was compiled
from, for explorer verification. v1 (18 Nov 2026, factory 0xEAC9…2F8B, no events) is kept in `archive/`.
