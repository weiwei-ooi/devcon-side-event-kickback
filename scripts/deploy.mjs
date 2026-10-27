#!/usr/bin/env node
// Deploy TruthPaysKickback (developers only; the organiser deploys from the owner console).
//
//   PRIVATE_KEY=0x… node scripts/deploy.mjs [--config config.json] [--owner 0x…]
//
// The deployer only pays gas; --owner (or config.owner) becomes the contract owner.
// Timing comes from config: the attendance list can be posted from "eventStart"; after
// "claimDeadline" (at least 7 days later) it can no longer be posted and stakers can withdraw.
// Kleros settings come from config.kleros (see klerosConfig in lib.mjs): Kleros Court v1 through
// the Dispute Resolver, court and jurors, the pinned metaevidence and juror policy (both required
// in live mode).
import { ethers } from "ethers";
import { args, loadConfig, provider, loadAbi, deployArgs, klerosConfig, fmtEth } from "./lib.mjs";

const a = args();
const cfg = loadConfig(a.config ?? "config.json");
if (!process.env.PRIVATE_KEY) throw new Error("Set PRIVATE_KEY (deployer, only needs gas)");
const prov = provider(cfg);
const chainId = Number(await prov.send("eth_chainId", []));
if (chainId !== Number(cfg.chainId)) throw new Error(`The RPC is on chain ${chainId}, the config says ${cfg.chainId} (${cfg.chainName}). Stopped.`);
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, prov);
const owner = ethers.getAddress(a.owner ?? cfg.owner ?? wallet.address);
// [deposit (wei), eventName, owner, eventStart, claimDeadline, [disputeResolver, extraData, metaEvidenceURI, policyURI]]
const params = deployArgs(cfg, owner);
const [deposit, eventName, , start, end, [resolver, , metaEvidenceURI, policyURI]] = params;
const k = klerosConfig(cfg);

const { abi, bytecode } = loadAbi("TruthPaysKickback");
console.log(`Deploying "${eventName}" on ${cfg.chainName} (chain ${cfg.chainId}): deposit ${fmtEth(deposit)}, owner ${owner}`);
console.log(`  attendance list from ${new Date(start * 1000).toISOString()}, by ${new Date(end * 1000).toISOString()}`);
console.log(`  Kleros: Dispute Resolver ${resolver}, court ${k.court}, ${k.jurors} jurors`);
console.log(`  metaevidence ${metaEvidenceURI || "(none)"}, policy ${policyURI || "(none)"}`);
const c = await new ethers.ContractFactory(abi, bytecode, wallet).deploy(...params, { chainId: cfg.chainId });
await c.waitForDeployment();
const addr = await c.getAddress();
const receipt = await c.deploymentTransaction().wait();
const { timestamp } = await prov.getBlock(receipt.blockNumber);
console.log(`✅ Deployed: ${addr} (block ${receipt.blockNumber})\n   ${cfg.explorer}/address/${addr}`);
console.log(`Put this in the config: "receiver" and "contract": "${addr}", "deployBlock": "${receipt.blockNumber}", ` +
  `"depositOpensAt": "${new Date(Number(timestamp) * 1000).toISOString()}". Then share the address as the deposit address (Ethereum mainnet only).`);
