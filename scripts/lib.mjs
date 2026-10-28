// Shared helpers for the Node scripts: everything in core.mjs (settings, Kleros settings, the case
// description, CSV text, Luma columns, deposit verification, chunked log scans, the lists), plus the
// parts that need Node: command-line arguments, reading the config and the case description template
// from files, the RPC provider, CSV/JSON files and the compiled contract.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "csv-parse/sync";
import { ethers } from "ethers";
import * as core from "./core.mjs";
import { normalizeConfig, DEFAULT_METAEVIDENCE_TEMPLATE, toCsv } from "./core.mjs";

export * from "./core.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ---------------------------------------------------------------- args / config

export function args(argv = process.argv.slice(2)) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith("--")) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("--")) out[k] = true;
      else (out[k] = next), i++;
    } else out._.push(a);
  }
  return out;
}

/**
 * Reads a config file (config.json live, config.rehearsal.json rehearsal) and adds what every
 * script needs (core.mjs normalizeConfig): chainId, explorer, symbol/decimals (always ETH / 18), the
 * deposit and pool cap in wei (depositUnits, poolCapUnits), the deposit address (receiver), the
 * deposit window and contract times in unix seconds, deployBlock and logChunk.
 */
export function loadConfig(file = "config.json") {
  return normalizeConfig(JSON.parse(fs.readFileSync(file, "utf8")), file);
}

/** The case description template file of a config (kleros.metaEvidenceTemplate, from the repo root) and its text. */
export function readTemplate(cfg) {
  const k = cfg.kleros ?? {};
  const file = path.resolve(ROOT, k.metaEvidenceTemplate || DEFAULT_METAEVIDENCE_TEMPLATE);
  let text;
  try { text = fs.readFileSync(file, "utf8"); } catch { throw new Error(`Case description template not found: ${file} ("kleros.metaEvidenceTemplate")`); }
  return { file, text };
}

/**
 * The case description template for the deploy (see core.mjs caseTemplate): reads
 * kleros.metaEvidenceTemplate, fills the deploy-time placeholders from the config and splits it at
 * {{wallet}} / {{contract}} / {{walletLower}}. Returns { file, pieces, slots (hex), sample }.
 * Given a template text and values instead (caseTemplate(text, values)), it is core.mjs caseTemplate.
 */
export function caseTemplate(cfg, owner, opts) {
  if (typeof cfg === "string") return core.caseTemplate(cfg, owner, opts);
  const { file, text } = readTemplate(cfg);
  return { file, ...core.caseTemplate(text, core.templateValues(cfg, owner), { name: path.basename(file) }) };
}

/**
 * Constructor arguments for TruthPaysKickback (see core.mjs deployArgs), with the case description
 * template read from kleros.metaEvidenceTemplate (or the template text given as third argument).
 */
export function deployArgs(cfg, owner, templateText) {
  if (typeof templateText === "string") return core.deployArgs(cfg, owner, templateText);
  core.deploySettings(cfg, owner); // dates, deposit, Kleros settings and owner first, as before reading the template
  const { file, text } = readTemplate(cfg);
  return core.deployArgs(cfg, owner, text, { name: path.basename(file) });
}

export function provider(cfg) {
  const url = process.env.RPC_URL || cfg.rpcUrl;
  if (!url) throw new Error("Set rpcUrl in config.json or RPC_URL env var");
  return new ethers.JsonRpcProvider(url, cfg.chainId ? Number(cfg.chainId) : undefined, { staticNetwork: !!cfg.chainId });
}

// ---------------------------------------------------------------- CSV / JSON files

export function readCsv(file) {
  return parse(fs.readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
}

export function writeCsv(file, rows, headers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, toCsv(rows, headers));
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
}

export function loadAbi(name) {
  const p = new URL(`../build/${name}.json`, import.meta.url);
  if (!fs.existsSync(p)) throw new Error("Run `npm run compile` first");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
