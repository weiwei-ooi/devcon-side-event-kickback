#!/usr/bin/env node
// Builds the public guest deposit page with the live contract baked in.
//
//   node scripts/build-site.mjs [--config config.json] [--out site/dist]
//
// The page never takes the deposit address from the URL or anywhere else at runtime, so a
// look-alike link can't point guests at another address. Re-run after every deploy.
import fs from "node:fs";
import path from "node:path";
import { args, loadConfig, klerosConfig } from "./lib.mjs";

const a = args();
const cfg = loadConfig(a.config ?? "config.json");
const out = a.out ?? "site/dist";
const isAddr = (x) => /^0x[0-9a-fA-F]{40}$/.test(x || "");
if (!isAddr(cfg.contract) && !a.preview) {
  console.error('No live "contract" in the config yet. Deploy first, or pass --preview for a page without an address.');
  process.exit(1);
}
const site = {
  contract: a.preview ? "" : cfg.contract,
  deployBlock: Number(cfg.deployBlock || 0),
  chainId: Number(cfg.chainId),
  chainName: cfg.chainId === 42161 ? "Arbitrum One" : cfg.chain || "custom network",
  rpc: cfg.rpcUrl,
  explorer: cfg.explorer,
  usdc: cfg.token,
  deposit: String(cfg.deposit),
  decimals: Number(cfg.decimals ?? 6),
  lumaUrl: cfg.lumaUrl ?? "https://luma.com/qewnqhas",
  klerosCourt: klerosConfig(cfg).courtUrl,
};
const src = fs.readFileSync(new URL("../site/index.html", import.meta.url), "utf8");
const start = src.indexOf("/*CONFIG*/"), end = src.indexOf("/*END CONFIG*/");
if (start < 0 || end < 0) throw new Error("CONFIG markers missing in site/index.html");
const html = src.slice(0, start) + `/*CONFIG*/\nconst CONFIG = ${JSON.stringify(site, null, 2)};\n` + src.slice(end);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
console.log(`Wrote ${path.join(out, "index.html")} for contract ${site.contract || "(preview, no address)"} on chain ${site.chainId}`);
