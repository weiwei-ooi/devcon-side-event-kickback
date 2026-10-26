#!/usr/bin/env node
// Deploy TruthPaysKickback (developers only; the organiser deploys from the owner console).
//
//   PRIVATE_KEY=0x… node scripts/deploy.mjs [--config config.json] [--owner 0x…]
//
// The deployer only pays gas; --owner (or config.owner) becomes the contract owner.
// Timing comes from config: the attendance list can be posted from "eventStart"; after
// "claimDeadline" (at least 7 days later) it can no longer be posted and stakers can withdraw.
// Kleros settings come from config.kleros (see klerosConfig in lib.mjs).
import { ethers } from "ethers";
import { args, loadConfig, provider, loadAbi, deployArgs } from "./lib.mjs";

const a = args();
const cfg = loadConfig(a.config ?? "config.json");
if (!process.env.PRIVATE_KEY) throw new Error("Set PRIVATE_KEY (deployer, only needs gas)");
const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, provider(cfg));
const owner = ethers.getAddress(a.owner ?? cfg.owner ?? wallet.address);
const params = deployArgs(cfg, owner);

const { abi, bytecode } = loadAbi("TruthPaysKickback");
console.log(`Deploying on chain ${cfg.chainId}: token ${cfg.token}, deposit ${cfg.deposit}, owner ${owner}`);
console.log(`  attendance list from ${new Date(params[4] * 1000).toISOString()}, by ${new Date(params[5] * 1000).toISOString()}`);
console.log(`  Kleros: DisputeResolver ${params[6][0]}, policy ${params[6][2] || "(none)"}`);
const c = await new ethers.ContractFactory(abi, bytecode, wallet).deploy(...params);
await c.waitForDeployment();
const addr = await c.getAddress();
const receipt = await c.deploymentTransaction().wait();
console.log(`✅ Deployed: ${addr} (block ${receipt.blockNumber})\n   ${cfg.explorer}/address/${addr}`);
console.log(`Put this in config.json as both "receiver" and "contract", and share it as the deposit address.`);
