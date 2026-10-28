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

/**
 * The kickback deposit contract's runtime code, for pages that check a contract's code before they
 * trust its answers (core.mjs readEvent with `runtime`): { sha256 (core.mjs codeFingerprint of the
 * runtime code), immutables ([start, length] byte ranges of its immutable values) }. Compiles
 * build/TruthPaysKickback.standard-input.json (written by `npm run compile`; the live contract was
 * verified on Etherscan from the same input) with solc, asking only for more outputs: the compile
 * settings are untouched, and the creation code must be the one in build/TruthPaysKickback.json.
 */
export async function kickbackRuntime() {
  const inputFile = path.join(ROOT, "build", "TruthPaysKickback.standard-input.json");
  const artifactFile = path.join(ROOT, "build", "TruthPaysKickback.json");
  if (!fs.existsSync(inputFile) || !fs.existsSync(artifactFile)) throw new Error("build/TruthPaysKickback.json is missing: run `npm run compile` first.");
  const input = JSON.parse(fs.readFileSync(inputFile, "utf8"));
  input.settings.outputSelection = { "*": { TruthPaysKickback: ["evm.bytecode.object", "evm.deployedBytecode.object", "evm.deployedBytecode.immutableReferences"] } };
  const { default: solc } = await import("solc");
  const out = JSON.parse(solc.compile(JSON.stringify(input)));
  const c = Object.values(out.contracts ?? {}).find((x) => x.TruthPaysKickback)?.TruthPaysKickback;
  if (!c) throw new Error(`Could not compile ${inputFile}: ${(out.errors ?? []).map((e) => e.message).join("; ")}`);
  if ("0x" + c.evm.bytecode.object !== JSON.parse(fs.readFileSync(artifactFile, "utf8")).bytecode)
    throw new Error("build/TruthPaysKickback.json and build/TruthPaysKickback.standard-input.json disagree: run `npm run compile` again.");
  const immutables = Object.values(c.evm.deployedBytecode.immutableReferences ?? {}).flat().map((r) => [r.start, r.length]).sort((a, b) => a[0] - b[0]);
  return { sha256: core.codeFingerprint("0x" + c.evm.deployedBytecode.object, immutables), immutables };
}

/**
 * The baked guest page (scripts/build-site.mjs without --generic: a deposit page with its contract
 * built in, like the live Truth Pays page) in `dir` or in a folder above it, or null. The generic
 * guest page and the admin panel must not be published on that page's website: a link to them there
 * would look like the event's own.
 */
export function bakedGuestPageAbove(dir) {
  for (let d = path.resolve(dir); ; d = path.dirname(d)) {
    const f = path.join(d, "index.html");
    let html = "";
    try { html = fs.readFileSync(f, "utf8"); } catch {}
    const m = html.match(/\/\*CONFIG\*\/\s*const CONFIG = ([\s\S]*?);\s*\/\*END CONFIG\*\//);
    if (m) {
      try { const c = JSON.parse(m[1]); if (!c.generic && /^0x[0-9a-fA-F]{40}$/.test(c.contract ?? "")) return f; } catch {}
    }
    if (path.dirname(d) === d) return null;
  }
}
