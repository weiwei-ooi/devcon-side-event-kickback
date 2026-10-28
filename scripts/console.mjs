#!/usr/bin/env node
// Serves the owner console at http://localhost:8787 so the organiser can deploy and run owner
// actions by clicking buttons and confirming in her browser wallet. Keys never leave the wallet.
//
//   npm run console            (live: config.json, out/)
//   npm run console:rehearsal  (throwaway contract on Ethereum mainnet: config.rehearsal.json, out-rehearsal/)
//
// Besides the files below, /settings.json is the chosen config as the scripts read it (lib.mjs
// loadConfig, klerosConfig, deployArgs): network, deposit in wei, Kleros addresses, and the exact
// constructor arguments, or the reason a deploy would be refused. The page deploys with those, so
// the console and the scripts always agree on the settings.
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { exec } from "node:child_process";
import { ethers } from "ethers";
import { loadConfig, klerosConfig, deployArgs, KLEROS } from "./lib.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const PORT = Number(process.env.PORT || 8787);
const arg = (k) => { const i = process.argv.indexOf(k); return i > 0 ? process.argv[i + 1] : undefined; };
const CONFIG = arg("--config") || "config.json";
const OUT = arg("--out") || "out";
const ALLOWED = [
  "console/index.html",
  "node_modules/ethers/dist/ethers.umd.min.js",
  // the shared core (scripts/core.mjs) as an ES module, and the ethers ESM build it imports: a page maps
  // "ethers" to /node_modules/ethers/dist/ethers.min.js with an import map
  "scripts/core.mjs",
  "node_modules/ethers/dist/ethers.min.js",
  "build/TruthPaysKickback.json",
  "config.json",
  "out/new-stakers.json",
  "out/attendees.json",
  "out/refunds.json",
  "out/payout-plan.json",
  "out/payout-summary.md",
];
const TYPES = { ".html": "text/html", ".js": "text/javascript", ".mjs": "text/javascript", ".json": "application/json", ".md": "text/plain" };

if (!fs.existsSync(path.join(root, "build/TruthPaysKickback.json"))) {
  console.error("Run `npm run compile` first.");
  process.exit(1);
}

// The config as the scripts see it, read fresh on every request. `configHash` lets the page check
// that these settings come from the same config text it was opened with.
function settings() {
  const file = path.join(root, CONFIG);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { return { error: `${CONFIG} not found. Ask Claude to create it.` }; }
  const out = { configHash: ethers.id(text) };
  let cfg, k;
  try {
    cfg = loadConfig(file);
    k = klerosConfig(cfg);
  } catch (e) {
    return { ...out, error: `${CONFIG}: ${e.message}` };
  }
  Object.assign(out, {
    chainId: cfg.chainId,
    chainName: cfg.chainName,
    rpcUrl: cfg.rpcUrl,
    explorer: cfg.explorer,
    symbol: cfg.symbol,
    deposit: cfg.deposit,
    depositWei: cfg.depositUnits,
    poolCap: cfg.poolCap ?? null,
    poolCapWei: cfg.poolCapUnits ?? null,
    logChunk: cfg.logChunk,
    deployBlock: cfg.deployBlock ?? null,
    kleros: k,
    knownKleros: KLEROS[cfg.chainId] ?? null,
  });
  // the owner is the connected wallet: the page puts it in place of this placeholder
  try { out.deployArgs = deployArgs(cfg, ethers.ZeroAddress); } catch (e) { out.deployError = e.message; }
  return out;
}
const toJson = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

http
  .createServer((req, res) => {
    // only this computer's own pages may talk to the console (blocks DNS-rebinding sites)
    const host = String(req.headers.host ?? "");
    if (host !== `localhost:${PORT}` && host !== `127.0.0.1:${PORT}`) return res.writeHead(403).end("forbidden");
    let p;
    try {
      p = decodeURIComponent(new URL(req.url, "http://x").pathname).replace(/^\/+/, "");
    } catch {
      return res.writeHead(400).end("bad request");
    }
    if (p === "") p = "console/index.html";
    if (p === "settings.json") {
      res.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" });
      return res.end(toJson(settings()));
    }
    if (!ALLOWED.includes(p)) return res.writeHead(404).end("not found");
    // The page always asks for config.json and out/…; serve the chosen config and output folder.
    const file = path.join(root, p === "config.json" ? CONFIG : p.replace(/^out\//, OUT + "/"));
    if (!fs.existsSync(file)) return res.writeHead(404).end("missing: " + p);
    res.writeHead(200, { "content-type": TYPES[path.extname(p)] || "application/octet-stream", "cache-control": "no-store" });
    fs.createReadStream(file).on("error", () => res.end()).pipe(res);
  })
  .listen(PORT, "127.0.0.1", () => {
    const url = `http://localhost:${PORT}`;
    console.log(`Owner console: ${url}  (${CONFIG}, ${OUT}/)  (Ctrl+C to stop)`);
    // the files it serves are fixed when it starts: an updated page would ask for files this process refuses
    console.log("After updating these files, stop this console (Ctrl+C) and start it again before reloading the page.");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    exec(`${opener} ${url}`, () => {});
  });
