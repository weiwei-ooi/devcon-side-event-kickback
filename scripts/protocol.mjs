// Shared, browser-safe helpers for Proof of Presence: networks, the case description template, IPFS paths.
// Used by the deploy script, the tests and the web pages (which load it as a module next to ethers).
import { ethers } from "ethers";

/** Networks with Kleros Court v1 and its general-purpose Dispute Resolver. Add yours in a fork. */
export const NETWORKS = {
  1: {
    key: "ethereum",
    name: "Ethereum mainnet",
    explorer: "https://etherscan.io",
    currency: "ETH",
    // read-only public RPCs, first one also serves old logs in small ranges
    rpcs: ["https://rpc.mevblocker.io", "https://ethereum-rpc.publicnode.com", "https://eth.drpc.org", "https://1rpc.io/eth"],
    logChunk: 5000,
    kleros: {
      disputeResolver: "0x4b89e798b10478a839ea0abcf86c4b94a3c782a4",
      arbitrator: "0x988b3A538b618C7A603e1c11Ab82Cd16dbE28069",
      subcourt: 0, // General Court
      jurors: 3,
      court: "https://court.kleros.io/cases/",
      resolverApp: "https://resolve.kleros.io/cases/",
    },
  },
};

export const KLEROS_IPFS_UPLOAD = "https://kleros-api.netlify.app/.netlify/functions/upload-to-ipfs";
export const KLEROS_IPFS_GATEWAY = "https://cdn.kleros.link";
export const DEFAULT_PERIODS = { challenge: 86400, match: 86400 };

/** Values the case description template names, as the contract's PresenceCaseWriter.SLOT_* numbers. */
export const SLOT = {
  wallet: 1,
  walletLower: 2,
  contract: 3,
  organiser: 4,
  organiserLower: 5,
  eventName: 6,
  eventURL: 7,
  eventStart: 8,
  eventEnd: 9,
  deposit: 10,
  chainId: 11,
};
/** Placeholders filled once, when the protocol is deployed. */
export const DEPLOY_PLACEHOLDERS = ["policyURI", "network", "explorer"];

export const PHASES = ["Open", "Listed", "Finalized", "Cancelled"];
export const STATUS = ["None", "Staker", "Rejected", "Refunded"];
export const CHALLENGE_STATES = ["None", "Waiting", "Disputed", "Resolved"];
export const MIN_SETTLEMENT_WINDOW = 7 * 86400; // must match PresenceEvent.MIN_SETTLEMENT_WINDOW
export const MAX_SETTLEMENT_WINDOW = 90 * 86400; // must match PresenceEvent.MAX_SETTLEMENT_WINDOW
export const MAX_LEAD_TIME = 2 * 365 * 86400; // must match PresenceEvent.MAX_LEAD_TIME
export const MAX_NAME = 200;
export const MAX_URL = 300;

export const extraDataOf = (subcourt, jurors) => ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [subcourt, jurors]);

/** Splits a template text into the contract's pieces and slots, filling the deploy-time placeholders (JSON-escaped). */
export function caseTemplate(text, values = {}) {
  const pieces = [];
  const slots = [];
  let piece = "";
  let last = 0;
  const raw = String(text);
  for (const m of raw.matchAll(/\{\{(\w+)\}\}/g)) {
    piece += raw.slice(last, m.index);
    last = m.index + m[0].length;
    const key = m[1];
    if (key in SLOT) {
      pieces.push(piece);
      piece = "";
      slots.push(SLOT[key]);
    } else if (DEPLOY_PLACEHOLDERS.includes(key)) {
      if (!String(values[key] ?? "").trim()) throw new Error(`The template needs a value for {{${key}}}`);
      piece += JSON.stringify(String(values[key])).slice(1, -1);
    } else throw new Error(`Unknown placeholder {{${key}}} in the template`);
  }
  pieces.push(piece + raw.slice(last));
  if (!slots.includes(SLOT.wallet)) throw new Error("The template must name the challenged wallet ({{wallet}})");
  const t = { pieces, slots: ethers.hexlify(new Uint8Array(slots)) };
  // the filled template must be valid ERC-1497 JSON whatever the event's (JSON-safe) values are
  const sample = renderCase(t, sampleFacts());
  const meta = JSON.parse(sample);
  for (const k of ["title", "description", "question", "fileURI"]) if (typeof meta[k] !== "string" || !meta[k]) throw new Error(`The template has no "${k}"`);
  if (meta.fileURI !== values.policyURI) throw new Error('The template\'s "fileURI" must be {{policyURI}}');
  if (meta.rulingOptions?.titles?.length !== 2) throw new Error("The template must list the 2 answers (1 attended, 2 did not attend)");
  return t;
}

export function sampleFacts() {
  return {
    staker: "0x5aaeb6053f3e94c9b9a09f33669435e7ef1beaed",
    eventContract: "0xfb6916095ca1df60bb79ce92ce3ea74c37c5d359",
    organiser: "0xdbf03b407c01e7cd3cbea99509d93f8dddc8c6fb",
    name: "Sample event",
    url: "https://example.org/event",
    start: 1793800000,
    end: 1793814400,
    depositAmount: 10n ** 16n,
    decimals: 18,
    symbol: "ETH",
    token: ethers.ZeroAddress,
    chainId: 1,
  };
}

/** UTC text the contract writes: "2026-11-04 12:30 UTC". */
export function utcText(ts) {
  const d = new Date(Number(ts) * 1000);
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ${p(d.getUTCHours())}:${p(d.getUTCMinutes())} UTC`;
}

/** The amount as the contract writes it: "0.01", "25". */
export function decimalText(amount, decimals) {
  const s = ethers.formatUnits(BigInt(amount), Number(decimals));
  return s.endsWith(".0") ? s.slice(0, -2) : s;
}

/** The case description the contract's caseMetaEvidence returns, computed here (for tests and previews). */
export function renderCase({ pieces, slots }, f) {
  const lower = (a) => ethers.getAddress(a).toLowerCase();
  const isEth = !f.token || f.token === ethers.ZeroAddress;
  const value = (s) => {
    switch (s) {
      case SLOT.wallet: return ethers.getAddress(f.staker);
      case SLOT.walletLower: return lower(f.staker);
      case SLOT.contract: return ethers.getAddress(f.eventContract);
      case SLOT.organiser: return ethers.getAddress(f.organiser);
      case SLOT.organiserLower: return lower(f.organiser);
      case SLOT.eventName: return f.name;
      case SLOT.eventURL: return f.url || "(none given)";
      case SLOT.eventStart: return utcText(f.start);
      case SLOT.eventEnd: return utcText(f.end);
      case SLOT.deposit: return `${decimalText(f.depositAmount, f.decimals)} ${f.symbol}` + (isEth ? "" : ` (token ${ethers.getAddress(f.token)})`);
      case SLOT.chainId: return String(f.chainId);
      default: throw new Error(`Unknown slot ${s}`);
    }
  };
  let out = pieces[0];
  ethers.getBytes(slots).forEach((s, i) => (out += value(s) + pieces[i + 1]));
  return out;
}

/** The CIDv0 ("Qm...") `ipfs add` gives these bytes with default settings (one block, up to 256 KiB). */
export function ipfsCidV0(data) {
  const bytes = typeof data === "string" ? ethers.toUtf8Bytes(data) : ethers.getBytes(data);
  if (bytes.length > 262144) throw new Error("More than one IPFS block (256 KiB)");
  const varint = (n) => {
    const o = [];
    while (n >= 0x80) {
      o.push((n & 0x7f) | 0x80);
      n >>>= 7;
    }
    o.push(n);
    return o;
  };
  const size = varint(bytes.length);
  const file = ethers.getBytes(ethers.concat([new Uint8Array([0x08, 0x02, 0x12, ...size]), bytes, new Uint8Array([0x18, ...size])]));
  const node = ethers.concat([new Uint8Array([0x0a, ...varint(file.length)]), file]);
  return ethers.encodeBase58(ethers.concat(["0x1220", ethers.sha256(node)]));
}
export const ipfsPathOf = (text) => "/ipfs/" + ipfsCidV0(text);

/** The contract's rule for the event name and page: no quote, backslash or control character. */
export const jsonSafe = (s) => !/["\\\u0000-\u001f\u007f]/.test(String(s));

/** Checks an organiser's form before sending createEvent; returns the Config tuple. */
export function eventConfig({ name, url = "", token = ethers.ZeroAddress, depositAmount, eventStart, eventEnd, claimDeadline, capacity = 0 }, now = Math.floor(Date.now() / 1000)) {
  const n = String(name ?? "").trim();
  const u = String(url ?? "").trim();
  if (!n) throw new Error("Give the event a name.");
  if (new TextEncoder().encode(n).length > MAX_NAME) throw new Error(`The name is too long (${MAX_NAME} bytes at most).`);
  if (!jsonSafe(n)) throw new Error('The name cannot contain quotes ("), backslashes or line breaks.');
  if (new TextEncoder().encode(u).length > MAX_URL) throw new Error("The event link is too long.");
  if (u && !/^https:\/\/\S+$/.test(u)) throw new Error("The event link must start with https://");
  if (!jsonSafe(u)) throw new Error("The event link cannot contain quotes or backslashes.");
  const amount = BigInt(depositAmount);
  if (amount <= 0n) throw new Error("The deposit must be more than 0.");
  const [s, e, d] = [eventStart, eventEnd, claimDeadline].map(Number);
  if (!(s > 0) || !(e >= s)) throw new Error("The event must end after it starts.");
  if (!(e > now)) throw new Error("The event's end time is already past.");
  if (!(d >= e + MIN_SETTLEMENT_WINDOW)) throw new Error("The deadline to post the list must be at least 7 days after the event ends.");
  if (!(d <= e + MAX_SETTLEMENT_WINDOW)) throw new Error("The deadline to post the list must be at most 90 days after the event ends.");
  if (!(e <= now + MAX_LEAD_TIME)) throw new Error("The event must end within 2 years.");
  const cap = Number(capacity) || 0;
  if (cap < 0 || cap > 2 ** 32 - 1) throw new Error("Capacity must be 0 (no limit) or a positive number.");
  return { name: n, url: u, token: token || ethers.ZeroAddress, depositAmount: amount, eventStart: s, eventEnd: e, claimDeadline: d, capacity: cap };
}

/**
 * Deploys a full Proof of Presence protocol: the case writer (template), the event implementation (Kleros settings),
 * then the factory. `artifacts` = { PresenceCaseWriter, PresenceEvent, PresenceFactory } each { abi, bytecode }.
 * `onStep(label, tx)` is called after each transaction is sent. Returns the three addresses.
 */
export async function deployProtocol(signer, artifacts, { disputeResolver, extraData, policyURI, templateText, network, explorer, challengePeriod = DEFAULT_PERIODS.challenge, matchPeriod = DEFAULT_PERIODS.match, overrides = {} }, onStep = () => {}) {
  const t = caseTemplate(templateText, { policyURI, network, explorer });
  const make = async (name, args) => {
    const f = new ethers.ContractFactory(artifacts[name].abi, artifacts[name].bytecode, signer);
    const c = await f.deploy(...args, overrides);
    onStep(name, c.deploymentTransaction());
    await c.waitForDeployment();
    return c;
  };
  const writer = await make("PresenceCaseWriter", [t.pieces, t.slots]);
  const impl = await make("PresenceEvent", [disputeResolver, extraData, policyURI, writer.target, challengePeriod, matchPeriod]);
  const factory = await make("PresenceFactory", [impl.target]);
  return { caseWriter: writer.target, implementation: impl.target, factory: factory.target, template: t };
}
