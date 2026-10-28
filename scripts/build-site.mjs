#!/usr/bin/env node
// Builds the public guest deposit page with the live contract baked in.
//
//   node scripts/build-site.mjs [--config config.json] [--out site/dist]
//
// The page never takes the deposit address from the URL or anywhere else at runtime, so a
// look-alike link can't point guests at another address. Re-run after every deploy.
//
//   node scripts/build-site.mjs --generic [--config config.json] [--out site/dist]
//
// builds instead the guest page for any kickback deposit contract (published at /event/): it has no
// contract of its own and takes it from the organiser's link, ?contract=0x…&from=<block it was created
// in>, then reads the event, the deposit and the jurors' policy from that contract. It refuses a
// contract that isn't a kickback contract or whose disputes don't go to Kleros's own Dispute Resolver.
// From the config it only takes the network: chain, RPC, explorer, log chunk and the Kleros addresses.
//
// site/index.html holds both. Markup that differs sits in comment pairs, on their own lines or on one:
//   <!--baked-->Truth Pays markup<!--generic:generic markup-->
// The default build keeps the first part, --generic the second; either way the markers go.
import fs from "node:fs";
import path from "node:path";
import { ethers } from "ethers";
import { args, loadConfig, klerosConfig, isIpfsPath, KLEROS, isKnownResolver } from "./lib.mjs";

const a = args();
const cfg = loadConfig(a.config ?? "config.json");
const out = a.out ?? "site/dist";
const generic = !!a.generic;
const isAddr = (x) => /^0x[0-9a-fA-F]{40}$/.test(x || "");
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
if (generic && a.preview) fail("--generic builds a page for the contract named in its link: leave out --preview.");
if (!generic && !isAddr(cfg.contract) && !a.preview)
  fail('No live "contract" in the config yet. Deploy first, or pass --preview for a page without an address.');
// The page reads each guest's earlier deposits from this block on. Without it, it would search the whole chain,
// which public RPCs refuse, and the page would block every deposit with "couldn't check for an earlier deposit".
const deployBlock = Number(cfg.deployBlock || 0);
if (!generic && !a.preview && !(Number.isInteger(deployBlock) && deployBlock > 0))
  fail('No "deployBlock" in the config. Set it to the block number of the deploy transaction (shown on Etherscan), then build again.');
// every read on the page goes through this RPC, before a wallet is even connected
if (!/^https?:\/\//.test(cfg.rpcUrl || "")) fail('No "rpcUrl" in the config: the page needs a public RPC to read the contract.');
const k = klerosConfig(cfg);
// The generic page trusts any contract whose Dispute Resolver is this one: on a network where Kleros has its own
// (Ethereum mainnet), only Kleros's. A config pointing elsewhere (a local test chain) is taken as it is.
if (generic && KLEROS[cfg.chainId] && !isKnownResolver(cfg.chainId, k.disputeResolver))
  fail(`The generic page only works with Kleros's own Dispute Resolver (${KLEROS[cfg.chainId].disputeResolver}), but the config names ${k.disputeResolver}.`);
if (generic && KLEROS[cfg.chainId] && k.arbitrator.toLowerCase() !== KLEROS[cfg.chainId].arbitrator.toLowerCase())
  fail(`The generic page only works with Kleros Court (${KLEROS[cfg.chainId].arbitrator}), but the config names ${k.arbitrator || "no court"}.`);
const network = {
  chainId: Number(cfg.chainId),
  // for wallet_addEthereumChain; the page's own text says "Ethereum mainnet"
  chainName: cfg.chainId === 1 ? "Ethereum" : cfg.chainName,
  rpc: cfg.rpcUrl,
  // eth_getLogs is asked for this many blocks at a time (public mainnet RPCs refuse long ranges)
  logChunk: cfg.logChunk,
  explorer: cfg.explorer,
};
// Kleros Court v1: the Dispute Resolver the contract must use (checked on the page), KlerosLiquid, the court site,
// and the IPFS upload service and gateway for evidence
const kleros = { klerosResolver: k.disputeResolver, klerosArbitrator: k.arbitrator, klerosCourt: k.courtUrl };
const ipfs = { ipfsUpload: k.ipfsUpload, ipfsGateway: k.ipfsGateway };
const site = generic
  ? {
      generic: true,
      // all three from the link and the contract (loadEvent on the page)
      contract: "",
      deployBlock: 0,
      ...network,
      depositWei: "0",
      ...kleros,
      klerosPolicy: "",
      ...ipfs,
    }
  : {
      contract: a.preview ? "" : cfg.contract,
      deployBlock: a.preview ? 0 : deployBlock,
      ...network,
      // the deposit in ETH for the text, and in wei for the checks and the transaction
      deposit: ethers.formatEther(cfg.depositUnits).replace(/\.0$/, ""),
      depositWei: cfg.depositUnits.toString(),
      lumaUrl: cfg.lumaUrl ?? "https://luma.com/qewnqhas",
      ...kleros,
      klerosPolicy: isIpfsPath(k.policyURI) ? k.policyURI : "",
      ...ipfs,
    };
const src = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const start = src.indexOf("/*CONFIG*/"), end = src.indexOf("/*END CONFIG*/");
if (start < 0 || end < 0) throw new Error("CONFIG markers missing in site/index.html");
let html = src.slice(0, start) + `/*CONFIG*/\nconst CONFIG = ${JSON.stringify(site, null, 2)};\n` + src.slice(end);
// the baked / generic markup: whole lines first, then pairs within a line
const keep = (_, baked, other) => (generic ? other : baked);
html = html.replace(/^<!--baked-->\n([\s\S]*?)^<!--generic:\n([\s\S]*?)^-->\n/gm, keep).replace(/<!--baked-->(.*?)<!--generic:(.*?)-->/g, keep);
if (/<!--(baked|generic:)/.test(html)) throw new Error("Unmatched baked / generic markers in site/index.html");
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
if (generic) console.log(`Wrote ${path.join(out, "index.html")}: the guest page for any kickback contract on chain ${site.chainId}, named by its link (?contract=0x…&from=<block>)`);
else console.log(`Wrote ${path.join(out, "index.html")} for contract ${site.contract || "(preview, no address)"} on chain ${site.chainId}, deposit ${site.deposit} ETH`);
