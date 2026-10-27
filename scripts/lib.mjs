// Shared helpers: config, Kleros settings, CSV I/O, Luma column detection, deposit verification
// (from the contract's own Deposited events), chunked log scans with retries.
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { ethers } from "ethers";

// A deposit is the contract's own Deposited event (receive() or deposit()): `from` is the wallet that
// sent the ETH (a Safe or smart wallet shows up as its own address), `amount` is in wei.
export const DEPOSITED_EVENT = "event Deposited(address indexed from, uint256 amount)";
const DEPOSITED = new ethers.Interface([DEPOSITED_EVENT]);
export const DEPOSITED_TOPIC = DEPOSITED.getEvent("Deposited").topicHash;

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
 * Reads a config file (config.json live, config.rehearsal.json rehearsal) and adds what every
 * script needs: chainId, explorer, symbol/decimals (always ETH / 18), the deposit and pool cap in
 * wei (depositUnits, poolCapUnits), the deposit address (receiver), the deposit window and contract
 * times in unix seconds, deployBlock and logChunk.
 */
export function loadConfig(file = "config.json") {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  if (cfg.token || cfg.tokenDecimals)
    throw new Error(`${file} still has "token"/"tokenDecimals": deposits are in ETH now. Remove them and set "deposit" in ETH (e.g. "0.01").`);
  const chain = CHAINS[cfg.chain];
  if (!chain && !cfg.chainId)
    throw new Error(`Unknown chain "${cfg.chain}" in ${file}: use "ethereum" (Ethereum mainnet), or set "chainId" for a local test chain`);
  const chainId = Number(cfg.chainId ?? chain.chainId);
  if (chain && chainId !== chain.chainId) throw new Error(`"chainId" ${chainId} in ${file} does not match chain "${cfg.chain}" (${chain.chainId})`);

  const depositUnits = parseEth(cfg, "deposit", file);
  if (depositUnits <= 0n) throw new Error(`"deposit" in ${file} must be more than 0 ETH`);
  if (depositUnits > ethers.parseEther(MAX_DEPOSIT_ETH))
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
export const PAYOUT_GAS = 100_000; // must match the contract: gas a batch payment may use in the recipient

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
// Pins that describe an earlier version (Arbitrum One, USDC, Kleros v2) and must not be used any more.
export const STALE_PINS = ["QmZMDkYNHVH5bZNPwNnav1ZoziRgL57zE6pTmwo5dqGGGg"];

/**
 * Kleros settings from config.kleros, with mainnet defaults: General Court (0), 3 jurors.
 * Returns { disputeResolver, arbitrator, court, jurors, extraData, policyURI, metaEvidenceURI,
 * courtUrl, ipfsUpload, ipfsGateway }. `kleros.disputeResolver` / `kleros.arbitrator` override the
 * addresses (local tests); `arbitrator` is "" when unknown (the contract's `arbitrator()` has it).
 */
export function klerosConfig(cfg) {
  const k = cfg.kleros ?? {};
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
    metaEvidenceURI: k.metaEvidenceURI ?? "",
    courtUrl: k.courtUrl || known.court || "https://court.kleros.io",
    ipfsUpload: k.ipfsUpload || KLEROS_IPFS_UPLOAD,
    ipfsGateway: k.ipfsGateway || KLEROS_IPFS_GATEWAY,
  };
}

/**
 * Constructor arguments for TruthPaysKickback, checked before anything is sent:
 * [depositAmount (wei), eventName, owner, eventStart, claimDeadline,
 *  [disputeResolver, extraData, metaEvidenceURI, policyURI]].
 * In live mode both the policy and the metaevidence must be pinned IPFS paths.
 */
export function deployArgs(cfg, owner) {
  const { eventStartTs: start, claimDeadlineTs: end } = cfg;
  if (!start || !end)
    throw new Error('Set "eventStart" and "claimDeadline" in the config (ISO dates with timezone)');
  if (end < start + MIN_SETTLEMENT_WINDOW) throw new Error("claimDeadline must be at least 7 days after eventStart");
  if (!(typeof cfg.depositUnits === "bigint" && cfg.depositUnits > 0n)) throw new Error("No deposit amount: load the config with loadConfig()");
  const k = klerosConfig(cfg);
  for (const [key, v] of [["policyURI", k.policyURI], ["metaEvidenceURI", k.metaEvidenceURI]]) {
    if (STALE_PINS.some((p) => String(v).includes(p)))
      throw new Error(`"kleros.${key}" (${v}) describes the old Arbitrum/USDC version. Pin the updated file and set its new path.`);
    if (cfg.mode === "live" && !isIpfsPath(v))
      throw new Error(`Set "kleros.${key}" to the IPFS path of the pinned file (e.g. /ipfs/Qm…${key === "metaEvidenceURI" ? "/metaevidence.json" : ""}) before the live deploy`);
  }
  return [cfg.depositUnits, cfg.eventName ?? "Truth Pays", owner, start, end, [k.disputeResolver, k.extraData, k.metaEvidenceURI, k.policyURI]];
}

// Contract enums
export const STATUS = { None: 0, Staker: 1, Paid: 2, Rejected: 3 };
export const PHASES = ["Open", "Listed", "Finalized", "Cancelled"];
export const CHALLENGE_STATE = { None: 0, Waiting: 1, Disputed: 2, Resolved: 3 };

export function provider(cfg) {
  const url = process.env.RPC_URL || cfg.rpcUrl;
  if (!url) throw new Error("Set rpcUrl in config.json or RPC_URL env var");
  return new ethers.JsonRpcProvider(url, cfg.chainId ? Number(cfg.chainId) : undefined, { staticNetwork: !!cfg.chainId });
}

// ---------------------------------------------------------------- CSV

export function readCsv(file) {
  return parse(fs.readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
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

export function writeCsv(file, rows, headers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cols = headers ?? (rows[0] ? Object.keys(rows[0]) : []);
  fs.writeFileSync(file, [cols.map(csvCell).join(","), ...rows.map((r) => cols.map((c) => csvCell(r[c])).join(","))].join("\n") + "\n");
}

export function writeJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, (_, v) => (typeof v === "bigint" ? v.toString() : v), 2) + "\n");
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
  if (receipt.status !== 1)
    return { ok: false, code: "TX_FAILED", note: toContract
      ? "The deposit contract refused this payment (0 ETH sent, or deposits were already closed), so no ETH arrived: the guest only paid the network fee. If they still want a spot, they send a new deposit."
      : "This transaction failed, so no ETH moved: the guest only paid the network fee. If they still want a spot, they send a new deposit." };

  const bySender = depositsInLogs(receipt.logs, cfg.receiver);
  if (!bySender.size)
    return { ok: false, code: "NO_DEPOSIT_TRANSFER", note: toContract || !receipt.to
      ? "No ETH deposit to the deposit contract in this tx"
      : `No ETH deposit to the deposit contract in this tx (it went to ${ethers.getAddress(receipt.to)}: wrong address?)` };

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

    const key = `${txHash}|${claimed ?? ""}|${otherNetworkOf(rawTx) ?? ""}`;
    if (!cache.has(key))
      cache.set(key, verifyTx(prov, cfg, txHash, claimed, rawTx).catch((e) => ({ ok: false, code: "RPC_ERROR", note: e.shortMessage || e.message })));
    const res = await cache.get(key);
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
      explorer: cfg.explorer ? `${cfg.explorer}/tx/${txHash}` : "",
      block: res.block ?? "",
      code: res.code,
      note: [res.note, res.inferred && res.code !== "VERIFIED" ? "wallet taken from the transaction sender" : ""].filter(Boolean).join("; "),
    });
  }
  return { results, columns: col };
}

// Rows whose own wallet really sent ETH to the contract in their tx (whether or not it counts as a deposit).
export const MONEY_CODES = new Set(["VERIFIED", "OUTSIDE_WINDOW", "AMOUNT_TOO_LOW"]);

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

/** How the organiser decided on a guest in Luma. */
export function lumaDecision(approval) {
  const a = String(approval ?? "").toLowerCase().trim();
  if (/declin|reject/.test(a)) return "declined";
  // exact words only: "pending_approval" must not count as approved
  if (/^(approved|going|accepted)$/.test(a)) return "approved";
  return "pending"; // pending_approval, waitlist, invited, empty…
}

export function loadAbi(name) {
  const p = new URL(`../build/${name}.json`, import.meta.url);
  if (!fs.existsSync(p)) throw new Error("Run `npm run compile` first");
  return JSON.parse(fs.readFileSync(p, "utf8"));
}
