// Shared helpers: config, CSV I/O, Luma column detection, deposit verification.
import fs from "node:fs";
import path from "node:path";
import { parse } from "csv-parse/sync";
import { ethers } from "ethers";

export const TRANSFER_TOPIC = ethers.id("Transfer(address,address,uint256)");

// Native USDC addresses (Circle). Pick the chain in config.json.
export const CHAINS = {
  arbitrum: { chainId: 42161, usdc: "0xaf88d065e77c8cC2239327C5EDb3A432268e5831", explorer: "https://arbiscan.io" },
  base: { chainId: 8453, usdc: "0x833589fCD6eDb6E08f4c7C32D09f71B4cE5DdA02", explorer: "https://basescan.org" },
  optimism: { chainId: 10, usdc: "0x0b2C639c533813f4Aa9D7837CAf62653d097Ff85", explorer: "https://optimistic.etherscan.io" },
  ethereum: { chainId: 1, usdc: "0xA0b86991c6218b36c1d19D4a2e9Eb0cE3606eB48", explorer: "https://etherscan.io" },
  // Test network: free test ETH and test USDC (faucet.circle.com), for rehearsals only.
  "arbitrum-sepolia": { chainId: 421614, usdc: "0x75faf114eafb1BDbe2F0316DF893fd58CE46AA4d", explorer: "https://sepolia.arbiscan.io" },
};

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

export function loadConfig(file = "config.json") {
  const cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  const opensAt = parseDate(cfg, "depositOpensAt");
  const deadline = parseDate(cfg, "depositDeadline");
  const eventStartTs = parseDate(cfg, "eventStart");
  const claimDeadlineTs = parseDate(cfg, "claimDeadline");
  if (cfg.contract && cfg.receiver && cfg.contract.toLowerCase() !== cfg.receiver.toLowerCase())
    throw new Error('"receiver" and "contract" in the config must be the same address (the deployed contract)');
  const chain = CHAINS[cfg.chain];
  if (!chain && !cfg.token) throw new Error(`Unknown chain "${cfg.chain}" and no token address set`);
  const decimals = cfg.tokenDecimals ?? 6;
  return {
    ...cfg,
    chainId: cfg.chainId ?? chain?.chainId,
    token: ethers.getAddress(cfg.token ?? chain.usdc),
    explorer: cfg.explorer ?? chain?.explorer ?? "",
    decimals,
    depositUnits: ethers.parseUnits(String(cfg.deposit), decimals),
    receiver: ethers.getAddress(cfg.contract || cfg.receiver),
    opensAt: opensAt ?? 0,
    deadline: deadline ?? Infinity,
    // contract timing: payout allowed from eventStart; after claimDeadline guests can withdraw themselves
    eventStartTs,
    claimDeadlineTs,
    deployBlock: cfg.deployBlock ? Number(cfg.deployBlock) : undefined,
    poolCapUnits: cfg.poolCap ? ethers.parseUnits(String(cfg.poolCap), decimals) : undefined,
    columns: cfg.columns ?? {},
  };
}

export const MIN_SETTLEMENT_WINDOW = 7 * 24 * 3600; // must match the contract
export const CHALLENGE_PERIOD = 24 * 3600; // must match the contract
export const MATCH_PERIOD = 24 * 3600; // must match the contract

// Kleros v2 on Arbitrum One. Disputes go through the DisputeResolver, a general-purpose arbitrable
// that Kleros Court accepts (the court only takes disputes from whitelisted contracts).
// Source: @kleros/kleros-v2-contracts deployments (arbitrum).
export const KLEROS = {
  42161: { disputeResolver: "0xb5526D022962A1fFf6eD32C93e8b714c901F4323", klerosCore: "0x991d2df165670b9cac3B022f4B68D65b664222ea", court: "https://v2.kleros.builders" },
  421614: { disputeResolver: "0xed31bEE8b1F7cE89E93033C0d3B2ccF4cEb27652", klerosCore: "0xE8442307d36e9bf6aB27F1A009F95CE8E11C3479", court: "https://v2-testnet.kleros.builders" },
};

/** Kleros settings from config.kleros, with Arbitrum defaults: General Court (1), 3 jurors, classic dispute kit (1). */
export function klerosConfig(cfg) {
  const k = cfg.kleros ?? {};
  const known = KLEROS[Number(cfg.chainId)] ?? {};
  const disputeResolver = k.disputeResolver ?? known.disputeResolver;
  if (!disputeResolver) throw new Error('Set "kleros.disputeResolver" in the config for this network');
  const court = k.court ?? 1, jurors = k.jurors ?? 3, disputeKit = k.disputeKit ?? 1;
  return {
    disputeResolver: ethers.getAddress(disputeResolver),
    court, jurors, disputeKit,
    extraData: ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256", "uint256"], [court, jurors, disputeKit]),
    policyURI: k.policyURI ?? "",
    courtUrl: k.courtUrl ?? known.court ?? "https://v2.kleros.builders",
  };
}

/** Constructor arguments for GroundTruthKickback, checked before anything is sent. */
export function deployArgs(cfg, owner) {
  const { eventStartTs: start, claimDeadlineTs: end } = cfg;
  if (!start || !end)
    throw new Error('Set "eventStart" and "claimDeadline" in the config (ISO dates with timezone)');
  if (end < start + MIN_SETTLEMENT_WINDOW) throw new Error("claimDeadline must be at least 7 days after eventStart");
  const k = klerosConfig(cfg);
  if (cfg.mode === "live" && !/^\/ipfs\/\S+/.test(k.policyURI))
    throw new Error('Set "kleros.policyURI" to the IPFS path of docs/attendance-policy.md (e.g. /ipfs/Qm…) before the live deploy');
  return [cfg.token, cfg.depositUnits, cfg.eventName ?? "Ground Truth", owner, start, end, [k.disputeResolver, k.extraData, k.policyURI]];
}

// Contract Status enum
export const STATUS = { None: 0, Staker: 1, Paid: 2, Rejected: 3 };
export const PHASES = ["Open", "Listed", "Finalized", "Cancelled"];

export function provider(cfg) {
  const url = process.env.RPC_URL || cfg.rpcUrl;
  if (!url) throw new Error("Set rpcUrl in config.json or RPC_URL env var");
  return new ethers.JsonRpcProvider(url, cfg.chainId ? Number(cfg.chainId) : undefined, { staticNetwork: !!cfg.chainId });
}

// ---------------------------------------------------------------- CSV

export function readCsv(file) {
  return parse(fs.readFileSync(file, "utf8"), { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true });
}

export function writeCsv(file, rows, headers) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cols = headers ?? (rows[0] ? Object.keys(rows[0]) : []);
  const esc = (v) => {
    const s = v === undefined || v === null ? "" : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  fs.writeFileSync(file, [cols.join(","), ...rows.map((r) => cols.map((c) => esc(r[c])).join(","))].join("\n") + "\n");
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

export const fmt = (units, decimals = 6) => ethers.formatUnits(units, decimals);

// ---------------------------------------------------------------- verification

/**
 * Verify one deposit transaction.
 * Valid when: tx succeeded, it contains a `token` Transfer to `receiver`,
 * sent from the guest's wallet, totalling >= deposit, inside the deposit window.
 */
export async function verifyTx(prov, cfg, txHash, claimedWallet) {
  const receipt = await prov.getTransactionReceipt(txHash);
  if (!receipt) return { ok: false, code: "TX_NOT_FOUND", note: "Not found on this chain (wrong network?)" };
  if (receipt.status !== 1) return { ok: false, code: "TX_FAILED", note: "Transaction reverted" };

  const transfers = receipt.logs
    .filter(
      (l) =>
        ethers.getAddress(l.address) === cfg.token &&
        l.topics[0] === TRANSFER_TOPIC &&
        l.topics.length === 3 &&
        ethers.getAddress(ethers.dataSlice(l.topics[2], 12)) === cfg.receiver
    )
    .map((l) => ({
      from: ethers.getAddress(ethers.dataSlice(l.topics[1], 12)),
      value: BigInt(l.data),
    }));

  if (!transfers.length)
    return { ok: false, code: "NO_DEPOSIT_TRANSFER", note: "No USDC transfer to the deposit address in this tx" };

  const senders = [...new Set(transfers.map((t) => t.from))];
  let wallet = claimedWallet;
  let inferred = false;
  if (!wallet) {
    if (senders.length !== 1) return { ok: false, code: "AMBIGUOUS_SENDER", note: "No wallet given and tx has several senders" };
    wallet = senders[0];
    inferred = true;
  }
  const amount = transfers.filter((t) => t.from === wallet).reduce((a, t) => a + t.value, 0n);
  if (amount === 0n)
    return { ok: false, code: "WRONG_SENDER", note: `Deposit came from ${senders.join(" / ")}, not ${wallet}`, sender: senders[0] };

  const block = await prov.getBlock(receipt.blockNumber);
  const ts = Number(block.timestamp);
  if (ts < cfg.opensAt || ts > cfg.deadline)
    return { ok: false, code: "OUTSIDE_WINDOW", note: `Sent at ${new Date(ts * 1000).toISOString()}`, wallet, amount, ts };

  if (amount < cfg.depositUnits)
    return { ok: false, code: "AMOUNT_TOO_LOW", note: `Sent ${fmt(amount, cfg.decimals)}, need ${cfg.deposit}`, wallet, amount, ts };

  const notes = [];
  if (inferred) notes.push("wallet taken from tx sender");
  if (amount > cfg.depositUnits) notes.push(`overpaid by ${fmt(amount - cfg.depositUnits, cfg.decimals)} (refund the excess)`);
  return { ok: true, code: "VERIFIED", wallet, amount, ts, block: receipt.blockNumber, note: notes.join("; ") };
}

/** Verify every deposit registration in a Luma export. Pure: no files written. */
export async function verifyRegistrations(prov, cfg, rows, { onlyDepositTicket = true } = {}) {
  const headers = rows.length ? Object.keys(rows[0]) : [];
  const col = detectColumns(headers, cfg.columns);
  if (!col.tx) throw new Error(`Couldn't find the tx-link column. Headers: ${headers.join(" | ")}. Set config.columns.tx`);

  const ticketRe = new RegExp(cfg.depositTicketPattern ?? "deposit|commit|stake", "i");
  const usedTx = new Map();
  const usedWallet = new Map();
  const verified = [];
  const issues = [];

  for (const r of rows) {
    const who = { name: r[col.name] ?? "", email: (r[col.email] ?? "").toLowerCase().trim() };
    const isDepositTicket = col.ticket ? ticketRe.test(r[col.ticket] ?? "") : true;
    const rawTx = (r[col.tx] ?? "").trim();
    if (onlyDepositTicket && col.ticket && !isDepositTicket && !rawTx) continue; // free "Request to Join" guest

    const txHash = extractTxHash(rawTx);
    const claimed = col.wallet ? normAddress(r[col.wallet]) : null;
    const approval = (col.approval ? r[col.approval] ?? "" : "").toLowerCase().trim();
    const base = { ...who, ticket: r[col.ticket] ?? "", approval, wallet: claimed ?? "", tx: txHash ?? rawTx };

    if (!rawTx) { issues.push({ ...base, code: "NO_TX", note: "Deposit ticket but no tx link" }); continue; }
    if (!txHash) { issues.push({ ...base, code: "BAD_TX_HASH", note: "Couldn't find a 0x… tx hash in the answer" }); continue; }
    if (usedTx.has(txHash)) {
      issues.push({ ...base, code: "DUPLICATE_TX", note: `Same tx already used by ${usedTx.get(txHash)}` });
      continue;
    }

    let res;
    try {
      res = await verifyTx(prov, cfg, txHash, claimed);
    } catch (e) {
      res = { ok: false, code: "RPC_ERROR", note: e.shortMessage || e.message };
    }
    const row = {
      ...base,
      wallet: res.wallet ?? claimed ?? "",
      amount: res.amount !== undefined ? fmt(res.amount, cfg.decimals) : "",
      sent_at: res.ts ? new Date(res.ts * 1000).toISOString() : "",
      explorer: cfg.explorer ? `${cfg.explorer}/tx/${txHash}` : "",
      block: res.block ?? "",
      code: res.code,
      note: res.note ?? "",
    };
    if (!res.ok) { issues.push(row); continue; }

    usedTx.set(txHash, who.email || who.name);
    if (usedWallet.has(row.wallet)) {
      issues.push({ ...row, code: "DUPLICATE_WALLET", note: `Wallet already staked for ${usedWallet.get(row.wallet)}` });
      continue;
    }
    usedWallet.set(row.wallet, who.email || who.name);
    verified.push(row);
  }
  return { verified, issues, columns: col };
}

/** Every token transfer into the receiver within a block range (for cross-checking). */
export async function incomingTransfers(prov, cfg, fromBlock, toBlock = "latest", step = 50_000) {
  const latest = toBlock === "latest" ? await prov.getBlockNumber() : Number(toBlock);
  const out = [];
  for (let start = Number(fromBlock); start <= latest; start += step) {
    const end = Math.min(start + step - 1, latest);
    const logs = await prov.getLogs({
      address: cfg.token,
      topics: [TRANSFER_TOPIC, null, ethers.zeroPadValue(cfg.receiver, 32)],
      fromBlock: start,
      toBlock: end,
    });
    for (const l of logs)
      out.push({
        tx: l.transactionHash.toLowerCase(),
        from: ethers.getAddress(ethers.dataSlice(l.topics[1], 12)),
        amount: BigInt(l.data),
        block: l.blockNumber,
      });
  }
  return out;
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
