#!/usr/bin/env node
// Builds the static site into dist/ (what Netlify publishes):
//   node scripts/build-web.mjs [--network ethereum] [--deployment file.json] [--rpc url] [--out dist]
// It copies web/, the shared protocol module, ethers, the contract ABIs, the juror policy and case template,
// and writes config.js from deployments/<network>.json (or --deployment). Without a deployment the pages
// still build and say the protocol is not deployed yet. Environment variables work too (for Netlify):
// POP_NETWORK, POP_DEPLOYMENT, POP_RPC.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { NETWORKS } from "./protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const arg = (k, env) => {
  const i = argv.indexOf(`--${k}`);
  return i >= 0 ? argv[i + 1] : process.env[env];
};
const out = path.resolve(root, arg("out") ?? "dist");
const network = arg("network", "POP_NETWORK") ?? "ethereum";
const depFile = arg("deployment", "POP_DEPLOYMENT") ?? path.join(root, "deployments", `${network}.json`);
const dep = fs.existsSync(depFile) ? JSON.parse(fs.readFileSync(depFile, "utf8")) : {};
const chainId = Number(dep.chainId ?? Object.entries(NETWORKS).find(([, n]) => n.key === network)?.[0] ?? 1);
const net = NETWORKS[chainId] ?? {};
const rpc = arg("rpc", "POP_RPC");
const config = {
  chainId,
  name: dep.name ?? net.name ?? `Chain ${chainId}`,
  explorer: dep.explorer ?? net.explorer ?? "",
  currency: dep.currency ?? net.currency ?? "ETH",
  rpcs: rpc ? rpc.split(",") : dep.rpcs ?? net.rpcs ?? [],
  factory: dep.factory ?? null,
  implementation: dep.implementation ?? null,
  fromBlock: dep.fromBlock ?? 0,
  policyURI: dep.policyURI ?? null,
  ...(dep.ipfsUpload ? { ipfsUpload: dep.ipfsUpload } : {}),
  ...(dep.ipfsGateway ? { ipfsGateway: dep.ipfsGateway } : {}),
  ...(dep.kleros ? { kleros: { ...net.kleros, ...dep.kleros } } : {}),
};

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(path.join(out, "abi"), { recursive: true });
fs.mkdirSync(path.join(out, "vendor"), { recursive: true });
fs.mkdirSync(path.join(out, "docs"), { recursive: true });
fs.cpSync(path.join(root, "web"), out, { recursive: true });
fs.copyFileSync(path.join(root, "scripts/protocol.mjs"), path.join(out, "protocol.mjs"));
fs.copyFileSync(path.join(root, "node_modules/ethers/dist/ethers.min.js"), path.join(out, "vendor/ethers.min.js"));
for (const n of ["PresenceEvent", "PresenceFactory", "PresenceCaseWriter"]) {
  const src = path.join(root, "build", `${n}.json`);
  if (!fs.existsSync(src)) throw new Error("Run `npm run compile` first (build/ is missing).");
  fs.copyFileSync(src, path.join(out, "abi", `${n}.json`));
}
for (const f of ["attendance-policy.md", "metaevidence.template.json"]) fs.copyFileSync(path.join(root, "docs", f), path.join(out, "docs", f));
fs.writeFileSync(path.join(out, "config.js"), `window.POP_CONFIG = ${JSON.stringify(config, null, 2)};\n`);
console.log(`Built ${path.relative(root, out)}/ for ${config.name}${config.factory ? ` (factory ${config.factory})` : " (not deployed yet)"}`);
