#!/usr/bin/env node
// Developers only: deploys the protocol from a private key and writes deployments/<network>.json.
// Organisers never need this, and nobody needs it on a network that already has a deployment.
// The deploy page (deploy.html) does the same from a browser wallet, without a private key.
//
//   PRIVATE_KEY=0x… RPC_URL=https://… POLICY_URI=/ipfs/Qm…/attendance-policy.md \
//   [NETWORK=ethereum] [RESOLVER=0x…] [SUBCOURT=0] [JURORS=3] [CHALLENGE_HOURS=24] [MATCH_HOURS=24] npm run deploy
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { NETWORKS, deployProtocol, extraDataOf, ipfsPathOf } from "./protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const env = process.env;
const fail = (m) => (console.error(m), process.exit(1));
if (!env.PRIVATE_KEY || !env.RPC_URL) fail("Set PRIVATE_KEY and RPC_URL.");
if (!/^\/ipfs\/\w{46,}/.test(env.POLICY_URI ?? "")) fail("Set POLICY_URI to the juror policy's IPFS path (upload docs/attendance-policy.md first).");
const prov = new ethers.JsonRpcProvider(env.RPC_URL);
const { chainId } = await prov.getNetwork();
const net = NETWORKS[Number(chainId)] ?? {};
const key = env.NETWORK ?? net.key ?? `chain-${chainId}`;
const out = path.join(root, "deployments", `${key}.json`);
if (fs.existsSync(out) && !env.OVERWRITE) fail(`${out} exists already. Use the existing deployment, or set OVERWRITE=1.`);
const resolver = env.RESOLVER ?? net.kleros?.disputeResolver;
if (!ethers.isAddress(resolver ?? "")) fail("Set RESOLVER (no Kleros Dispute Resolver is known for this chain).");
const policyFile = fs.readFileSync(path.join(root, "docs/attendance-policy.md"), "utf8");
if (env.POLICY_URI.split("/")[2] !== ipfsPathOf(policyFile).split("/")[2] && !env.POLICY_URI.includes("/attendance-policy")) console.warn("Note: POLICY_URI is not the IPFS path of docs/attendance-policy.md as it is now.");
const signer = new ethers.Wallet(env.PRIVATE_KEY, prov);
const artifacts = Object.fromEntries(["PresenceCaseWriter", "PresenceEvent", "PresenceFactory"].map((n) => [n, JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"))]));
const subcourt = Number(env.SUBCOURT ?? net.kleros?.subcourt ?? 0), jurors = Number(env.JURORS ?? net.kleros?.jurors ?? 3);
const fromBlock = await prov.getBlockNumber();
const d = await deployProtocol(signer, artifacts, {
  disputeResolver: resolver, extraData: extraDataOf(subcourt, jurors), policyURI: env.POLICY_URI,
  templateText: fs.readFileSync(path.join(root, "docs/metaevidence.template.json"), "utf8"),
  network: net.name ?? `chain ${chainId}`, explorer: net.explorer ?? "", challengePeriod: Number(env.CHALLENGE_HOURS ?? 24) * 3600, matchPeriod: Number(env.MATCH_HOURS ?? 24) * 3600,
}, (n, tx) => console.log(`${n}: ${tx.hash}`));
const dep = { chainId: Number(chainId), factory: d.factory, implementation: d.implementation, caseWriter: d.caseWriter, fromBlock, policyURI: env.POLICY_URI, disputeResolver: resolver, subcourt, jurors, deployedBy: signer.address, deployedAt: new Date().toISOString() };
fs.writeFileSync(out, JSON.stringify(dep, null, 2) + "\n");
console.log(`Saved ${path.relative(root, out)}. Rebuild the site: npm run build`);
