#!/usr/bin/env node
// Builds the hosted admin panel: the owner console (console/index.html) as a static page anyone can
// open, for any event, with their own browser wallet. No server, no config file, no private key.
//
//   node scripts/build-admin.mjs --out <dir> [--config config.json] [--guest-page ../event/]
//
// Writes exactly four files to <dir>:
//   index.html      the console in "hosted" mode, with its settings baked in (network, RPC, Kleros
//                   contracts and services, the generic juror policy and case description template,
//                   and the config's contract as the event it opens by default)
//   ethers.min.js   ethers (ES module build), from node_modules
//   core.mjs        scripts/core.mjs: the same checks as the scripts (Luma list, payouts, deploy)
//   kickback.json   the compiled contract (ABI and bytecode), to read events and create new ones
// --guest-page is where the guest deposit page lives, relative to the panel (default ../event/):
// the panel links guests to <guest page>?contract=…&from=…
// Never publish the panel (or the generic guest page) on the website of a baked guest page such as
// the live Truth Pays page: the build refuses an --out inside a folder that holds one.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { args, loadConfig, klerosConfig, KLEROS, GENERIC_POLICY, GENERIC_METAEVIDENCE_TEMPLATE, ipfsPathOf, caseTemplate, EVENT_FIELDS, isContractCode, kickbackRuntime, bakedGuestPageAbove } from "./lib.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const fail = (msg) => {
  console.error(msg);
  process.exit(1);
};
const a = args();
if (!a.out || a.out === true) fail("Usage: node scripts/build-admin.mjs --out <dir> [--config config.json] [--guest-page ../event/]");
const out = path.resolve(a.out);
const guestPage = typeof a["guest-page"] === "string" ? a["guest-page"] : "../event/";
const baked = bakedGuestPageAbove(out);
if (baked) fail(`${out} is inside the website of the deposit page ${baked}. The admin panel must live on another website: guests trust that one for its own event only.`);

// the compiled contract: new events are created from its bytecode
const artifactFile = path.join(ROOT, "build", "TruthPaysKickback.json");
if (!fs.existsSync(artifactFile)) fail("build/TruthPaysKickback.json is missing: run `npm run compile` first.");
const artifact = JSON.parse(fs.readFileSync(artifactFile, "utf8"));
if (!Array.isArray(artifact.abi) || !/^0x[0-9a-fA-F]+$/.test(artifact.bytecode ?? "") || !isContractCode(artifact.bytecode))
  fail("build/TruthPaysKickback.json has no ABI or bytecode: run `npm run compile` again.");
// its runtime code: an event is opened only if its contract has this code (answers can be faked)
let runtime;
try { runtime = await kickbackRuntime(); } catch (e) { fail(e.message); }

let cfg, k;
try {
  cfg = loadConfig(typeof a.config === "string" ? a.config : "config.json");
  k = klerosConfig(cfg);
} catch (e) {
  fail(e.message);
}
if (!/^https?:\/\//.test(cfg.rpcUrl || "")) fail('No "rpcUrl" in the config: the panel reads every event through it.');
// on a known network (Ethereum mainnet), only Kleros's own Dispute Resolver and court
const known = KLEROS[cfg.chainId];
if (known) {
  if (k.disputeResolver.toLowerCase() !== known.disputeResolver.toLowerCase())
    fail(`The config names ${k.disputeResolver} as Kleros's Dispute Resolver, not Kleros's own ${known.disputeResolver}.`);
  if (k.arbitrator.toLowerCase() !== known.arbitrator.toLowerCase())
    fail(`The config names ${k.arbitrator} as Kleros's court, not KlerosLiquid ${known.arbitrator}.`);
} else if (!ethers.isAddress(k.arbitrator)) fail('Set "kleros.arbitrator" in the config for this network.');

// The generic texts every new event uses: the juror policy (its IPFS path is computed from the text, so
// the panel can check the pin) and the case description template, checked with example values.
const read = (rel) => {
  try { return fs.readFileSync(path.join(ROOT, rel), "utf8"); } catch { return fail(`${rel} is missing.`); }
};
const policyText = read(GENERIC_POLICY);
const templateText = read(GENERIC_METAEVIDENCE_TEMPLATE);
const policyURI = ipfsPathOf(policyText);
try {
  const owner = "0x259a1084C2043a7B3b5b288596E05C41b8EFa5d6";
  const values = { eventName: "Example event", deposit: "0.01 ETH", policyURI, owner, ownerLower: owner.toLowerCase(), explorer: cfg.explorer };
  for (const f of EVENT_FIELDS) if (f.key !== "eventName") values[f.key] = f.example;
  caseTemplate(templateText, values, { name: GENERIC_METAEVIDENCE_TEMPLATE });
} catch (e) {
  fail(e.message);
}

// the event the panel opens when its link names none: the config's deployed contract, if any
const deployBlock = Number(cfg.deployBlock || 0);
const defaultEvent = ethers.isAddress(cfg.contract ?? "") && Number.isInteger(deployBlock) && deployBlock > 0
  ? { contract: ethers.getAddress(cfg.contract), deployBlock } : null;

const HOSTED = {
  chainId: cfg.chainId,
  chainName: cfg.chainId === 1 ? "Ethereum mainnet" : cfg.chainName,
  rpcUrl: cfg.rpcUrl,
  explorer: cfg.explorer,
  logChunk: cfg.logChunk,
  kleros: {
    disputeResolver: k.disputeResolver,
    arbitrator: k.arbitrator,
    court: k.court,
    jurors: k.jurors,
    courtUrl: k.courtUrl,
    ipfsUpload: k.ipfsUpload,
    ipfsGateway: k.ipfsGateway,
  },
  policy: { file: GENERIC_POLICY, uri: policyURI, text: policyText },
  template: { file: GENERIC_METAEVIDENCE_TEMPLATE, text: templateText },
  defaultEvent,
  artifact: "kickback.json",
  runtime,
  guestPage,
};

// inside <script>: nothing in the texts may close the script tag
const json = JSON.stringify(HOSTED, null, 2).replace(/</g, "\\u003c").replace(/[\u2028\u2029]/g, (c) => "\\u" + c.charCodeAt(0).toString(16));
let html = fs.readFileSync(path.join(ROOT, "console", "index.html"), "utf8");
const once = (from, to, what) => {
  const n = html.split(from).length - 1;
  if (n !== 1) fail(`console/index.html: expected ${what} once, found it ${n} times.`);
  html = html.replace(from, () => to);
};
const start = html.indexOf("/*HOSTED*/"), end = html.indexOf("/*END HOSTED*/");
if (start < 0 || end < start || html.indexOf("/*HOSTED*/", start + 1) >= 0) fail("console/index.html: the /*HOSTED*/ … /*END HOSTED*/ markers are missing.");
html = html.slice(0, start) + `/*HOSTED*/ const HOSTED = ${json}; ` + html.slice(end);
once(`"ethers": "/node_modules/ethers/dist/ethers.min.js"`, `"ethers": "./ethers.min.js"`, "the import map entry for ethers");
once(`"kickback/core": "/scripts/core.mjs"`, `"kickback/core": "./core.mjs"`, "the import map entry for the core");
once("<body>", '<body class="hosted">', "<body>");
html = html.replace(/<title>[^<]*<\/title>/, "<title>Kickback · Admin panel</title>");

fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "index.html"), html);
fs.copyFileSync(path.join(ROOT, "node_modules", "ethers", "dist", "ethers.min.js"), path.join(out, "ethers.min.js"));
fs.copyFileSync(path.join(ROOT, "scripts", "core.mjs"), path.join(out, "core.mjs"));
fs.writeFileSync(path.join(out, "kickback.json"), JSON.stringify({ abi: artifact.abi, bytecode: artifact.bytecode }));
console.log(`Wrote the admin panel to ${out} (index.html, ethers.min.js, core.mjs, kickback.json) for ${HOSTED.chainName} (chain ${HOSTED.chainId}).`);
console.log(`Juror policy for new events: ${GENERIC_POLICY} at ${policyURI} (the panel saves it on IPFS before the first new event if needed).`);
console.log(defaultEvent ? `Opens by default: ${defaultEvent.contract} (deploy block ${defaultEvent.deployBlock}).` : "No default event: the panel opens the contract named in its link (?contract=…&from=…).");
