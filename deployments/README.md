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

No mainnet deployment yet: the factory is deployed only once the code has been reviewed, with the organiser's explicit go.
