// Shared core of the scripts, the owner console and the admin panel: settings, Kleros settings, the
// case description (per-case metaevidence) and its IPFS path, CSV text, Luma column detection, deposit
// verification (from the contract's own Deposited events), chunked log scans with retries, and the
// lists verify-deposits.mjs and build-payout.mjs write (checkGuests, buildPayout), returned as data,
// and a deposits table for a page that has no Luma export (depositsOverview).
//
// Browser-safe: it imports only { ethers } from "ethers" and never touches files, the process or
// Node's Buffer. Node code imports it through scripts/lib.mjs (which adds the file and RPC parts); a
// page loads it as an ES module with an import map that maps "ethers" to ethers' ESM build:
//   <script type="importmap">{ "imports": { "ethers": "/node_modules/ethers/dist/ethers.min.js" } }</script>
//   <script type="module"> import { checkGuests, parseCsv } from "/scripts/core.mjs"; … </script>
import { ethers } from "ethers";

// A deposit is the contract's own Deposited event (receive() or deposit()): `from` is the wallet that
// sent the ETH (a Safe or smart wallet shows up as its own address), `amount` is in wei.
export const DEPOSITED_EVENT = "event Deposited(address indexed from, uint256 amount)";
const DEPOSITED = new ethers.Interface([DEPOSITED_EVENT]);
export const DEPOSITED_TOPIC = DEPOSITED.getEvent("Deposited").topicHash;
// An ERC-20 token transfer (USDC…). Tokens sent to the deposit contract are never a deposit.
export const TOKEN_TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// The deposit is native ETH on Ethereum mainnet (27 Oct 2026: moved from 25 USDC on Arbitrum One).
// A local test chain uses another "chain" name and sets "chainId" (and "rpcUrl") itself.
export const CHAINS = {
  ethereum: { chainId: 1, name: "Ethereum mainnet", explorer: "https://etherscan.io" },
};
export const SYMBOL = "ETH";
export const DECIMALS = 18;
/** Public RPC that answers eth_getLogs on old block ranges in 5,000-block chunks (publicnode only serves
 * recent blocks, flashbots returned nothing on old ranges). Scripts scan logs in `logChunk` blocks with retries. */
export const DEFAULT_RPC = "https://rpc.mevblocker.io";
export const DEFAULT_LOG_CHUNK = 5000;
/** Sanity cap: a deposit above this is almost surely a stale amount (e.g. "25" from the USDC days). */
export const MAX_DEPOSIT_ETH = "1";

// ---------------------------------------------------------------- config

// Dates must carry a timezone, otherwise they would be read in the computer's local time.
function parseDate(cfg, key) {
  const v = cfg[key];
  if (v === undefined || v === null || v === "") return undefined;
  const t = Date.parse(v);
  if (Number.isNaN(t) || !/(Z|[+-]\d\d:\d\d)$/.test(String(v)))
    throw new Error(`"${key}" in the config must be an ISO date with timezone, e.g. 2026-11-04T18:00:00+05:30 (got "${v}")`);
  return Math.floor(t / 1000);
}

/** An ETH amount from the config ("0.01") in wei. */
function parseEth(cfg, key, file) {
  const v = String(cfg[key] ?? "").trim();
  let wei;
  try {
    wei = ethers.parseEther(v);
  } catch {
    throw new Error(`"${key}" in ${file} must be an amount of ETH such as "0.01" (got "${cfg[key] ?? ""}")`);
  }
  return wei;
}

/**
 * A config object (config.json live, config.rehearsal.json rehearsal, or one built by a page) with
 * what every script needs added: chainId, explorer, symbol/decimals (always ETH / 18), the deposit and
 * pool cap in wei (depositUnits, poolCapUnits), the deposit address (receiver), the deposit window and
 * contract times in unix seconds, deployBlock and logChunk. `file` names the config in messages.
 * (lib.mjs loadConfig reads the file and calls this.) `depositCap: false` accepts a deposit above
 * MAX_DEPOSIT_ETH (an existing contract's own amount, read on-chain: contractConfig).
 */
export function normalizeConfig(cfg, file = "config.json", { depositCap = true } = {}) {
  if (cfg.token || cfg.tokenDecimals)
    throw new Error(`${file} still has "token"/"tokenDecimals": deposits are in ETH now. Remove them and set "deposit" in ETH (e.g. "0.01").`);
  const chain = CHAINS[cfg.chain];
  if (!chain && !cfg.chainId)
    throw new Error(`Unknown chain "${cfg.chain}" in ${file}: use "ethereum" (Ethereum mainnet), or set "chainId" for a local test chain`);
  const chainId = Number(cfg.chainId ?? chain.chainId);
  if (chain && chainId !== chain.chainId) throw new Error(`"chainId" ${chainId} in ${file} does not match chain "${cfg.chain}" (${chain.chainId})`);

  const depositUnits = parseEth(cfg, "deposit", file);
  if (depositUnits <= 0n) throw new Error(`"deposit" in ${file} must be more than 0 ETH`);
  if (depositCap && depositUnits > ethers.parseEther(MAX_DEPOSIT_ETH))
    throw new Error(`"deposit" in ${file} is ${cfg.deposit} ETH: more than ${MAX_DEPOSIT_ETH} ETH looks like a mistake (an old USDC amount?)`);
  const poolCapUnits = cfg.poolCap ? parseEth(cfg, "poolCap", file) : undefined;

  const opensAt = parseDate(cfg, "depositOpensAt");
  const deadline = parseDate(cfg, "depositDeadline");
  const eventStartTs = parseDate(cfg, "eventStart");
  const claimDeadlineTs = parseDate(cfg, "claimDeadline");
  if (cfg.contract && cfg.receiver && cfg.contract.toLowerCase() !== cfg.receiver.toLowerCase())
    throw new Error('"receiver" and "contract" in the config must be the same address (the deployed contract)');
  const logChunk = Number(cfg.logChunk);
  return {
    ...cfg,
    chainId,
    chainName: cfg.chainName ?? chain?.name ?? String(cfg.chain ?? "custom network"),
    rpcUrl: cfg.rpcUrl || (chain ? DEFAULT_RPC : ""),
    explorer: cfg.explorer ?? chain?.explorer ?? "",
    symbol: SYMBOL,
    decimals: DECIMALS,
    depositUnits,
    poolCapUnits,
    receiver: ethers.getAddress(cfg.contract || cfg.receiver),
    opensAt: opensAt ?? 0,
    deadline: deadline ?? Infinity,
    // contract timing: payout allowed from eventStart; after claimDeadline guests can withdraw themselves
    eventStartTs,
    claimDeadlineTs,
    deployBlock: cfg.deployBlock ? Number(cfg.deployBlock) : undefined,
    logChunk: Number.isInteger(logChunk) && logChunk > 0 ? logChunk : DEFAULT_LOG_CHUNK,
    columns: cfg.columns ?? {},
  };
}

export const MIN_SETTLEMENT_WINDOW = 7 * 24 * 3600; // must match the contract
export const CHALLENGE_PERIOD = 24 * 3600; // must match the contract
export const MATCH_PERIOD = 24 * 3600; // must match the contract
export const PAYOUT_GAS = 40_000; // must match the contract: gas a batch payment may use in the recipient
/** EIP-7825 (Fusaka, December 2025): one Ethereum transaction may use at most 2^24 gas, whatever the block limit.
 * Gas limits with a margin over the estimate are capped at this, or the network refuses the transaction. */
export const TX_GAS_CAP = 16_777_216n;
/** The gas limit to send with: `margin` percent over the estimate, never above TX_GAS_CAP. */
export const gasLimitFor = (estimate, margin = 30n) => {
  const limit = (BigInt(estimate) * (100n + margin)) / 100n;
  return limit > TX_GAS_CAP ? TX_GAS_CAP : limit;
};

// Kleros Court v1 on Ethereum mainnet. Cases go through Kleros's general-purpose Dispute Resolver
// (ArbitrableProxy), whose arbitrator is KlerosLiquid. Evidence, appeals and appeal withdrawals are
// sent to the Dispute Resolver with the case's local ID; passPeriod / executeRuling go to KlerosLiquid
// with the arbitrator dispute ID. Case page: <court>/cases/<arbitrator dispute ID>.
export const KLEROS = {
  1: {
    disputeResolver: "0x4b89e798b10478a839ea0abcf86c4b94a3c782a4",
    arbitrator: "0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069",
    court: "https://court.kleros.io",
  },
};
// Kleros's IPFS upload service (POST multipart/form-data, field "data"; add ?operation=evidence&pinToGraph=false)
// and the gateway that serves the pinned files.
export const KLEROS_IPFS_UPLOAD = "https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs";
export const KLEROS_IPFS_GATEWAY = "https://cdn.kleros.link";
// Ruling options of an attendance case: 0 = refused to arbitrate (counts like "did not attend").
export const RULINGS = { refused: 0, attended: 1, absent: 2 };
// KlerosLiquid periods (disputes(id).period)
export const KLEROS_PERIODS = ["evidence", "commit", "vote", "appeal", "execution"];

/** "/ipfs/<CIDv0 or CIDv1>" with an optional "/file" path, as Kleros expects for policies and (meta)evidence. */
export const IPFS_PATH_RE = /^\/ipfs\/(Qm[1-9A-HJ-NP-Za-km-z]{44}|b[a-z2-7]{58,})(\/[^\s]+)?$/;
export const isIpfsPath = (v) => IPFS_PATH_RE.test(String(v ?? ""));
// Pins that describe an earlier version and must not be used any more: the policy for Arbitrum One,
// USDC and Kleros v2; the v6 policy and the v6 metaevidence shared by every case (wallet not named).
export const STALE_PINS = [
  "QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg",
  "QmWzCbhNEaySZ8EtFgPKuq4AYCtJba962S4VT77AGdw25B",
  "QmXAtWkxqrYPhriV4s1r7cQktEfF3498M6tmhKjXtvFUgU",
];

/**
 * Kleros settings from config.kleros, with mainnet defaults: General Court (0), 3 jurors.
 * Returns { disputeResolver, arbitrator, court, jurors, extraData, policyURI, metaEvidenceTemplate,
 * courtUrl, ipfsUpload, ipfsGateway }. `kleros.disputeResolver` / `kleros.arbitrator` override the
 * addresses (local tests); `arbitrator` is "" when unknown (the contract's `arbitrator()` has it).
 */
export function klerosConfig(cfg) {
  const k = cfg.kleros ?? {};
  if (k.metaEvidenceURI)
    throw new Error('"kleros.metaEvidenceURI" is gone (v7): each case gets its own description from "kleros.metaEvidenceTemplate". Remove it.');
  const known = KLEROS[Number(cfg.chainId)] ?? {};
  const disputeResolver = k.disputeResolver || known.disputeResolver;
  if (!disputeResolver) throw new Error('Set "kleros.disputeResolver" in the config for this network');
  const arbitrator = k.arbitrator || known.arbitrator || "";
  const court = Number(k.court ?? 0), jurors = Number(k.jurors ?? 3);
  if (!Number.isInteger(court) || court < 0) throw new Error(`"kleros.court" must be a court number such as 0 (got ${k.court})`);
  if (!Number.isInteger(jurors) || jurors < 1) throw new Error(`"kleros.jurors" must be a whole number of jurors such as 3 (got ${k.jurors})`);
  return {
    disputeResolver: ethers.getAddress(String(disputeResolver).toLowerCase()),
    arbitrator: arbitrator ? ethers.getAddress(String(arbitrator).toLowerCase()) : "",
    court,
    jurors,
    extraData: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [court, jurors]),
    policyURI: k.policyURI ?? "",
    metaEvidenceTemplate: k.metaEvidenceTemplate || DEFAULT_METAEVIDENCE_TEMPLATE,
    courtUrl: k.courtUrl || known.court || "https://court.kleros.io",
    ipfsUpload: k.ipfsUpload || KLEROS_IPFS_UPLOAD,
    ipfsGateway: k.ipfsGateway || KLEROS_IPFS_GATEWAY,
  };
}

// Contract enums
export const STATUS = { None: 0, Staker: 1, Paid: 2, Rejected: 3 };
export const PHASES = ["Open", "Listed", "Finalized", "Cancelled"];
export const CHALLENGE_STATE = { None: 0, Waiting: 1, Disputed: 2, Resolved: 3 };

// ---------------------------------------------------------------- case description (per-case metaevidence)
// Each Kleros case gets its own ERC-1497 metaevidence, written by the contract from a template fixed at
// deployment (kleros.metaEvidenceTemplate, default docs/metaevidence.template.json for the live event;
// docs/metaevidence.generic.template.json for events created from the admin panel). Placeholders:
//  - filled here, before the deploy: {{eventName}}, {{deposit}} ("0.01 ETH"), {{policyURI}}, {{owner}}
//    (the organiser's wallet, config "owner"), {{ownerLower}}, {{explorer}} ("https://etherscan.io"),
//    and for the generic template {{eventTitle}}, {{eventWhen}}, {{eventWhere}}, {{hosts}}, {{eventLink}};
//  - filled by the contract for each case: {{wallet}} (the challenged wallet) and {{contract}} (the
//    deposit contract), both as checksummed addresses. The template is passed as the text pieces
//    between them plus one slot byte per value (1 wallet, 2 contract).
// values the contract writes into each case: the challenged wallet and itself (checksummed), and the
// wallet in lower case (Kleros Court looks up evidence senders in "aliases" in lower case)
export const SLOT = { wallet: 1, contract: 2, walletLower: 3 };
export const MAX_METAEVIDENCE_BYTES = 262_144; // one IPFS block: the CID formula below (and the contract's) needs that
export const MAX_TEMPLATE_BYTES = 24_575; // the contract keeps abi.encode(pieces, slots) as contract code (24 KB limit)
export const DEFAULT_METAEVIDENCE_TEMPLATE = "docs/metaevidence.template.json";
// Event-neutral texts for any organiser's event (admin panel): the juror policy and the case description template
export const GENERIC_POLICY = "docs/attendance-policy.generic.md";
export const GENERIC_METAEVIDENCE_TEMPLATE = "docs/metaevidence.generic.template.json";

/** The CIDv0 ("Qm...") `ipfs add` gives these bytes with its default settings, for up to one block
 * (256 KiB): sha256 of a dag-pb node holding a UnixFS file, as a base58 multihash. Same as the contract. */
export function ipfsCidV0(data) {
  const bytes = typeof data === "string" ? ethers.toUtf8Bytes(data) : ethers.getBytes(data);
  if (bytes.length > MAX_METAEVIDENCE_BYTES) throw new Error("More than one IPFS block (256 KiB)");
  const varint = (n) => { const o = []; while (n >= 0x80) { o.push((n & 0x7f) | 0x80); n >>>= 7; } o.push(n); return o; };
  const size = varint(bytes.length);
  const file = ethers.concat([new Uint8Array([0x08, 0x02, 0x12, ...size]), bytes, new Uint8Array([0x18, ...size])]);
  const node = ethers.concat([new Uint8Array([0x0a, ...varint(ethers.getBytes(file).length)]), file]);
  return ethers.encodeBase58(ethers.concat(["0x1220", ethers.sha256(node)]));
}
/** "/ipfs/<CIDv0>" of a text, as the contract's caseMetaEvidence computes it. */
export const ipfsPathOf = (text) => "/ipfs/" + ipfsCidV0(text);

/** A case description from the template pieces: what the contract's caseMetaEvidence(wallet) returns. */
export function renderCase({ pieces, slots }, wallet, contract) {
  const values = ethers.getBytes(slots);
  let out = pieces[0];
  values.forEach((v, i) => {
    const value = v === SLOT.wallet ? ethers.getAddress(wallet) : v === SLOT.contract ? ethers.getAddress(contract) : ethers.getAddress(wallet).toLowerCase();
    out += value + pieces[i + 1];
  });
  return out;
}

/**
 * The event details a new event's case description names (docs/metaevidence.generic.template.json),
 * as the admin panel's form asks for them. `max` keeps the filled template well inside the contract's
 * limit (MAX_TEMPLATE_BYTES); caseTemplate checks the total size too.
 */
export const EVENT_FIELDS = [
  { key: "eventTitle", label: "Event title", max: 200, example: "Onchain Justice Night: Talks and Dinner" },
  { key: "eventName", label: "Short name", max: 80, example: "Onchain Justice Night, Berlin 2027" },
  { key: "eventWhen", label: "Date and time", max: 120, example: "Friday 12 March 2027, 19:00-23:00 CET" },
  // the venue as planned when the contract is created (it can't be changed later): a city is enough
  { key: "eventWhere", label: "Venue or city", max: 200, example: "Café Example, Main Street 1, Berlin" },
  { key: "hosts", label: "Hosts", max: 200, example: "Kleros and friends" },
  { key: "eventLink", label: "Registration link", max: 300, example: "https://luma.com/your-event", link: true },
];
// the deploy-time placeholders a template may use, and what to say when one has no value
const DEPLOY_PLACEHOLDERS = {
  eventName: "", deposit: "", policyURI: "", owner: "", ownerLower: "", explorer: "",
  ...Object.fromEntries(EVENT_FIELDS.filter((f) => f.key !== "eventName").map((f) => [f.key, f.label])),
};

/**
 * Characters that can disguise a text without showing: control characters (C0 and C1, line breaks
 * included), zero-width characters, the line and paragraph separators, text-direction marks and
 * overrides, and the byte-order mark. The generic guest page removes the same ones from an event's name.
 */
export const DISGUISE_RE = /[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff]/;

/**
 * Checks the form's event details (EVENT_FIELDS) and returns them trimmed, in Unicode NFC form (as
 * the preview shows them). Throws a plain message for the first field that is empty, too long, on
 * several lines or holding an invisible or text-direction character (DISGUISE_RE), holds "{{" or
 * "}}", or (the link) is not an https:// address; `error.fields` maps every wrong field's key to its message.
 */
export function eventDetails(input = {}) {
  const out = {}, fields = {};
  for (const f of EVENT_FIELDS) {
    const v = String(input[f.key] ?? "").normalize("NFC").trim();
    let why = "";
    if (!v) why = `${f.label}: please fill this in.`;
    else if (v.length > f.max) why = `${f.label} is too long (${v.length} characters, at most ${f.max}).`;
    else if (DISGUISE_RE.test(v)) why = `${f.label}: please keep it on one line, without invisible or text-direction characters.`;
    else if (/\{\{|\}\}/.test(v)) why = `${f.label} can't contain "{{" or "}}".`;
    else if (f.link && !/^https:\/\/[^\s/]+\.[^\s]+$/i.test(v)) why = `${f.label} must be a web address starting with https://`;
    if (why) fields[f.key] = why;
    else out[f.key] = v;
  }
  const wrong = Object.values(fields);
  if (wrong.length) throw Object.assign(new Error(wrong[0]), { fields });
  return out;
}

/**
 * The deploy-time values of the case description, from a loaded config (`owner` is the deploying
 * wallet, used when the config names no owner): eventName, deposit ("0.01 ETH"), policyURI, owner,
 * ownerLower, explorer, plus the generic template's eventTitle, eventWhen, eventWhere, hosts and
 * eventLink when the config has them (newEventConfig puts them there).
 */
export function templateValues(cfg, owner) {
  const organiser = cfg.owner && ethers.isAddress(cfg.owner) ? ethers.getAddress(cfg.owner) : owner && owner !== ethers.ZeroAddress ? ethers.getAddress(owner) : "";
  const values = {
    eventName: cfg.eventName ?? "Truth Pays",
    deposit: `${ethers.formatEther(cfg.depositUnits)} ${SYMBOL}`,
    policyURI: cfg.kleros?.policyURI ?? "",
    owner: organiser,
    ownerLower: organiser.toLowerCase(),
    explorer: cfg.explorer ?? "",
  };
  for (const f of EVENT_FIELDS) if (f.key !== "eventName" && cfg[f.key] !== undefined) values[f.key] = cfg[f.key];
  return values;
}

/**
 * The case description template for the deploy, from the template's TEXT: fills the deploy-time
 * placeholders with `values` (templateValues, or any object with the same keys; each value is
 * JSON-escaped, and never read again for placeholders) and splits it at {{wallet}}, {{contract}} and
 * {{walletLower}}. Checks that a sample case is valid ERC-1497 JSON that names the wallet, points to
 * the juror policy (values.policyURI), labels addresses in lower case too and fits the contract.
 * `name` names the template in messages. Returns { pieces, slots (hex), sample (a case for sample addresses) }.
 */
export function caseTemplate(text, values = {}, { name = "The case description template" } = {}) {
  const pieces = [], slots = [];
  let piece = "", last = 0;
  const raw = String(text);
  for (const m of raw.matchAll(/\{\{\w+\}\}/g)) {
    piece += raw.slice(last, m.index);
    last = m.index + m[0].length;
    const key = m[0].slice(2, -2);
    if (key in SLOT) {
      pieces.push(piece);
      piece = "";
      slots.push(SLOT[key]);
      continue;
    }
    if (!(key in DEPLOY_PLACEHOLDERS)) throw new Error(`Unknown placeholder ${m[0]} in ${name}`);
    const v = values[key];
    if ((key === "owner" || key === "ownerLower") && !v) throw new Error(`Set "owner" in the config: the case description (${name}) names the organiser's wallet`);
    if (DEPLOY_PLACEHOLDERS[key] && !String(v ?? "").trim()) throw new Error(`${name} names the event's "${DEPLOY_PLACEHOLDERS[key]}" (${m[0]}), but it is empty: please fill it in.`);
    // values go inside JSON strings, so they are escaped as JSON
    piece += JSON.stringify(String(v ?? "")).slice(1, -1);
  }
  pieces.push(piece + raw.slice(last));
  if (!slots.includes(SLOT.wallet)) throw new Error(`${name} must name the challenged wallet ({{wallet}})`);
  const t = { pieces, slots: ethers.hexlify(new Uint8Array(slots)) };
  // EIP-55 test vectors: mixed case once checksummed, so a lower-case alias key can be told apart
  const sampleWallet = "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed", sampleContract = "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359";
  const sample = renderCase(t, sampleWallet, sampleContract);
  if (ethers.getBytes(ethers.AbiCoder.defaultAbiCoder().encode(["string[]", "bytes"], [t.pieces, t.slots])).length > MAX_TEMPLATE_BYTES)
    throw new Error(`${name} is too long: the contract can keep about 24 KB of template`);
  let meta;
  try { meta = JSON.parse(sample); } catch (e) { throw new Error(`${name} is not valid JSON once filled in: ${e.message}`); }
  const wallet = ethers.getAddress(sampleWallet);
  for (const key of ["title", "question"])
    if (typeof meta[key] !== "string" || !meta[key].includes(wallet)) throw new Error(`${name}: "${key}" must name the wallet ({{wallet}})`);
  if (typeof meta.description !== "string" || !meta.description) throw new Error(`${name}: "description" is missing`);
  if (!Array.isArray(meta.rulingOptions?.titles) || meta.rulingOptions.titles.length !== 2)
    throw new Error(`${name}: "rulingOptions.titles" must list the 2 answers (1 attended, 2 did not attend)`);
  if ((meta.fileURI ?? "") !== (values.policyURI ?? "")) throw new Error(`${name}: "fileURI" must be the juror policy ("{{policyURI}}")`);
  // Kleros Court labels each piece of evidence with aliases[sender], the sender in lower case
  const aliasKeys = Object.keys(meta.aliases ?? {});
  for (const key of aliasKeys)
    if (/^0x[0-9a-fA-F]{40}$/.test(key) && !aliasKeys.includes(key.toLowerCase()))
      throw new Error(`${name}: alias ${key} also needs a lower-case key ({{walletLower}} / {{ownerLower}}): Kleros Court looks senders up in lower case`);
  return { ...t, sample };
}

/**
 * The deploy settings of a config, checked (the first part of deployArgs): the dates (claimDeadline
 * at least 7 days after eventStart), the deposit, the Kleros settings, a current juror policy (a
 * pinned IPFS path in live mode) and the deploying wallet being the config's owner. Returns klerosConfig(cfg).
 */
export function deploySettings(cfg, owner) {
  const { eventStartTs: start, claimDeadlineTs: end } = cfg;
  if (!start || !end)
    throw new Error('Set "eventStart" and "claimDeadline" in the config (ISO dates with timezone)');
  if (end < start + MIN_SETTLEMENT_WINDOW) throw new Error("claimDeadline must be at least 7 days after eventStart");
  if (!(typeof cfg.depositUnits === "bigint" && cfg.depositUnits > 0n)) throw new Error("No deposit amount: load the config with loadConfig()");
  const k = klerosConfig(cfg);
  if (STALE_PINS.some((p) => String(k.policyURI).includes(p)))
    throw new Error(`"kleros.policyURI" (${k.policyURI}) is an earlier version of the juror policy. Pin docs/attendance-policy.md and set its new path.`);
  if (cfg.mode === "live" && !isIpfsPath(k.policyURI))
    throw new Error('Set "kleros.policyURI" to the IPFS path of the pinned juror policy (e.g. /ipfs/Qm…) before the live deploy');
  if (cfg.owner && owner && owner !== ethers.ZeroAddress && ethers.isAddress(cfg.owner) && ethers.getAddress(cfg.owner) !== ethers.getAddress(owner))
    throw new Error(`The deploying wallet ${owner} is not the owner in the config (${cfg.owner})`);
  return k;
}

/**
 * Constructor arguments for TruthPaysKickback, checked before anything is sent:
 * [depositAmount (wei), eventName, owner, eventStart, claimDeadline,
 *  [disputeResolver, extraData, metaEvidenceTemplate pieces, metaEvidenceSlots, policyURI]].
 * `templateText` is the case description template's text (lib.mjs deployArgs reads it from
 * kleros.metaEvidenceTemplate; the admin panel passes the generic template); `name` names it in
 * messages. The settings are checked by deploySettings, the template by caseTemplate (the organiser
 * it names is config "owner", which must be the deploying wallet, or the deploying wallet itself).
 */
export function deployArgs(cfg, owner, templateText, { name } = {}) {
  const k = deploySettings(cfg, owner);
  if (typeof templateText !== "string") throw new Error("No case description template: pass the template's text");
  const t = caseTemplate(templateText, templateValues(cfg, owner), { name });
  return [cfg.depositUnits, cfg.eventName ?? "Truth Pays", owner, cfg.eventStartTs, cfg.claimDeadlineTs, [k.disputeResolver, k.extraData, t.pieces, t.slots, k.policyURI]];
}

// "2026-11-04T18:00:00+05:30" → its offset in minutes (330), or null without one
const offsetOf = (iso) => {
  const m = /(Z|([+-])(\d\d):(\d\d))$/.exec(String(iso ?? ""));
  return !m ? null : m[1] === "Z" ? 0 : (m[2] === "-" ? -1 : 1) * (Number(m[3]) * 60 + Number(m[4]));
};

// "+05:30" for 330 minutes
export const offsetText = (minutes) =>
  `${minutes < 0 ? "-" : "+"}${String(Math.floor(Math.abs(minutes) / 60)).padStart(2, "0")}:${String(Math.abs(minutes) % 60).padStart(2, "0")}`;
// The UTC offsets timezones use today, as offsetText writes them: the admin panel's form offers these, and
// eventClock takes no other. (The generic guest page, which can't import this file, gets this list and the
// table below baked in by build-site.mjs for its eventClock.)
export const TZ_OFFSETS = ["-12:00", "-11:00", "-10:00", "-09:30", "-09:00", "-08:00", "-07:00", "-06:00", "-05:00", "-04:00", "-03:30", "-03:00", "-02:30", "-02:00", "-01:00", "+00:00",
  "+01:00", "+02:00", "+03:00", "+03:30", "+04:00", "+04:30", "+05:00", "+05:30", "+05:45", "+06:00", "+06:30", "+07:00", "+08:00", "+08:45", "+09:00", "+09:30",
  "+10:00", "+10:30", "+11:00", "+12:00", "+12:45", "+13:00", "+13:45", "+14:00"];
// Common timezone abbreviations and the UTC offsets (minutes) each can stand for, the one most readers take
// it for first ("IST" is India's +05:30 before Irish or Israel time). A typed timezone name that uses one of
// them (or "UTC+2", "GMT-03:30") must agree with the event's offset.
export const ZONE_OFFSETS = {
  UTC: [0], GMT: [0], UT: [0], WET: [0], WEST: [60], BST: [60, 360], IST: [330, 60, 120], CET: [60], CEST: [120], MET: [60], MEST: [120],
  WAT: [60], CAT: [120], SAST: [120], EET: [120], EEST: [180], EAT: [180], MSK: [180], TRT: [180], AST: [-240, 180], ADT: [-180], GST: [240],
  PKT: [300], NPT: [345], BDT: [360], ICT: [420], WIB: [420], HKT: [480], SGT: [480], AWST: [480], PHT: [480], PHST: [480], JST: [540], KST: [540],
  ACST: [570], ACDT: [630], AEST: [600], AEDT: [660], NZST: [720], NZDT: [780], NST: [-210], NDT: [-150], BRT: [-180], ART: [-180],
  EST: [-300], EDT: [-240], CST: [-360, 480, -300], CDT: [-300], MST: [-420], MDT: [-360], PST: [-480, 480], PDT: [-420],
  AKST: [-540], AKDT: [-480], HST: [-600],
};
const UTC_NAME_RE = /\b(?:UTC|GMT)\s*([+\-\u2212])\s*(\d{1,2})(?::?(\d\d))?(?!\d)/g;
// the offset (minutes) a "UTC+2" / "GMT-03:30" match of UTC_NAME_RE stands for
const utcNameOffset = (m) => (m[1] === "+" ? 1 : -1) * (Number(m[2]) * 60 + Number(m[3] ?? 0));
/**
 * Checks a typed timezone name (for {{eventWhen}}) against the event's UTC offset in minutes: no
 * invisible or text-direction characters, at most 40 characters, and every abbreviation in it that
 * this file knows ("CEST", "UTC+2") must be that offset. Returns the name trimmed; throws a plain message.
 */
export function checkZoneName(zone, offset) {
  const z = String(zone ?? "").normalize("NFC").trim();
  if (DISGUISE_RE.test(z)) throw new Error("Timezone name: please keep it on one line, without invisible or text-direction characters.");
  if (z.length > 40) throw new Error(`Timezone name is too long (${z.length} characters, at most 40).`);
  if (/\{\{|\}\}/.test(z)) throw new Error('Timezone name can\'t contain "{{" or "}}".');
  const wrong = (name) => new Error(`Timezone name: "${name}" is not UTC${offsetText(offset)}, the timezone of the event on that date. Pick the right timezone, or correct or clear the name.`);
  for (const m of z.matchAll(UTC_NAME_RE)) if (utcNameOffset(m) !== offset) throw wrong(m[0]);
  for (const m of z.replace(UTC_NAME_RE, " ").matchAll(/\b[A-Z]{2,5}\b/g))
    if (ZONE_OFFSETS[m[0]] && !ZONE_OFFSETS[m[0]].includes(offset)) throw wrong(m[0]);
  return z;
}
/**
 * True when a timezone name is verifiably and unmistakably the UTC offset `offset` (minutes): the whole
 * name is a "UTC+05:30" / "GMT+7" form (as checkZoneName reads them) of that value, or one abbreviation
 * whose first meaning in ZONE_OFFSETS is that offset ("IST" for 330, "CST" for -360). An abbreviation
 * that stands for something else first is not: "IST" at +01:00 (Irish time) or "PST" at +08:00
 * (Philippine time) would be read as India or Pacific time, so eventClock names those by the offset.
 */
export function zoneIs(name, offset) {
  const z = String(name ?? "").trim(), m = /^(?:UTC|GMT) *([+\-\u2212]) *(\d{1,2})(?::?(\d\d))?$/.exec(z);
  if (m) return Number(m[3] ?? 0) < 60 && utcNameOffset(m) === offset;
  return Object.prototype.hasOwnProperty.call(ZONE_OFFSETS, z) && ZONE_OFFSETS[z][0] === offset;
}

// the English names describeWhen writes
const WEEKDAYS = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"];
const MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

/**
 * "Wednesday 4 November 2026, 18:00-22:00 IST": an event's date and time as people read it, in the
 * event's own timezone (the offset written in `startIso`), for {{eventWhen}}. `zone` is the
 * timezone's name to print ("IST"), checked against that offset (checkZoneName); without it the
 * offset is printed ("UTC+05:30").
 */
export function describeWhen(startIso, endIso, zone = "") {
  const off = offsetOf(startIso);
  const t0 = Date.parse(startIso), t1 = Date.parse(endIso);
  if (off === null || Number.isNaN(t0) || Number.isNaN(t1)) throw new Error("Start and end must be dates with a timezone, e.g. 2026-11-04T18:00:00+05:30");
  if (t1 <= t0) throw new Error("The event must end after it starts.");
  zone = checkZoneName(zone, off);
  const local = (t) => new Date(t + off * 60_000); // read with getUTC*: the wall clock at the event
  const day = (d) => `${WEEKDAYS[d.getUTCDay()]} ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()}`;
  const time = (d) => `${String(d.getUTCHours()).padStart(2, "0")}:${String(d.getUTCMinutes()).padStart(2, "0")}`;
  const a = local(t0), b = local(t1);
  const tz = zone || `UTC${offsetText(off)}`;
  return day(a) === day(b) ? `${day(a)}, ${time(a)}-${time(b)} ${tz}` : `${day(a)}, ${time(a)} to ${day(b)}, ${time(b)} ${tz}`;
}

// The start of a describeWhen text, "<Weekday> <D> <Month> <YYYY>, <HH>:<MM>", and its end if it has one ("-22:00",
// or " to Saturday 13 March 2027, 01:00"), so that the timezone's name is what follows the last time
const WHEN_RE = new RegExp(`\\b(${WEEKDAYS.join("|")}) (\\d{1,2}) (${MONTHS.join("|")}) (\\d{4}), (\\d\\d):(\\d\\d)` +
  `(?:-\\d\\d:\\d\\d| to (?:${WEEKDAYS.join("|")}) \\d{1,2} (?:${MONTHS.join("|")}) \\d{4}, \\d\\d:\\d\\d)?`, "g");
const JSON_ESCAPES = { b: "\b", f: "\f", n: "\n", r: "\r", t: "\t" };
/**
 * The event's own clock, from its case description (the text of caseMetaEvidence, or renderCase of
 * readEvent's metaEvidenceTemplate: the date is the same in every case) and the contract's eventStart
 * (unix seconds): { offset (minutes east of UTC), zone (its name, "IST") }, or null. The contract keeps
 * no timezone, but the case text names the event's date and time as describeWhen wrote it when the
 * contract was created ("Wednesday 4 November 2026, 18:00-22:00 IST"). A date counts when its weekday is
 * right and its distance from eventStart is an offset timezones use (TZ_OFFSETS: the form offers no
 * other, so "+00:30" means the date is another one, a doors time in the event's name for example). Its
 * zone is the name written after that date's last time, up to the next ")", quote, ";", "," or line end,
 * when it is verifiably and unmistakably that offset (zoneIs: "UTC+01:00", "CET"). The first date whose
 * name is gives the clock; if none is, the first date that counts gives it, named by the offset
 * ("UTC+05:30", offsetText). The text is JSON: its escapes (\" and \\ in the organiser's texts, \n
 * between paragraphs) are read first. All of the text is organiser-typed, and a title could hold another
 * date earlier on: so the clock found may not be the venue's. The moment shown on it is still right,
 * because the zone always names a timezone that is exactly that offset.
 */
export function eventClock(caseText, eventStart) {
  const start = Number(eventStart);
  if (!Number.isFinite(start)) return null;
  const text = String(caseText ?? "").replace(/\\(?:u([0-9a-fA-F]{4})|([^u]))/g, (_, u, c) => (u ? String.fromCharCode(parseInt(u, 16)) : JSON_ESCAPES[c] ?? c));
  let first = null;
  for (const m of text.matchAll(WHEN_RE)) {
    const [d, mo, y, hh, mm] = [Number(m[2]), MONTHS.indexOf(m[3]), Number(m[4]), Number(m[5]), Number(m[6])];
    const day = new Date(Date.UTC(y, mo, d));
    if (hh > 23 || mm > 59 || day.getUTCDate() !== d || day.getUTCMonth() !== mo || day.getUTCDay() !== WEEKDAYS.indexOf(m[1])) continue;
    const offset = (Date.UTC(y, mo, d, hh, mm) - start * 1000) / 60_000;
    if (!Number.isInteger(offset) || !TZ_OFFSETS.includes(offsetText(offset))) continue;
    const name = /^[^)";,\u0000-\u001f]*/.exec(text.slice(m.index + m[0].length))[0].trim();
    if (zoneIs(name, offset)) return { offset, zone: name };
    first ??= { offset, zone: `UTC${offsetText(offset)}` };
  }
  return first;
}

// The network part of a page's config. `network`: { chainId, chain ("ethereum" on mainnet, else a
// local name), chainName, explorer, rpcUrl, logChunk, kleros: { disputeResolver, arbitrator, court,
// jurors, policyURI, courtUrl, ipfsUpload, ipfsGateway } }
const networkConfig = (network = {}) => ({
  chain: network.chain ?? (Number(network.chainId) === 1 ? "ethereum" : "local"),
  chainId: Number(network.chainId),
  ...(network.chainName ? { chainName: network.chainName } : {}),
  rpcUrl: network.rpcUrl ?? "",
  ...(network.explorer !== undefined ? { explorer: network.explorer } : {}),
  logChunk: network.logChunk,
  mode: "live",
  columns: network.columns ?? {},
});

/**
 * The config of a new event created from the admin panel's form, in normalizeConfig's shape, so
 * deployArgs (with the generic template's text) takes it like config.json. Its receiver/contract is
 * the zero address: once deployed, use contractConfig for the new contract.
 *   form:    the EVENT_FIELDS (eventTitle, eventName, eventWhen, eventWhere, hosts, eventLink), deposit
 *            in ETH ("0.01"), eventStart and claimDeadline as ISO dates with timezone (claimDeadline
 *            defaults to 14 days after eventStart and must be at least 7 days after it)
 *   network: see networkConfig above; kleros.policyURI is the pinned generic juror policy
 *   owner:   the connected wallet: the new contract's owner, named in each case
 * Throws plain messages (eventDetails' `fields` for the text fields).
 */
export function newEventConfig(form, network, owner) {
  const details = eventDetails(form);
  if (!ethers.isAddress(owner ?? "")) throw new Error("Connect your wallet first: it becomes the owner of the new contract.");
  const deposit = String(form.deposit ?? "").trim();
  let wei;
  try { wei = ethers.parseEther(deposit); } catch { throw new Error(`Deposit: type an amount of ETH such as 0.01 (got "${deposit}").`); }
  if (wei <= 0n) throw new Error("Deposit: it must be more than 0 ETH.");
  if (wei > ethers.parseEther(MAX_DEPOSIT_ETH)) throw new Error(`Deposit: more than ${MAX_DEPOSIT_ETH} ETH per guest looks like a mistake.`);
  const start = Date.parse(form.eventStart ?? "");
  if (Number.isNaN(start) || offsetOf(form.eventStart) === null) throw new Error("Event start: pick a date, a time and a timezone.");
  const claimDeadline = form.claimDeadline || new Date(start + 14 * 86400_000).toISOString();
  const end = Date.parse(claimDeadline);
  if (Number.isNaN(end) || offsetOf(claimDeadline) === null) throw new Error("Settlement deadline: pick a date, a time and a timezone.");
  if (Math.floor(end / 1000) < Math.floor(start / 1000) + MIN_SETTLEMENT_WINDOW)
    throw new Error("Settlement deadline: it must be at least 7 days after the event starts (14 days is usual).");
  return normalizeConfig({
    ...networkConfig(network),
    ...details,
    receiver: ethers.ZeroAddress, // not deployed yet
    deposit,
    eventStart: form.eventStart,
    claimDeadline,
    owner: ethers.getAddress(owner),
    kleros: { ...(network.kleros ?? {}) },
  }, "the form");
}

/** True when `address` is Kleros's own Dispute Resolver on this network (KLEROS), the one the guest page and the panel trust. */
export const isKnownResolver = (chainId, address) =>
  !!KLEROS[Number(chainId)] && String(address ?? "").toLowerCase() === KLEROS[Number(chainId)].disputeResolver.toLowerCase();

/**
 * The fingerprint of a contract's runtime code: the SHA-256 of the code with its immutable values
 * zeroed (`immutables`: [start, length] byte ranges, from solc's immutableReferences), so every
 * deployment of one compiled contract has the same fingerprint whatever its constructor arguments.
 * null when a range lies outside the code.
 */
export function codeFingerprint(code, immutables = []) {
  const b = new Uint8Array(ethers.getBytes(code));
  for (const [start, length] of immutables) {
    if (!(Number.isInteger(start) && Number.isInteger(length) && start >= 0 && start + length <= b.length)) return null;
    b.fill(0, start, start + length);
  }
  return ethers.sha256(b);
}

/**
 * Everything about an event that its deposit contract knows, read on-chain: { contract, eventName,
 * depositAmount (wei), eventStart, claimDeadline (unix seconds), owner, disputeResolver, arbitrator,
 * policyURI, metaEvidenceTemplate ({ pieces, slots }), phase (PHASES index) }. Throws an error with
 * `code` "NO_KICKBACK_CONTRACT" when there is no contract at the address on this network, and
 * "NOT_KICKBACK" when the contract there does not answer like a kickback deposit contract.
 * `runtime` ({ sha256, immutables }, from the compiled contract: lib.mjs kickbackRuntime): the
 * contract's code must also be that compiled contract's (codeFingerprint), or it throws with `code`
 * "UNKNOWN_CODE": answers can be faked, the code can't.
 */
export async function readEvent(prov, address, abi, { runtime } = {}) {
  if (!ethers.isAddress(address ?? "")) throw Object.assign(new Error(`"${address ?? ""}" is not a contract address (0x… with 40 characters after it).`), { code: "NOT_KICKBACK" });
  const contract = ethers.getAddress(String(address).toLowerCase());
  const code = await prov.getCode(contract);
  if (!isContractCode(code))
    throw Object.assign(new Error(`There is no contract at ${contract} on this network.`), { code: "NO_KICKBACK_CONTRACT" });
  const c = new ethers.Contract(contract, abi, prov);
  let v;
  try {
    v = await Promise.all(["eventName", "depositAmount", "eventStart", "claimDeadline", "owner", "disputeResolver", "arbitrator", "policyURI", "metaEvidenceTemplate", "phase"].map((f) => c[f]()));
  } catch (e) {
    throw Object.assign(new Error(`The contract at ${contract} is not a kickback deposit contract (${e.shortMessage || e.message}).`), { code: "NOT_KICKBACK", cause: e });
  }
  if (runtime && codeFingerprint(code, runtime.immutables) !== runtime.sha256)
    throw Object.assign(new Error(`The contract at ${contract} answers like a kickback deposit contract, but its code is not the kickback deposit contract's.`), { code: "UNKNOWN_CODE" });
  const [eventName, depositAmount, eventStart, claimDeadline, owner, disputeResolver, arbitrator, policyURI, [pieces, slots], phase] = v;
  return {
    contract, eventName, depositAmount, eventStart: Number(eventStart), claimDeadline: Number(claimDeadline), owner, disputeResolver, arbitrator,
    policyURI, metaEvidenceTemplate: { pieces: [...pieces], slots }, phase: Number(phase),
  };
}

/**
 * The config of an existing deposit contract, from what readEvent read on-chain, in normalizeConfig's
 * shape, so checkGuests and buildPayout take it like config.json: the deposit, times, owner and Kleros
 * settings are the contract's own; deposits sent after the event started count as late (as in
 * config.json); `deployBlock` is where log scans start. `network` as for newEventConfig.
 */
export function contractConfig(ev, network = {}, deployBlock) {
  const iso = (t) => new Date(Number(t) * 1000).toISOString();
  return normalizeConfig({
    ...networkConfig(network),
    eventName: ev.eventName,
    deposit: ethers.formatEther(ev.depositAmount),
    receiver: ev.contract,
    contract: ev.contract,
    eventStart: iso(ev.eventStart),
    claimDeadline: iso(ev.claimDeadline),
    depositDeadline: iso(ev.eventStart),
    owner: ev.owner,
    ...(deployBlock !== undefined && deployBlock !== null && deployBlock !== "" ? { deployBlock: Number(deployBlock) } : {}),
    kleros: { ...(network.kleros ?? {}), disputeResolver: ev.disputeResolver, arbitrator: ev.arbitrator, policyURI: ev.policyURI },
  }, "the contract", { depositCap: false });
}

// ---------------------------------------------------------------- CSV

/**
 * Rows of a CSV text as objects keyed by the header row: the same rules as lib.mjs readCsv (csv-parse
 * with columns, skip_empty_lines, bom and relax_column_count). Fields in "…" may hold commas, line
 * breaks and "" for a quote; the line break is the first one found outside quotes (\r\n, \n or \r);
 * empty lines are skipped; a short row has only its first keys and extra fields are dropped; a
 * repeated header keeps the last value. A stray quote is an error, as in csv-parse.
 */
export function parseCsv(text) {
  let s = String(text ?? "");
  if (s.charCodeAt(0) === 0xfeff) s = s.slice(1);
  const n = s.length;
  const rows = [];
  let headers = null, record = [], field = "", rd = "", line = 1;
  let quoting = false, wasQuoting = false, escaping = false;
  const findRd = (i) => (s.startsWith("\r\n", i) ? "\r\n" : s[i] === "\n" ? "\n" : s[i] === "\r" ? "\r" : "");
  const endField = () => { record.push(field); field = ""; wasQuoting = false; };
  const endRecord = () => {
    if (!headers) headers = record;
    else {
      const row = {};
      for (let k = 0; k < record.length && k < headers.length; k++) row[headers[k]] = record[k];
      rows.push(row);
    }
    record = [];
  };
  for (let i = 0; i < n; i++) {
    if (!quoting && !rd) rd = findRd(i);
    const ch = s[i];
    if (ch === "\n" || (ch === "\r" && s[i + 1] !== "\n")) line++;
    if (escaping) { escaping = false; field += ch; continue; }
    if (quoting && ch === '"' && i + 1 < n && s[i + 1] === '"') { escaping = true; continue; }
    if (ch === '"') {
      if (quoting) {
        const next = s[i + 1];
        const nextRd = rd ? s.startsWith(rd, i + 1) : !!(rd = findRd(i + 1));
        if (next === undefined || next === "\0" || next === "," || nextRd) { quoting = false; wasQuoting = true; continue; }
        throw new Error(`Invalid Closing Quote: got "${next}" at line ${line} instead of a comma or a line break`);
      }
      if (field.length) throw new Error(`Invalid Opening Quote: a quote is found inside a field at line ${line}, value is ${JSON.stringify(field)}`);
      quoting = true;
      continue;
    }
    if (!quoting) {
      if (rd && s.startsWith(rd, i)) {
        i += rd.length - 1;
        if (!wasQuoting && !record.length && !field.length) continue; // empty line
        endField();
        endRecord();
        continue;
      }
      if (ch === ",") { endField(); continue; }
    }
    field += ch;
  }
  if (quoting) throw new Error(`Quote Not Closed: the text ends inside a quoted field (line ${line})`);
  if (wasQuoting || record.length || field.length) { endField(); endRecord(); }
  return rows;
}

// Guests type their own names and answers on Luma. A cell starting with = + - @ (or a tab / CR)
// would run as a formula when the CSV is opened in a spreadsheet, so it gets a leading '.
const FORMULA_START = /^[=+\-@\t\r]/;
export const csvCell = (v) => {
  let s = v === undefined || v === null ? "" : String(v);
  if (FORMULA_START.test(s)) s = "'" + s;
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};
/** Undo csvCell's leading ' when reading our own CSVs back (emails, names). */
export const uncell = (v) => (/^'[=+\-@\t\r]/.test(String(v ?? "")) ? String(v).slice(1) : String(v ?? ""));

/** A CSV text (what lib.mjs writeCsv writes): the header row, then one line per row, safe cells. */
export function toCsv(rows, headers) {
  const cols = headers ?? (rows[0] ? Object.keys(rows[0]) : []);
  return [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n";
}

/**
 * Luma's guest export uses snake_case for built-in fields (name, email, eth_address,
 * ticket_name, checked_in_at, approval_status) and the question text for custom
 * questions. We match by keywords, and config.columns can override any of them.
 */
export function detectColumns(headers, overrides = {}) {
  // patterns are in order of preference: the first pattern that matches any header wins
  const find = (...patterns) => {
    for (const p of patterns) {
      const h = headers.find((x) => p.test(x.toLowerCase().trim()));
      if (h) return h;
    }
    return undefined;
  };
  const cols = {
    name: find(/^name$/, /full name/),
    email: find(/^email$/, /e-?mail/),
    ticket: find(/^ticket_name$/, /ticket/),
    approval: find(/approval_status/, /^status$/),
    checkedIn: find(/checked_in_at/, /check.?in/),
    tx: find(/\btx\b/, /transaction/, /tx.?(hash|link)/, /deposit.*(link|hash)/, /etherscan|arbiscan|basescan/),
    wallet: find(/^eth_address$/, /eth.?address/, /wallet/),
  };
  return { ...cols, ...overrides };
}

export const TX_HASH_RE = /0x[a-fA-F0-9]{64}/;

export function extractTxHash(value) {
  const m = String(value ?? "").match(TX_HASH_RE);
  return m ? m[0].toLowerCase() : null;
}
/** Every tx hash in an answer, in order, without repeats ("first one failed: …/tx/0xA, then …/tx/0xB"). */
export const extractTxHashes = (value) => [...new Set((String(value ?? "").match(new RegExp(TX_HASH_RE.source, "g")) ?? []).map((h) => h.toLowerCase()))];

export function normAddress(value) {
  const m = String(value ?? "").match(/0x[a-fA-F0-9]{40}/);
  if (!m) return null;
  try {
    return ethers.getAddress(m[0].toLowerCase());
  } catch {
    return null;
  }
}

export const fmt = (units, decimals = DECIMALS) => ethers.formatUnits(units, decimals);

/**
 * An ETH amount for people to read: exact when it fits in `digits` decimals ("0.01 ETH"), otherwise
 * rounded down and marked with "~" ("~0.013333 ETH"). CSV and JSON files keep the exact amount (fmt).
 */
export function fmtEth(units, digits = 6) {
  const exact = ethers.formatEther(units);
  const [whole, dec = ""] = exact.split(".");
  if (dec.length <= digits) return `${exact} ETH`;
  const short = dec.slice(0, digits).replace(/0+$/, "");
  return short || whole !== "0" ? `~${whole}${short ? "." + short : ""} ETH` : `${exact} ETH`; // dust: in full
}

/** How the organiser decided on a guest in Luma. */
export function lumaDecision(approval) {
  const a = String(approval ?? "").toLowerCase().trim();
  if (/declin|reject/.test(a)) return "declined";
  // exact words only: "pending_approval" must not count as approved
  if (/^(approved|going|accepted)$/.test(a)) return "approved";
  return "pending"; // pending_approval, waitlist, invited, empty…
}

// ---------------------------------------------------------------- verification

/** Code of a contract, not of a plain wallet (an EIP-7702 delegated wallet is still a plain wallet). */
export const isContractCode = (code) => code !== "0x" && !/^0xef0100[0-9a-f]{40}$/i.test(code);

/** One deposit = the ETH one wallet sent to the contract in one tx (its Deposited events, added up). */
export const depKey = (tx, from) => `${String(tx).toLowerCase()}|${String(from).toLowerCase()}`;

// Explorers of other networks: a tx link from one of them means the ETH was sent on the wrong network.
// Checked only when the tx is not on the configured chain (a hash is never on two chains in practice).
export const OTHER_NETWORKS = [
  [/sepolia\.etherscan\.io/i, "the Sepolia test network"],
  [/holesky\.etherscan\.io|hoodi\.etherscan\.io/i, "an Ethereum test network"],
  [/optimistic\.etherscan\.io|optimism/i, "Optimism"],
  [/arbiscan\.io|arbitrum/i, "Arbitrum"],
  [/basescan\.org|base\.blockscout/i, "Base"],
  [/polygonscan\.com/i, "Polygon"],
  [/lineascan\.build/i, "Linea"],
  [/scrollscan\.com/i, "Scroll"],
  [/bscscan\.com/i, "BNB Chain"],
  [/zksync/i, "zkSync"],
  [/blastscan\.io/i, "Blast"],
  [/gnosisscan\.io/i, "Gnosis"],
];
/** The network a pasted tx link points at, if it is clearly not Ethereum mainnet ("Arbitrum"…). */
export function otherNetworkOf(link) {
  const s = String(link ?? "");
  return OTHER_NETWORKS.find(([re]) => re.test(s))?.[1] ?? null;
}

/** The contract's Deposited events in a list of logs, added up per sender (Map sender → { from, amount, logIndex }). */
export function depositsInLogs(logs, receiver) {
  const bySender = new Map();
  for (const l of logs) {
    if (ethers.getAddress(l.address) !== receiver || l.topics[0] !== DEPOSITED_TOPIC || l.topics.length !== 2) continue;
    const from = ethers.getAddress(ethers.dataSlice(l.topics[1], 12));
    const d = bySender.get(from) ?? { from, amount: 0n, logIndex: l.index };
    d.amount += BigInt(l.data);
    d.logIndex = Math.min(d.logIndex, l.index);
    bySender.set(from, d);
  }
  return bySender;
}

/**
 * Verify one deposit transaction.
 * Valid when: the tx succeeded on this chain, the deposit contract (`receiver`) logged a Deposited
 * event for the guest's wallet, totalling >= deposit, inside the deposit window.
 * Every result that found ETH arriving in the contract also carries `deposits` (the amount per
 * sender in this tx) and `block`, so what the contract sent back can be paired with it later.
 * `link` is what the guest pasted, used to name the network when the tx is not on this chain.
 */
export async function verifyTx(prov, cfg, txHash, claimedWallet, link = "") {
  const net = cfg.chainName ?? "this network";
  const receipt = await prov.getTransactionReceipt(txHash);
  if (!receipt) {
    if (await prov.getTransaction(txHash))
      return { ok: false, code: "TX_PENDING", note: "Sent but not confirmed yet. Check again later." };
    const other = otherNetworkOf(link);
    if (other)
      return { ok: false, code: "WRONG_NETWORK", note: `The link is a transaction on ${other}, not ${net}. ETH sent there never reached the deposit contract, and the contract can't send it back. Ask the guest to send a new deposit on ${net} and paste its etherscan.io link.` };
    return { ok: false, code: "TX_NOT_FOUND", note: `Not found on ${net}. Sent on another network (Arbitrum, Base, Optimism…), or a typo in the link? Ask the guest for their etherscan.io link.` };
  }
  const toContract = !!receipt.to && ethers.getAddress(receipt.to) === cfg.receiver;
  if (receipt.status !== 1) {
    // A plain transfer with a fixed 21,000 gas limit (some wallets and exchanges) runs out of gas: the
    // contract needs about 25,000 to log the deposit. Running out of gas uses up the whole limit;
    // a refusal (0 ETH, deposits closed) returns the rest.
    const tx = toContract ? await prov.getTransaction(txHash) : null;
    if (tx && receipt.gasUsed >= tx.gasLimit)
      return { ok: false, code: "TX_FAILED", note: `Sent with too little gas (a limit of ${Number(tx.gasLimit).toLocaleString("en-US")}): the deposit contract needs about 25,000 to record a deposit, so the transaction failed and no ETH moved. The guest only paid the network fee. Ask them to send it again from the deposit page, or from their wallet with the gas limit it suggests (not a fixed 21,000).` };
    return { ok: false, code: "TX_FAILED", note: toContract
      ? "The deposit contract refused this payment (0 ETH sent, or deposits were already closed), so no ETH arrived: the guest only paid the network fee. If they still want a spot, they send a new deposit."
      : "This transaction failed, so no ETH moved: the guest only paid the network fee. If they still want a spot, they send a new deposit." };
  }

  const bySender = depositsInLogs(receipt.logs, cfg.receiver);
  if (!bySender.size) {
    const receiverTopic = ethers.zeroPadValue(cfg.receiver, 32).toLowerCase();
    const token = receipt.logs.find((l) => l.topics.length === 3 && l.topics[0] === TOKEN_TRANSFER_TOPIC && l.topics[2].toLowerCase() === receiverTopic);
    if (token)
      return { ok: false, code: "NO_DEPOSIT_TRANSFER", note: `This sent a token (USDC, for example), not ETH, to the deposit contract (token contract ${ethers.getAddress(token.address)}). A token is never a deposit: give it back with 'Return tokens sent by mistake' in the console (it shows the amount), and ask the guest for a new deposit in ETH.` };
    return { ok: false, code: "NO_DEPOSIT_TRANSFER", note: toContract || !receipt.to
      ? "No ETH deposit to the deposit contract in this tx"
      : `No ETH deposit to the deposit contract in this tx (it went to ${ethers.getAddress(receipt.to)}: wrong address?)` };
  }

  const deposits = [...bySender.values()];
  const senders = deposits.map((d) => d.from);
  const seen = { deposits, block: receipt.blockNumber };
  let wallet = claimedWallet;
  let inferred = false;
  if (!wallet) {
    if (senders.length !== 1) return { ok: false, code: "AMBIGUOUS_SENDER", note: "No wallet given and tx has several senders", ...seen };
    wallet = senders[0];
    inferred = true;
    // No ETH address on Luma: refunds and payouts would go to whoever sent the ETH. That must be an
    // ordinary wallet; a contract (an exchange, a relayer, a Safe…) only if the guest says it is theirs.
    if (isContractCode(await prov.getCode(wallet)))
      return { ok: false, code: "UNUSUAL_SENDER", note: `Sent by a contract (${wallet}: an exchange, a Safe or another smart wallet?) and no ETH address on Luma. Ask the guest which wallet should get refunds and payouts: if it is that same Safe or smart wallet, they add its address on Luma as their ETH address.`, sender: wallet, ...seen };
  }
  if (wallet === ethers.ZeroAddress)
    return { ok: false, code: "UNUSUAL_SENDER", note: "The ETH address on Luma is the zero address. Ask the guest for their real wallet.", ...seen };
  const mine = bySender.get(wallet);
  if (!mine)
    return { ok: false, code: "WRONG_SENDER", note: `Deposit came from ${senders.join(" / ")}, not ${wallet} (sent from an exchange? Refunds and payouts can only go to the wallet that sent the deposit)`, sender: senders[0], ...seen };

  const amount = mine.amount;
  const ts = Number((await prov.getBlock(receipt.blockNumber)).timestamp);
  const res = { wallet, inferred, amount, ts, logIndex: mine.logIndex, ...seen };
  if (ts < cfg.opensAt || ts > cfg.deadline)
    return { ok: false, code: "OUTSIDE_WINDOW", note: `Sent at ${new Date(ts * 1000).toISOString()}`, ...res };
  if (amount < cfg.depositUnits)
    return { ok: false, code: "AMOUNT_TOO_LOW", note: `Sent ${fmt(amount, cfg.decimals)} ETH, need ${cfg.deposit} ETH. A second payment can't be added to it: return this one (returns.csv) and ask for one new ${cfg.deposit} ETH deposit.`, ...res };
  return { ok: true, code: "VERIFIED", note: inferred ? "wallet taken from the transaction sender" : "", ...res };
}

/**
 * Check every deposit registration in a Luma export on-chain, each row on its own. Rows that point
 * at the same tx or wallet are sorted out afterwards (resolveClaims). Pure: no files written.
 */
export async function verifyRegistrations(prov, cfg, rows, { onlyDepositTicket = true } = {}) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const col = detectColumns(headers, cfg.columns);
  if (!col.tx) throw new Error(`Couldn't find the tx-link column. Headers: ${headers.join(" | ")}. Set config.columns.tx`);

  const ticketRe = new RegExp(cfg.depositTicketPattern ?? "deposit|commit|stake", "i");
  const cache = new Map();
  const results = [];
  for (const r of rows) {
    const who = { name: r[col.name] ?? "", email: (r[col.email] ?? "").toLowerCase().trim() };
    const isDepositTicket = col.ticket ? ticketRe.test(r[col.ticket] ?? "") : true;
    const rawTx = (r[col.tx] ?? "").trim();
    const txHash = extractTxHash(rawTx);
    // free "Request to Join" guest: skip unless they pasted an actual tx hash ("N/A", "-", "none"…)
    if (onlyDepositTicket && col.ticket && !isDepositTicket && !txHash) continue;

    const claimed = col.wallet ? normAddress(r[col.wallet]) : null;
    const approval = (col.approval ? r[col.approval] ?? "" : "").toLowerCase().trim();
    const base = { ...who, ticket: r[col.ticket] ?? "", approval, decision: lumaDecision(approval), wallet: claimed ?? "", tx: txHash ?? rawTx };

    if (!rawTx) { results.push({ ...base, ok: false, code: "NO_TX", note: "Deposit ticket but no tx link" }); continue; }
    if (!txHash) { results.push({ ...base, ok: false, code: "BAD_TX_HASH", note: "Couldn't find a 0x… tx hash in the answer" }); continue; }

    const check = (h) => {
      const key = `${h}|${claimed ?? ""}|${otherNetworkOf(rawTx) ?? ""}`;
      if (!cache.has(key))
        cache.set(key, verifyTx(prov, cfg, h, claimed, rawTx).catch((e) => ({ ok: false, code: "RPC_ERROR", note: e.shortMessage || e.message })));
      return cache.get(key);
    };
    // Several links in one answer (a failed send, then a good one): use the one that is this guest's
    // deposit. If more than one is, a person decides which (the others are given back).
    let txUsed = txHash;
    let res = await check(txHash);
    let unread = [];
    const hashes = extractTxHashes(rawTx);
    if (hashes.length > 1) {
      const checked = await Promise.all(hashes.map(async (h) => ({ h, res: await check(h) })));
      const good = checked.filter((c) => c.res.ok);
      const money = checked.filter((c) => MONEY_CODES.has(c.res.code));
      // a link that could not be read this run may be the deposit: say so rather than an earlier link's failure
      const notYet = checked.filter((c) => UNREAD_CODES.has(c.res.code));
      unread = notYet.map((c) => c.h);
      const pick = good[0] ?? money[0] ?? notYet.find((c) => c.res.code !== "TX_NOT_FOUND") ?? checked[0];
      txUsed = pick.h;
      res = pick.res;
      if (good.length > 1)
        res = { ...res, ok: false, code: "MULTIPLE_TX", note: `Pasted ${good.length} deposits that each verify (${good.map((c) => c.h).join(", ")}). Ask the guest which one is their deposit, then keep that link on Luma: the other is listed in unmatched.csv to give back.` };
      else if (hashes.length > 1) res = { ...res, note: [res.note, `${hashes.length} tx links pasted; checked ${txUsed}`].filter(Boolean).join("; ") };
    }
    results.push({
      ...base,
      ok: res.ok,
      inferred: !!res.inferred,
      deposits: res.deposits ?? [],
      units: res.amount,
      logIndex: res.logIndex,
      wallet: res.wallet ?? claimed ?? "",
      amount: res.amount !== undefined ? fmt(res.amount, cfg.decimals) : "",
      sent_at: res.ts ? new Date(res.ts * 1000).toISOString() : "",
      tx: txUsed,
      unread, // other pasted links that could not be read yet (their deposits wait for the next run)
      explorer: cfg.explorer ? `${cfg.explorer}/tx/${txUsed}` : "",
      block: res.block ?? "",
      code: res.code,
      note: [res.note, res.inferred && res.code !== "VERIFIED" ? "wallet taken from the transaction sender" : ""].filter(Boolean).join("; "),
    });
  }
  return { results, columns: col };
}

// Rows whose own wallet really sent ETH to the contract in their tx (whether or not it counts as a deposit).
export const MONEY_CODES = new Set(["VERIFIED", "OUTSIDE_WINDOW", "AMOUNT_TOO_LOW"]);
/** A tx that could not be read this run (it may still turn out to be a deposit). */
export const UNREAD_CODES = new Set(["RPC_ERROR", "TX_PENDING", "TX_NOT_FOUND"]);

/**
 * Several Luma rows can point at the same deposit (a copied tx link, a second sign-up) or at the
 * same wallet. Pick the row that really owns it, so that a copy can never knock out the real guest:
 *  - A row declined on Luma never wins over one that is not declined, so declining a copy is enough.
 *  - Same tx: a row whose stated ETH address sent it beats a row with a blank address whose wallet
 *    is registered on-chain, which beats other blank-address rows (their wallet is only guessed from
 *    the sender). A row whose stated wallet did NOT send it (WRONG_SENDER) and that is not declined
 *    blocks the plain blank-address rows: either could be the real owner (an exchange withdrawal).
 *  - Same wallet, different txs: a row whose deposit still backs a spot (`held`) wins.
 *  - Equals: if all are declined, the first one stands (so it is refunded once); if several are
 *    not declined, all of them are DUPLICATE_CLAIM until she declines the wrong ones.
 * The rows that lose are issues with no on-chain action (DUPLICATE_TX / DUPLICATE_WALLET), never
 * registered or refunded. Returns { kept, issues }; flagged rows keep their check result in `was`.
 */
export function resolveClaims(results, { isStaker = () => false, held = () => true } = {}) {
  const issues = [];
  const who = (r) => r.email || r.name || r.wallet || "another guest";
  const live = (r) => r.decision !== "declined";
  const flag = (r, code, note, extra = false) => issues.push({ ...r, was: r.code, code, note, extra });
  const pick = (pool) => {
    if (pool.length <= 1) return { keep: pool[0] ?? null, conflict: [] };
    const notDeclined = pool.filter(live);
    if (notDeclined.length === 1) return { keep: notDeclined[0], conflict: [] };
    if (!notDeclined.length) return { keep: pool[0], conflict: [] };
    return { keep: null, conflict: notDeclined };
  };
  const copyNote = (r, owner) =>
    `Same tx already claimed by ${who(owner)}. No on-chain action for this registration${live(r) ? "; if it is a copy, decline it on Luma" : ""}.`;

  // 1. rows pointing at the same tx
  const stage = [];
  const byTx = new Map();
  for (const r of results) {
    if (!TX_HASH_RE.test(r.tx)) { issues.push(r); continue; } // NO_TX / BAD_TX_HASH
    const k = r.tx.toLowerCase();
    if (!byTx.has(k)) byTx.set(k, []);
    byTx.get(k).push(r);
  }
  for (const group of byTx.values()) {
    if (group.length === 1) {
      (MONEY_CODES.has(group[0].code) ? stage : issues).push(group[0]);
      continue;
    }
    const claimants = group.filter((r) => MONEY_CODES.has(r.code));
    const blocked = group.some((r) => r.code === "WRONG_SENDER" && live(r));
    const blocker = group.find((r) => r.code === "WRONG_SENDER" && live(r));
    // 1: the stated ETH address sent it; 2: blank address, but that wallet is registered; 3: blank address
    const tier = (r) => (!r.inferred ? 1 : isStaker(r.wallet) ? 2 : 3);
    const owners = [];
    for (const w of new Set(claimants.map((r) => r.wallet))) {
      const mine = claimants.filter((r) => r.wallet === w);
      const eligible = mine.filter((r) => !(blocked && tier(r) === 3));
      if (!eligible.length) {
        for (const r of mine)
          flag(r, "DUPLICATE_CLAIM", `${who(blocker)} pasted the same tx with an ETH address that did not send it, and this registration has no ETH address. Decide by hand which one is real, and decline the other on Luma.`);
        continue;
      }
      // declined rows never win over a row that is not declined; then the best tier wins
      const notDeclined = eligible.filter(live);
      const base = notDeclined.length ? notDeclined : eligible;
      const best = Math.min(...base.map(tier));
      const top = base.filter((r) => tier(r) === best);
      const keep = top.length === 1 || !notDeclined.length ? top[0] : null;
      const conflict = keep ? [] : top;
      for (const r of conflict) flag(r, "DUPLICATE_CLAIM", "Several Luma registrations claim this deposit. Decline the wrong ones on Luma (or decide by hand which one is real).");
      if (keep) { stage.push(keep); owners.push(keep); }
      for (const r of mine) if (r !== keep && !conflict.includes(r)) flag(r, "DUPLICATE_TX", copyNote(r, keep ?? conflict[0]));
    }
    for (const r of group) {
      if (MONEY_CODES.has(r.code)) continue; // handled above
      if (owners.length) flag(r, "DUPLICATE_TX", copyNote(r, owners[0]));
      else issues.push(r); // nobody owns it yet: the row keeps its own code (e.g. WRONG_SENDER)
    }
  }

  // 2. rows using the same wallet with different txs
  const kept = [];
  const byWallet = new Map();
  for (const r of stage) {
    const k = r.wallet.toLowerCase();
    if (!byWallet.has(k)) byWallet.set(k, []);
    byWallet.get(k).push(r);
  }
  for (const group of byWallet.values()) {
    if (group.length === 1) { kept.push(group[0]); continue; }
    const heldRows = group.filter(held);
    const heldVerified = heldRows.filter((r) => r.code === "VERIFIED");
    const { keep, conflict } = pick(heldVerified.length ? heldVerified : heldRows.length ? heldRows : group);
    for (const r of conflict) flag(r, "DUPLICATE_CLAIM", "Several Luma registrations use this wallet. Decline the wrong ones on Luma (or decide by hand which one is real).");
    if (keep) kept.push(keep);
    for (const r of group) {
      if (r === keep || conflict.includes(r)) continue;
      if (keep) flag(r, "DUPLICATE_WALLET", `This wallet's deposit is already counted for ${who(keep)}. Any money from this extra deposit still held is listed in returns.csv.`, true);
      else flag(r, "DUPLICATE_WALLET", "Other registrations use this wallet too. Decide by hand which one is real.");
    }
  }
  return { kept, issues };
}

/**
 * How much of each deposit the contract still holds for the wallet that sent it.
 *
 * The contract only counts money in total, so this pairs, per wallet and in chain order, every
 * deposit with what the contract sent back to that wallet: Rejected events (rejectAndRefund, the
 * "Refund declined guests" button) and Refunded events (refund, "Return a stray transfer"). A
 * return only covers deposits made before it, by amount, oldest first, with these preferences:
 *  - while the wallet is a registered staker, one of its deposits is staked: refund() cannot touch
 *    that part (it only pays out spare money), and a Rejected of the staker returns it;
 *  - a Rejected of an unregistered payer goes first to the deposit a verified Luma row claims (`prefer`);
 *  - a Refunded goes first to a deposit whose unstaked part is exactly that amount, then to deposits
 *    no verified Luma row claims (strays, short or late payments), then oldest first.
 *
 * deposits: [{ tx, from, amount, block, logIndex }]
 * events:   [{ type: "Rejected" | "Refunded" | "StakerRegistered", wallet, amount, block, logIndex, tx }]
 * stakers:  lower-case wallets registered (or paid) at the snapshot, in case their registration is
 *           older than the scanned range.
 * Returns byDeposit: Map depKey → { remaining, staked, returnedBy[] }; free money = remaining
 * minus the deposit if staked. Also `unbacked` (registrations with no deposit of their own behind
 * them) and `unpaired` (returns larger than the deposits seen).
 */
export function pairReturns(deposits, events, { deposit, prefer = new Set(), stakers = new Set() }) {
  const byDeposit = new Map();
  const timeline = new Map();
  const at = (w) => {
    const k = String(w).toLowerCase();
    if (!timeline.has(k)) timeline.set(k, []);
    return timeline.get(k);
  };
  for (const d of deposits) {
    const k = depKey(d.tx, d.from);
    if (byDeposit.has(k)) continue;
    const s = { tx: String(d.tx).toLowerCase(), from: d.from, amount: d.amount, block: Number(d.block), logIndex: d.logIndex ?? -1, remaining: d.amount, staked: false, returnedBy: [] };
    byDeposit.set(k, s);
    at(d.from).push({ block: s.block, logIndex: s.logIndex, dep: s });
  }
  for (const e of events) at(e.wallet).push({ block: Number(e.block), logIndex: e.logIndex ?? 0, ev: e });

  const unbacked = [];
  const unpaired = [];
  const preferred = (s) => prefer.has(s.tx);
  for (const [wallet, list] of timeline) {
    list.sort((x, y) => x.block - y.block || x.logIndex - y.logIndex);
    const deps = [];
    let staked = null;
    const free = (s) => s.remaining - (s === staked ? deposit : 0n);
    const stakeOne = () => {
      const ok = deps.filter((s) => s.remaining >= deposit);
      return ok.find(preferred) ?? ok[0] ?? null;
    };
    for (const it of list) {
      if (it.dep) { deps.push(it.dep); continue; }
      const e = it.ev;
      if (e.type === "StakerRegistered") {
        staked = stakeOne();
        if (!staked) unbacked.push(e);
        continue;
      }
      let left = e.amount;
      if (e.type === "Rejected" && staked) {
        const t = staked.remaining < left ? staked.remaining : left;
        staked.remaining -= t;
        left -= t;
        staked.returnedBy.push(e.tx);
        staked = null;
      }
      const amount = left;
      const order = e.type === "Rejected"
        ? [...deps.filter(preferred), ...deps.filter((s) => !preferred(s))]
        : [...deps].sort((x, y) => (free(x) === amount ? 0 : 1) - (free(y) === amount ? 0 : 1) || (preferred(x) ? 1 : 0) - (preferred(y) ? 1 : 0));
      for (const s of order) {
        if (left === 0n) break;
        const f = free(s);
        if (f <= 0n) continue;
        const t = f < left ? f : left;
        s.remaining -= t;
        left -= t;
        s.returnedBy.push(e.tx);
      }
      if (left > 0n) unpaired.push({ ...e, left });
    }
    if (!staked && stakers.has(wallet)) staked = stakeOne();
    if (staked) staked.staked = true;
  }
  return { byDeposit, unbacked, unpaired };
}

/**
 * eth_getLogs over a block range in chunks of `step` blocks (cfg.logChunk, 5,000 by default), so
 * public RPCs that cap the range still answer. A chunk that fails is tried again `retries` times,
 * waiting a little longer each time (public RPCs sometimes answer "temporarily unavailable"); if it
 * still fails it is split in two halves (an RPC that wants smaller ranges), down to `minStep` blocks.
 * Only then does the scan stop, with a message saying what to change.
 */
export async function getLogsChunked(prov, filter, fromBlock, toBlock = "latest", step = DEFAULT_LOG_CHUNK,
  { retries = 3, delayMs = 1000, minStep = 100 } = {}) {
  const latest = toBlock === "latest" ? await prov.getBlockNumber() : Number(toBlock);
  const out = [];
  const range = async (from, to) => {
    let err;
    for (let attempt = 0; attempt <= retries; attempt++) {
      if (attempt) await new Promise((r) => setTimeout(r, delayMs * 2 ** (attempt - 1)));
      try {
        return void out.push(...(await prov.getLogs({ ...filter, fromBlock: from, toBlock: to })));
      } catch (e) {
        err = e;
      }
    }
    if (to - from + 1 > minStep) {
      const mid = from + Math.floor((to - from + 1) / 2);
      await range(from, mid - 1);
      return range(mid, to);
    }
    throw new Error(`Could not read the contract's history for blocks ${from}–${to} from the RPC after ${retries + 1} tries ` +
      `(${err?.shortMessage || err?.message}). Try again in a few minutes, or set another "rpcUrl" (or a smaller "logChunk") in the config.`);
  };
  for (let start = Number(fromBlock); start <= latest; start += step) await range(start, Math.min(start + step - 1, latest));
  return out;
}

/** Every deposit into the contract within a block range: its Deposited events, one entry per event. */
export async function incomingDeposits(prov, cfg, fromBlock, toBlock = "latest", step = cfg.logChunk ?? DEFAULT_LOG_CHUNK, opts) {
  const logs = await getLogsChunked(prov, { address: cfg.receiver, topics: [DEPOSITED_TOPIC] }, fromBlock, toBlock, step, opts);
  return logs.map((l) => ({
    tx: l.transactionHash.toLowerCase(),
    from: ethers.getAddress(ethers.dataSlice(l.topics[1], 12)),
    amount: BigInt(l.data),
    block: l.blockNumber,
    logIndex: l.index,
  }));
}

/** Safe{Wallet} Transaction Builder batch file (Apps → Transaction Builder → drag & drop). */
export function safeBatch(cfg, name, txs) {
  return {
    version: "1.0",
    chainId: String(cfg.chainId),
    createdAt: Date.now(),
    meta: { name, description: name },
    transactions: txs.map((t) => ({ to: t.to, value: "0", data: t.data, contractMethod: null, contractInputsValues: null })),
  };
}

// ---------------------------------------------------------------- the lists (verify-deposits, build-payout)

const QUIET = { info() {}, warn() {} };

/**
 * The deposit contract at cfg.receiver, checked: it has code, and its depositAmount is the config's
 * deposit (every check uses cfg.depositUnits, so payers of the wrong amount would be listed otherwise).
 * Returns { contract (read-only ethers.Contract), depositAmount }. Throws an error with `code`
 * "NO_KICKBACK_CONTRACT" or "DEPOSIT_MISMATCH" (and `depositAmount`), so each caller words its own advice.
 */
export async function checkContract(prov, cfg, abi) {
  if (!isContractCode(await prov.getCode(cfg.receiver)))
    throw Object.assign(new Error(`No deposit contract at ${cfg.receiver} on ${cfg.chainName}.`), { code: "NO_KICKBACK_CONTRACT" });
  const contract = new ethers.Contract(cfg.receiver, abi, prov);
  const depositAmount = await contract.depositAmount();
  if (depositAmount !== cfg.depositUnits)
    throw Object.assign(new Error(`The settings say the deposit is ${cfg.deposit} ETH, but the contract at ${cfg.receiver} was deployed with ${fmt(depositAmount)} ETH.`),
      { code: "DEPOSIT_MISMATCH", depositAmount });
  return { contract, depositAmount };
}

// Columns of the files verify-deposits.mjs writes (the admin panel offers the same lists as CSV)
const V_COLS = ["name", "email", "ticket", "approval", "onchain", "wallet", "amount", "sent_at", "tx", "explorer", "note"];
export const CHECK_COLUMNS = {
  verified: V_COLS,
  issues: ["code", ...V_COLS],
  toReview: V_COLS,
  returns: ["code", "name", "email", "wallet", "to_return", "paid", "tx", "explorer", "note"],
  claims: ["wallet", "email", "name", "code", "approval", "tx"],
  unmatched: ["status", "from", "amount", "to_return", "block", "tx", "explorer", "note"],
};

/**
 * Everything verify-deposits.mjs lists, as data (no files): checks every Luma registration's pasted
 * deposit on-chain, pairs what the contract already sent back with each wallet's deposits, and sorts
 * the verified payers by the organiser's decision on Luma (approval_status).
 *   prov      ethers provider on the contract's network
 *   cfg       a normalized config (normalizeConfig / lib.mjs loadConfig) for the contract (cfg.receiver)
 *   abi       the TruthPaysKickback ABI
 *   rows      the Luma guest export, as CSV rows (parseCsv / lib.mjs readCsv)
 *   scanFrom  the block to scan deposits and returns from (the deploy block); undefined scans from
 *             block 0, with a warning (only fine on a local test chain)
 *   contract  checkContract(...).contract when the caller checked it already (checked here otherwise)
 *   log       { info, warn } for progress lines and warnings, as the script prints them (default: quiet)
 * Returns the rows of each list (CHECK_COLUMNS name their file columns):
 *   verified, issues, toReview, returns, unmatched, claims, newStakers, refunds;
 *   lists: { newStakers, refunds }: the new-stakers.json / refunds.json contents (stamped with the
 *          contract, chainId, deposit and block, so a page or owner.mjs can refuse them once out of date);
 *   held (verified deposits still held), issueCounts ({ code: count }), incoming (deposit events),
 *   totalIncoming, openUnmatched, unbacked, unpaired, warnings (every warning given), columns,
 *   snapshotBlock, results (each row's own check), byDeposit (pairReturns: what is left of each
 *   deposit), statusOf (lower-case wallet → STATUS at the snapshot), listOpen (attendance list not posted).
 */
export async function checkGuests({ prov, cfg, abi, rows, scanFrom, contract, log = QUIET }) {
  const warnings = [];
  const warn = (m) => { warnings.push(m); log.warn(m); };
  const kickbackAddr = cfg.receiver;
  const c = contract ?? (await checkContract(prov, cfg, abi)).contract;
  const iface = new ethers.Interface(abi);

  const { results, columns } = await verifyRegistrations(prov, cfg, rows);
  log.info(`Columns used: ${JSON.stringify(columns)}`);
  if (!columns.approval) warn("⚠️  No approval_status column: every verified payer is treated as pending.");

  const snapshotBlock = await prov.getBlockNumber();
  if (scanFrom === undefined) {
    warn('⚠️  No "deployBlock" in the config: scanning from block 0 (only fine on a local test chain).');
    scanFrom = 0;
  }

  // Every deposit we know of: the ones guests pasted, plus every Deposited event since the start block.
  const perDeposit = new Map(); // one deposit = what one wallet sent in one tx
  for (const t of await incomingDeposits(prov, cfg, scanFrom, snapshotBlock)) {
    const k = depKey(t.tx, t.from);
    const d = perDeposit.get(k) ?? { ...t, amount: 0n };
    d.amount += t.amount;
    d.logIndex = Math.min(d.logIndex, t.logIndex);
    perDeposit.set(k, d);
  }
  const incoming = [...perDeposit.values()];
  const deposits = [...incoming];
  for (const r of results) for (const d of r.deposits ?? []) deposits.push({ tx: r.tx, from: d.from, amount: d.amount, block: r.block, logIndex: d.logIndex });

  // On-chain status of every wallet that sent money, at one block
  const statusOf = new Map(); // lower-case wallet → 0..3 (missing = could not be read)
  const st = (w) => statusOf.get(String(w).toLowerCase());
  const senders = [...new Set(deposits.map((d) => ethers.getAddress(d.from)))].filter((w) => w !== ethers.ZeroAddress);
  for (let i = 0; i < senders.length; i += 10) {
    await Promise.all(senders.slice(i, i + 10).map(async (w) => {
      try {
        statusOf.set(w.toLowerCase(), Number(await c.status(w, { blockTag: snapshotBlock })));
      } catch (e) {
        warn(`Could not read status of ${w}: ${e.shortMessage || e.message}`);
      }
    }));
  }

  // What the contract sent back to each wallet, and when it registered them. The range starts at the
  // oldest deposit we know of, so no refund of a pasted deposit is missed.
  const from = Math.min(scanFrom, ...deposits.map((d) => Number(d.block)).filter(Number.isFinite));
  const topics = [["Rejected", "Refunded", "StakerRegistered"].map((n) => iface.getEvent(n).topicHash)];
  const events = (await getLogsChunked(prov, { address: kickbackAddr, topics }, from, snapshotBlock, cfg.logChunk)).map((l) => {
    const p = iface.parseLog(l);
    return {
      type: p.name, wallet: ethers.getAddress(p.args[0]), amount: p.name === "StakerRegistered" ? 0n : p.args[1],
      block: l.blockNumber, logIndex: l.index, tx: l.transactionHash.toLowerCase(),
    };
  });
  // A registered staker can only be refunded while the event is open (before the attendance list).
  const listOpen = Number(await c.phase({ blockTag: snapshotBlock })) === 0;
  const dep = cfg.depositUnits;
  const { byDeposit, unbacked, unpaired } = pairReturns(deposits, events, {
    deposit: dep,
    prefer: new Set(results.filter((r) => r.code === "VERIFIED").map((r) => r.tx.toLowerCase())),
    stakers: new Set([...statusOf].filter(([, s]) => s === STATUS.Staker || s === STATUS.Paid).map(([w]) => w)),
  });
  const depOf = (r) => byDeposit.get(depKey(r.tx, r.wallet));
  // money of this row's deposit the contract still holds and nobody has staked
  const freeOf = (r) => {
    const d = depOf(r);
    return d ? d.remaining - (d.staked ? dep : 0n) : r.units ?? 0n;
  };
  const held = (r) => !!depOf(r)?.staked || freeOf(r) >= dep;

  // Several rows claiming one tx or one wallet: keep the real owner, flag the others.
  const { kept, issues } = resolveClaims(results, { isStaker: (w) => st(w) === STATUS.Staker, held });

  const verified = [];
  const newStakers = [];
  const refunds = [];
  const toReview = [];
  const returns = [];
  const STRAY = "'Return a stray transfer'";
  // wallets whose registration is backed by one of their own deposits
  const backed = new Set([...byDeposit.values()].filter((d) => d.staked).map((d) => d.from.toLowerCase()));
  const giveBack = (r, code, amount, note) => {
    // a registered wallet with no deposit of its own behind its spot: returning more would dig the hole deeper
    const s = st(r.wallet);
    if (amount <= 0n || ((s === STATUS.Staker || s === STATUS.Paid) && !backed.has(r.wallet.toLowerCase()))) return false;
    returns.push({ code, name: r.name, email: r.email, wallet: r.wallet, to_return: fmt(amount, cfg.decimals), units: amount, paid: r.amount, tx: r.tx, explorer: r.explorer, note });
    return true;
  };
  const LABEL = ["unregistered", "registered", "paid", "refunded"];

  for (const r of kept) {
    const s = st(r.wallet);
    const free = freeOf(r);
    r.onchain = s === undefined ? "unknown" : LABEL[s];
    if (r.code !== "VERIFIED") {
      // the guest's own wallet sent money, but it can't be a deposit (short or late)
      issues.push(r);
      if (s === undefined) continue;
      if (r.code === "AMOUNT_TOO_LOW") {
        if (free === 0n) r.note += " (Already returned.)";
        giveBack(r, "AMOUNT_TOO_LOW", free, "Short deposit: return it and ask for one new payment of the full deposit");
      } else if (r.decision === "declined" && s === STATUS.None && free >= dep) {
        // a declined late payer: rejectAndRefund works for unregistered payers while their money is spare
        refunds.push({ ...r, onchain: "unregistered" });
        r.note += ". Declined: in refunds.json ('Refund declined guests')";
        giveBack(r, "OVERPAID", free - dep, `Late and overpaid: the rest after 'Refund declined guests' sends back ${cfg.deposit} ETH`);
      } else {
        giveBack(r, "OUTSIDE_WINDOW", free, r.decision === "declined"
          ? "Late payment, declined"
          : "Late payment: it can't be registered. Return it, or decline on Luma so 'Refund declined guests' sends it back");
      }
      continue;
    }

    verified.push(r);
    if (s === STATUS.None && !held(r)) r.onchain = "returned";
    if (s === STATUS.Rejected && held(r)) r.onchain = "refunded, paid again"; // a new deposit after their refund
    let used = 0n; // the part of this deposit a listed action takes (a spot, or the refund of the deposit)
    switch (r.onchain) {
      case "unregistered":
      case "refunded, paid again":
        if (r.decision === "approved") { newStakers.push(r); used = dep; }
        else if (r.decision === "declined") {
          if (r.onchain === "unregistered") { refunds.push(r); used = dep; }
          else {
            issues.push({ ...r, code: "PAID_AGAIN_DECLINED", note: `Declined, refunded once already, and then paid again. Return the new deposit with ${STRAY} (listed in returns.csv).` });
            giveBack(r, "PAID_AGAIN_DECLINED", free, "Declined, refunded once already, then paid again");
            used = free;
          }
        } else { toReview.push(r); used = dep; }
        break;
      case "returned":
        if (r.decision !== "declined")
          issues.push({ ...r, code: "RETURNED_EARLIER", note: `This deposit was already returned (${STRAY}). The guest must send a new ${cfg.deposit} ETH deposit and paste that link before they can be registered.` });
        giveBack(r, "PARTLY_RETURNED", free, "Rest of a deposit that was partly returned: it can no longer hold a spot");
        used = free;
        break;
      case "refunded":
        if (r.decision === "approved")
          issues.push({ ...r, code: "REFUNDED_EARLIER", note: "Approved now, but this deposit was already refunded. They must send a new deposit before they can be registered." });
        giveBack(r, "PARTLY_RETURNED", free, "Left over from a refunded deposit");
        used = free;
        break;
      case "registered":
        if (!listOpen) {
          // after the list is posted rejectAndRefund refuses stakers (and would revert the whole batch)
          if (r.decision !== "approved")
            issues.push({ ...r, code: "DECLINED_AFTER_LIST", note: "Registered, and no longer approved on Luma, but the attendance list is already posted: the deposit stays in the pool. They are paid only if they are on the list. Nothing to do on-chain." });
        } else if (r.decision === "declined") refunds.push(r); // rejectAndRefund sends the staked deposit back
        else if (r.decision !== "approved")
          issues.push({ ...r, code: "REGISTERED_NOT_APPROVED", note: "Registered on-chain but no longer approved on Luma. Approve again, or decline to refund." });
        break;
      case "paid":
        break;
      default:
        continue; // status unknown: no action, nothing to give back
    }
    // Money beyond one deposit from this tx (an overpayment, or a second deposit of a registered wallet)
    const extra = free - used;
    if (giveBack(r, "OVERPAID", extra, "More than the deposit")) {
      r.note = [r.note, `overpaid by ${fmt(extra, cfg.decimals)} ETH (return the excess with ${STRAY}; see returns.csv)`].filter(Boolean).join("; ");
      issues.push({ ...r, code: "OVERPAID", note: `${fmt(extra, cfg.decimals)} ETH more than the deposit is still held from this payment. Return the excess with ${STRAY} (listed in returns.csv).` });
    }
  }
  // A second deposit from a wallet already counted for another registration goes back to that wallet.
  for (const i of issues) if (i.code === "DUPLICATE_WALLET" && i.extra && st(i.wallet) !== undefined) giveBack(i, "DUPLICATE_WALLET", freeOf(i), "Second deposit from a wallet that is already counted");

  // Safety net: a wallet is listed once, never as the zero address (either would make the batch revert).
  const listed = [...newStakers, ...refunds].map((v) => v.wallet.toLowerCase());
  if (new Set(listed).size !== listed.length || listed.includes(ethers.ZeroAddress))
    throw new Error("Internal check failed: a wallet would be listed twice (or is 0x0). Nothing was written; investigate.");

  // Deposits nobody's Luma row points at.
  // A deposit is claimed by a row whose own wallet sent it. A row whose tx came from someone else
  // (WRONG_SENDER, UNUSUAL_SENDER, AMBIGUOUS_SENDER) claims nothing, so that money is still listed
  // here; only a row we could not check yet (RPC_ERROR, TX_PENDING, or TX_NOT_FOUND although the
  // deposit is there by now) keeps its whole tx out until the next run.
  const claimedDep = new Set(results.filter((r) => MONEY_CODES.has(r.code)).map((r) => depKey(r.tx, r.wallet)));
  const unchecked = new Set([
    ...results.filter((r) => UNREAD_CODES.has(r.code)).map((r) => r.tx),
    ...results.flatMap((r) => r.unread ?? []),
  ].map((t) => String(t).toLowerCase()));
  // Luma answers that mention a deposit's tx, and the ETH addresses guests gave: a deposit nobody
  // claimed may still be a guest's (a second link they pasted, or a send they never pasted)
  const mentions = (tx) => rows.filter((row) => Object.values(row).some((v) => String(v ?? "").toLowerCase().includes(tx)));
  const statedBy = new Map();
  for (const row of rows) {
    const w = columns.wallet ? normAddress(row[columns.wallet]) : null;
    if (w) statedBy.set(w.toLowerCase(), [...(statedBy.get(w.toLowerCase()) ?? []), row]);
  }
  const rowName = (row) => (columns.email && row[columns.email]) || (columns.name && row[columns.name]) || "a guest";
  const pastedBy = new Map(); // tx → the rows with a sender problem that pasted it
  for (const r of results) if (/_SENDER$/.test(r.code)) {
    const k = String(r.tx).toLowerCase();
    pastedBy.set(k, [...(pastedBy.get(k) ?? []), r]);
  }
  const unmatched = [];
  for (const t of incoming.filter((x) => !claimedDep.has(depKey(x.tx, x.from)) && !unchecked.has(x.tx))) {
    const d = byDeposit.get(depKey(t.tx, t.from));
    const free = d.remaining - (d.staked ? dep : 0n);
    let status = "open";
    let note = "";
    const pasted = pastedBy.get(t.tx);
    if (free <= 0n) status = d.staked ? "held for a registered staker" : `already refunded (${[...new Set(d.returnedBy)].join(" ")})`;
    else if (isContractCode(await prov.getCode(t.from))) note = "Sent by a contract (an exchange, a Safe or another smart wallet?): check where it should go before returning it.";
    else if (free < t.amount) note = `Partly returned already (${[...new Set(d.returnedBy)].join(" ")}).`;
    if (free > 0n && !pasted) {
      const seen = mentions(t.tx), owners = statedBy.get(t.from.toLowerCase()) ?? [];
      if (seen.length) note = [`This tx link is in the Luma answers of ${seen.map(rowName).join(", ")}: ask them about it before returning it (it may be their deposit).`, note].filter(Boolean).join(" ");
      else if (owners.length) note = [`Sent from the ETH address ${owners.map(rowName).join(", ")} gave on Luma: ask them for this tx link instead of returning it.`, note].filter(Boolean).join(" ");
    }
    if (free > 0n && pasted) note = [`Pasted on Luma by ${pasted.map((r) => `${r.email || r.name} (${r.code})`).join(", ")}: sort that out with the guest first ` +
      `(if the sender is their own wallet, they put it as their ETH address on Luma and it verifies). Return it only once that's agreed.`, note].filter(Boolean).join(" ");
    unmatched.push({ status, from: t.from, amount: fmt(t.amount, cfg.decimals), to_return: fmt(free > 0n ? free : 0n, cfg.decimals), units: free > 0n ? free : 0n, block: t.block, tx: t.tx, explorer: `${cfg.explorer}/tx/${t.tx}`, note });
  }

  // every row whose tx verified as its wallet's deposit, duplicates included: a check-in through any
  // of them counts for that wallet (payouts only ever go to the registered wallet itself)
  const claims = [...verified, ...issues.filter((i) => i.was === "VERIFIED" && /^DUPLICATE_/.test(i.code))]
    .map((r) => ({ ...r, code: r.was ? r.code : "VERIFIED" }));
  // A page (or owner.mjs) checks contract, network, deposit amount (in wei) and each wallet's on-chain status
  // before sending, so an out-of-date list is refused instead of acting on a guest whose situation has changed.
  const stamp = { contract: kickbackAddr, chainId: Number(cfg.chainId), deposit: dep.toString(), block: snapshotBlock, generatedAt: new Date().toISOString() };
  const STATUS_OF = { unregistered: 0, registered: 1, "refunded, paid again": 3 };
  const item = (v) => ({ wallet: v.wallet, name: v.name, email: v.email, onchain: v.onchain, status: STATUS_OF[v.onchain] });

  for (const u of unbacked)
    warn(`⚠️  ${u.wallet} was registered (tx ${u.tx}) while none of its own deposits was left in the contract: its spot is backed by someone else's money. Investigate before refunding anyone.`);
  for (const u of unpaired)
    warn(`⚠️  ${fmtEth(u.left)} sent back to ${u.wallet} (tx ${u.tx}) matches no deposit seen from that wallet: either its deposit is ` +
      `older than the scanned range (check --scan-from-block / deployBlock), or that wallet got back more than it sent (someone else's money).`);

  const openUnmatched = unmatched.filter((u) => u.status === "open");
  return {
    verified, issues, toReview, returns, unmatched, claims, newStakers, refunds,
    lists: { newStakers: { ...stamp, items: newStakers.map(item) }, refunds: { ...stamp, items: refunds.map(item) } },
    held: verified.filter((v) => ["unregistered", "registered", "paid", "refunded, paid again"].includes(v.onchain)),
    issueCounts: issues.reduce((m, i) => ((m[i.code] = (m[i.code] ?? 0) + 1), m), {}),
    incoming,
    totalIncoming: incoming.reduce((s, t) => s + t.amount, 0n),
    openUnmatched,
    unbacked, unpaired, warnings, columns, snapshotBlock, results,
    byDeposit, statusOf, listOpen,
  };
}

/**
 * Every deposit the contract received since `scanFrom`, for a page's "Deposits" table, with no Luma
 * export: each deposit is checked by checkGuests as if its sender had registered with it and were
 * still waiting for the organiser's decision, so the same rules decide (full amount, in time, sent by
 * an ordinary wallet, still held after what was returned, one spot per wallet). One row per deposit
 * (one wallet in one tx), oldest first:
 *   { tx, from, amount (wei), block, sentAt, explorer, status ("unregistered", "registered", "paid",
 *     "refunded", "returned", "refunded, paid again" or "unknown"), held (wei of it the contract still
 *     holds, net of returns), code ("VERIFIED" or why not: AMOUNT_TOO_LOW, OUTSIDE_WINDOW,
 *     UNUSUAL_SENDER…), note, heldForSpot (the contract still holds a whole deposit of this payment:
 *     it is staked, or nothing was returned from it that would leave less than the deposit), canRegister, canRefund }
 * canRegister: registerStakers accepts the wallet for this deposit (only before the attendance list is
 * posted). canRefund: rejectAndRefund sends this deposit back (an unregistered payer whose deposit is
 * held, in any phase, or a registered staker while the attendance list is not posted). Money beyond one deposit (overpaid, short, late) is in `returns`, to
 * give back with refund(). Also returns the whole checkGuests result as `check` (null when no deposit came in yet).
 */
export async function depositsOverview({ prov, cfg, abi, scanFrom, contract, log = QUIET }) {
  const c = contract ?? (await checkContract(prov, cfg, abi)).contract;
  const incoming = await incomingDeposits(prov, cfg, scanFrom ?? 0);
  if (!incoming.length) return { deposits: [], returns: [], check: null }; // nothing to check yet
  // one registration per deposit tx, with no ETH address: the wallet is the sender, as for a guest who left it blank
  const rows = [...new Set(incoming.map((d) => d.tx))].map((tx) => ({ name: "", email: "", ticket_name: "deposit", approval_status: "pending_approval", eth_address: "", tx }));
  // scanFrom undefined: checkGuests warns that it scans from block 0 (only fine on a local test chain)
  const check = await checkGuests({ prov, cfg: { ...cfg, columns: {}, depositTicketPattern: "deposit" }, abi, rows, scanFrom, contract: c, log });
  const LABEL = ["unregistered", "registered", "paid", "refunded"];
  const reviewable = new Set(check.toReview.map((r) => depKey(r.tx, r.wallet)));
  const byKey = new Map();
  for (const r of [...check.verified, ...check.issues, ...check.toReview]) if (r.wallet && !byKey.has(depKey(r.tx, r.wallet))) byKey.set(depKey(r.tx, r.wallet), r);
  const out = [];
  for (const d of incoming) {
    const key = depKey(d.tx, d.from);
    const prev = out.find((o) => depKey(o.tx, o.from) === key);
    if (prev) { prev.amount += d.amount; continue; } // several Deposited events of one wallet in one tx
    const r = byKey.get(key) ?? check.results.find((x) => x.tx === d.tx) ?? {};
    const pairing = check.byDeposit.get(key);
    const s = check.statusOf.get(d.from.toLowerCase());
    const status = r.onchain ?? (s === undefined ? "unknown" : LABEL[s]);
    out.push({
      tx: d.tx, from: d.from, amount: d.amount, block: d.block, sentAt: r.sent_at ?? "", explorer: `${cfg.explorer}/tx/${d.tx}`,
      status, held: pairing ? pairing.remaining : 0n, code: r.code ?? "", note: r.note ?? "",
      // the contract still holds a whole deposit of this payment for a spot: staked, or not returned (in full or in part)
      heldForSpot: !!pairing && (pairing.staked || pairing.remaining >= cfg.depositUnits),
      canRegister: reviewable.has(key) && check.listOpen, // registerStakers only works before the attendance list
      canRefund: (reviewable.has(key) && status === "unregistered") || (r.code === "VERIFIED" && status === "registered" && check.listOpen),
    });
  }
  return { deposits: out, returns: check.returns, check };
}

export const PAYOUT_COLUMNS = ["name", "email", "wallet", "attended", "payout"];

/**
 * Everything build-payout.mjs makes, as data (no files): matches Luma check-ins against the stakers
 * registered in the contract (the source of truth) and computes the share per attendee.
 *   prov, cfg, abi  as for checkGuests; the contract is cfg.contract
 *   checkins        the Luma export after the event, as CSV rows (checked_in_at and email columns), or
 *                   null to go by the door list (`extra`) alone
 *   verified       verified.csv rows, or checkGuests(...).verified (wallet, name, email, approval)
 *   claims          claims.csv rows, or checkGuests(...).claims: every registration that verified a
 *                   wallet's deposit, duplicates included, so a copied tx link can't turn a guest who
 *                   came into a no-show
 *   extra           door-list rows with an email and/or wallet column (anyone checked in by hand), or
 *                   undefined; `extraName` names it in messages
 *   title           the summary's heading ("Truth Pays")
 *   log             { info, warn } (default: quiet)
 * A check-in counts only through the guest's own registration (their email), never through a wallet
 * typed into somebody else's row; a door list may also name wallets.
 * Returns { contract, stakers, attendees, noShows, deposit, pool, share, dust, plan (payout-plan.json:
 * what "Post attendance list" sends), payoutRows (PAYOUT_COLUMNS), summaryMarkdown (payout-summary.md), door ({ rows,
 * unmatched } or null), missing (approved, verified, not registered), unknown + unknownNote (registered
 * stakers no verified registration names: counted as no-shows here, the caller decides whether to go on) }.
 */
export async function buildPayout({ prov, cfg, abi, checkins, verified = [], claims = [], extra, extraName = "the door list", title = "Truth Pays", log = QUIET }) {
  if (!cfg.contract) throw new Error('Set "contract" in the config: the stakers and the pool are read from the deployed contract.');
  // Who checked in?
  if (!checkins && !extra) throw new Error("Give the Luma export after the event, a door list, or both.");
  const checkedEmails = new Set();
  const checkedWallets = new Set(); // only from the organiser's own door list
  if (checkins) {
    const col = detectColumns(Object.keys(checkins[0] ?? {}), cfg.columns);
    if (!col.checkedIn) throw new Error("No checked_in_at column found in the Luma export");
    if (!col.email) throw new Error("No email column found in the Luma export");
    for (const r of checkins) {
      if (!(r[col.checkedIn] ?? "").trim()) continue;
      if (r[col.email]) checkedEmails.add(r[col.email].toLowerCase().trim());
    }
  }
  let extraRows = [];
  if (extra) {
    const xc = detectColumns(Object.keys(extra[0] ?? {}), {});
    if (!xc.email && !xc.wallet) throw new Error(`${extraName}: needs an "email" or "wallet" column`);
    extraRows = extra.map((r) => ({ email: (r[xc.email] ?? "").toLowerCase().trim(), wallet: xc.wallet ? normAddress(r[xc.wallet]) : null }));
    for (const r of extraRows) {
      if (r.email) checkedEmails.add(r.email);
      if (r.wallet) checkedWallets.add(r.wallet);
    }
  }

  // Stakers and the deposit come from the contract (the source of truth)
  const contractAddr = ethers.getAddress(cfg.contract);
  const c = new ethers.Contract(contractAddr, abi, prov);
  const all = await c.stakers();
  const st = await Promise.all(all.map((w) => c.status(w)));
  const stakerWallets = [...new Set(all.filter((_, i) => Number(st[i]) === STATUS.Staker).map((w) => ethers.getAddress(w)))];
  const count = await c.stakerCount();
  if (BigInt(stakerWallets.length) !== count) throw new Error(`On-chain staker list (${stakerWallets.length}) and stakerCount (${count}) disagree; stop and investigate`);
  const deposit = await c.depositAmount();
  if (deposit !== cfg.depositUnits)
    log.warn(`⚠️  The contract's deposit is ${fmt(deposit)} ETH but the config says ${cfg.deposit} ETH: using the contract's amount. Fix "deposit" in the config.`);
  const approved = verified.filter((v) => lumaDecision(v.approval) === "approved").map((v) => ethers.getAddress(v.wallet));
  const missing = [...new Set(approved)].filter((w) => !stakerWallets.includes(w));
  if (missing.length) log.warn(`⚠️  ${missing.length} approved wallets with a verified deposit are NOT registered on-chain and can't be paid: ${missing.join(", ")}`);

  // wallet → its name and email (verified.csv first) and every email whose registration verified it
  const byWallet = new Map();
  for (const v of [...verified, ...claims]) {
    const w = normAddress(v.wallet);
    if (!w) continue;
    const email = uncell(v.email).toLowerCase().trim();
    const e = byWallet.get(w) ?? { name: uncell(v.name), email, emails: new Set() };
    if (email) e.emails.add(email);
    byWallet.set(w, e);
  }
  const unknown = stakerWallets.filter((w) => !byWallet.has(w));
  const unknownNote = unknown.length
    ? `${unknown.length} registered stakers have no Luma registration that verified their wallet, so their check-in cannot be matched: ${unknown.join(", ")}`
    : "";
  const attendees = [];
  const noShows = [];
  for (const w of stakerWallets) {
    const v = byWallet.get(w);
    const showed = checkedWallets.has(w) || (!!v && [...v.emails].some((e) => checkedEmails.has(e)));
    (showed ? attendees : noShows).push({ wallet: w, name: v?.name ?? "", email: v?.email ?? "", emails: v?.emails ?? new Set() });
  }

  const n = BigInt(stakerWallets.length);
  const pool = deposit * n;
  const share = attendees.length ? pool / BigInt(attendees.length) : 0n;
  const dust = pool - share * BigInt(attendees.length);
  if (attendees.length && (await c.previewShare(attendees.length)) !== share)
    throw new Error("The contract computes a different share for this list; stop and investigate (is the config on the right contract?)");

  let door = null;
  if (extraRows.length) {
    const staff = new Set(attendees.flatMap((x) => [...x.emails, x.wallet]));
    door = { rows: extraRows.length, unmatched: extraRows.filter((r) => !staff.has(r.email) && !staff.has(r.wallet)) };
  }
  const plan = {
    contract: contractAddr,
    chainId: Number(cfg.chainId),
    stakers: stakerWallets.length,
    attendees: attendees.map((x) => x.wallet),
    share: share.toString(), // wei: what postAttendance must be given
    shareEth: fmt(share),
  };
  const payoutRows = [
    ...attendees.map((x) => ({ ...x, attended: "yes", payout: fmt(share) })),
    ...noShows.map((x) => ({ ...x, attended: "no", payout: "0" })),
  ];
  const summaryMarkdown = `# ${title}: deposit settlement

| | |
|---|---|
| Stakers | ${stakerWallets.length} |
| Showed up | ${attendees.length} |
| No-shows | ${noShows.length} |
| Pool | ${fmtEth(pool)} |
| Payout per attendee (if nobody is added by a challenge) | ${fmtEth(share)} (deposit ${fmtEth(deposit)} + ${fmtEth(share > deposit ? share - deposit : 0n)} bonus) |
| Rounding dust | ${fmt(dust)} ETH |
| Contract | ${cfg.explorer}/address/${contractAddr} |
`;
  return { contract: contractAddr, stakers: stakerWallets, attendees, noShows, deposit, pool, share, dust, plan, payoutRows, summaryMarkdown, door, missing, unknown, unknownNote };
}
