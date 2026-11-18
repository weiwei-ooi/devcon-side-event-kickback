// Shared code for the Proof of Presence pages: network settings, reading the chain, the wallet, Kleros IPFS.
// window.POP_CONFIG comes from config.js, written by scripts/build-web.mjs from deployments/<network>.json.
import { ethers } from "ethers";
import * as P from "./protocol.mjs";

export { ethers, P };
export const CFG = window.POP_CONFIG ?? {};
export const NET = { ...(P.NETWORKS[CFG.chainId] ?? {}), ...CFG };
export const KLEROS_UPLOAD = CFG.ipfsUpload ?? P.KLEROS_IPFS_UPLOAD;
export const IPFS_GATEWAY = CFG.ipfsGateway ?? P.KLEROS_IPFS_GATEWAY;

const abiCache = {};
export async function abi(name) {
  if (!abiCache[name]) abiCache[name] = fetch(`abi/${name}.json`).then((r) => r.json());
  return (await abiCache[name]).abi;
}
export async function artifact(name) {
  return fetch(`abi/${name}.json`).then((r) => r.json());
}

// ---------------------------------------------------------------- reading the chain
let _read;
/** A read-only provider over the configured RPCs (the first that answers). */
export function reader() {
  if (_read) return _read;
  const urls = NET.rpcs ?? [];
  const net = ethers.Network.from(Number(NET.chainId));
  const ps = urls.map((u) => new ethers.JsonRpcProvider(u, net, { staticNetwork: net, batchMaxCount: 1 }));
  _read = ps.length === 1 ? ps[0] : new ethers.FallbackProvider(ps.map((provider, i) => ({ provider, priority: i + 1, stallTimeout: 2500, weight: 1 })), net, { quorum: 1 });
  return _read;
}

export const deployed = () => ethers.isAddress(CFG.factory ?? "");
export async function factory(runner = reader()) {
  return new ethers.Contract(CFG.factory, await abi("PresenceFactory"), runner);
}
export async function eventContract(address, runner = reader()) {
  return new ethers.Contract(address, await abi("PresenceEvent"), runner);
}

/** Everything a page shows about an event, in one object (refuses addresses that are not this factory's events). */
export async function loadEvent(address) {
  if (!ethers.isAddress(address)) throw new Error("That is not an event address.");
  const f = await factory();
  if (!(await f.isEvent(address))) throw new Error("This address is not an event created with Proof of Presence on " + (NET.name ?? "this network") + ".");
  const ev = await eventContract(address);
  await syncClock();
  const [s, name, url, token, symbol, decimals, deposit, start, end, deadline, capacity, owner, challengeDeposit, challengePeriod, matchPeriod] = await Promise.all([
    ev.summary(), ev.eventName(), ev.eventURL(), ev.token(), ev.tokenSymbol(), ev.tokenDecimals(), ev.depositAmount(), ev.eventStart(), ev.eventEnd(),
    ev.claimDeadline(), ev.capacity(), ev.owner(), ev.challengeDeposit().catch(() => null), ev.challengePeriod(), ev.matchPeriod(),
  ]);
  return {
    address: ethers.getAddress(address), contract: ev, name, url, token, symbol, decimals: Number(decimals), deposit, isEth: token === ethers.ZeroAddress,
    start: Number(start), end: Number(end), deadline: Number(deadline), capacity: Number(capacity), owner,
    phase: P.PHASES[Number(s.phase_)], stakerCount: Number(s.stakerCount_), attendeeCount: Number(s.attendeeCount_), challengeEndsAt: Number(s.challengeEndsAt_),
    waiting: Number(s.waitingChallenges_), openCases: Number(s.openCases_), payoutShare: s.payoutShare_, reservedPool: s.reservedPool_, escrow: s.challengeEscrow_,
    challengeDeposit, challengePeriod: Number(challengePeriod), matchPeriod: Number(matchPeriod),
  };
}

/** Every wallet that deposited, with its status, attendance, challenge and what it can withdraw. */
export async function loadStakers(e) {
  const ev = e.contract;
  const list = [...(await ev.stakers())];
  return Promise.all(
    list.map(async (w) => {
      const [st, att, c, cl] = await Promise.all([ev.status(w), ev.attended(w), ev.challenges(w), ev.claimable(w)]);
      return {
        wallet: w, status: P.STATUS[Number(st)], attended: att, claim: cl[0], claimEth: cl[1],
        challenge: { state: P.CHALLENGE_STATES[Number(c.state)], matchEndsAt: Number(c.matchEndsAt), matcher: c.matcher, organiser: c.organiser, deposit: c.deposit, caseId: c.arbitratorDisputeID, localId: c.localDisputeID },
      };
    }),
  );
}

// ---------------------------------------------------------------- the wallet
let _wallet;
/** Connects the browser wallet and puts it on this page's network. */
export async function connect() {
  const eth = window.ethereum;
  if (!eth) throw new Error("No wallet found in this browser. Open this page in a browser with a wallet (MetaMask, Rabby, Zerion, Coinbase Wallet…) or in your wallet app's browser.");
  await eth.request({ method: "eth_requestAccounts" });
  const want = "0x" + Number(NET.chainId).toString(16);
  if ((await eth.request({ method: "eth_chainId" })) !== want) {
    try {
      await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: want }] });
    } catch (e) {
      if (e?.code === 4902 && NET.rpcs?.length) {
        await eth.request({ method: "wallet_addEthereumChain", params: [{ chainId: want, chainName: NET.name, rpcUrls: NET.rpcs, nativeCurrency: { name: NET.currency ?? "ETH", symbol: NET.currency ?? "ETH", decimals: 18 }, blockExplorerUrls: NET.explorer ? [NET.explorer] : [] }] });
      } else throw new Error(`Please switch your wallet to ${NET.name ?? "the right network"} and try again.`);
    }
  }
  const provider = new ethers.BrowserProvider(eth, "any");
  const signer = await provider.getSigner();
  _wallet = { provider, signer, address: await signer.getAddress() };
  eth.on?.("accountsChanged", () => location.reload());
  eth.on?.("chainChanged", () => location.reload());
  return _wallet;
}
export const wallet = () => _wallet;

/** Sends a transaction and waits for it; `onSent(hash)` once the wallet has signed. Plain messages on failure. */
export async function sendTx(promiseOfTx, onSent = () => {}) {
  let tx;
  try {
    tx = await promiseOfTx;
  } catch (e) {
    throw new Error(plainError(e));
  }
  onSent(tx.hash);
  const r = await tx.wait();
  if (r.status !== 1) throw new Error("The transaction failed on-chain. Nothing changed except the gas fee.");
  return r;
}

let _iface;
export async function errorInterface() {
  if (!_iface) _iface = new ethers.Interface([...(await abi("PresenceEvent")), ...(await abi("PresenceFactory"))]);
  return _iface;
}
const ERRORS = {
  WrongAmount: "The amount is not exactly the deposit.",
  AlreadyStaker: "This wallet already has a deposit for this event.",
  WasRejected: "The organiser turned this wallet away; it cannot deposit again.",
  EventFull: "The event is full.",
  TooLate: "Too late: this window has closed.",
  TooEarly: "Too early: this is not possible yet.",
  NotOpen: "The event is no longer taking deposits or changes.",
  NotOwner: "Only the event's organiser wallet can do this.",
  NotAStaker: "This wallet has no deposit in this event.",
  AlreadyAttending: "This wallet is already on the attendance list.",
  ChallengesPending: "A challenge is still waiting for a match.",
  NothingToWithdraw: "There is nothing to withdraw for this wallet.",
  BadConfig: "Some event settings are not valid.",
  TransferFailed: "The token transfer failed (check your balance and approval).",
};
export function plainError(e) {
  if (e?.code === "ACTION_REJECTED" || e?.info?.error?.code === 4001) return "You cancelled the transaction in your wallet.";
  const name = e?.revert?.name ?? (() => { try { return _iface?.parseError(e?.data ?? e?.info?.error?.data)?.name; } catch { return null; } })();
  if (name && ERRORS[name]) return ERRORS[name];
  if (/insufficient funds/i.test(e?.message ?? "")) return "Not enough ETH in this wallet for the amount and the network fee.";
  return e?.shortMessage ?? e?.message ?? String(e);
}

// ---------------------------------------------------------------- Kleros IPFS
/** Uploads a file through Kleros's IPFS service; returns "/ipfs/<cid>". */
export async function uploadToKleros(text, filename, operation = "file") {
  const fd = new FormData();
  fd.append("data", new Blob([text], { type: "application/json" }), filename);
  let r;
  try {
    r = await fetch(`${KLEROS_UPLOAD}?operation=${operation}&pinToGraph=false`, { method: "POST", body: fd });
  } catch {
    throw new Error("Could not reach Kleros's IPFS upload service. Try again in a minute.");
  }
  if (!r.ok) throw new Error(`Kleros's IPFS upload service answered with error ${r.status}. Try again in a minute.`);
  const j = await r.json();
  const p = (j.cids?.[0] ?? j.data?.cids?.[0] ?? "").replace(/^ipfs:\/\//, "/ipfs/");
  if (!p.startsWith("/ipfs/")) throw new Error("Kleros's IPFS upload service gave no IPFS address.");
  return p;
}

/** Makes sure the case description of `staker` is on IPFS at the path the contract computes. */
export async function publishCase(e, staker) {
  const [text, uri] = await e.contract.caseMetaEvidence(staker);
  if (P.ipfsPathOf(text) !== uri) throw new Error("The case description does not match its IPFS address. Nothing was sent.");
  const p = await uploadToKleros(text, "metaevidence.json", "file");
  if (p !== uri) {
    const ok = await fetch(IPFS_GATEWAY + uri).then((r) => r.ok).catch(() => false);
    if (!ok) throw new Error(`The case description was saved at ${p}, not at ${uri}. Try again.`);
  }
  return uri;
}

// ---------------------------------------------------------------- formatting
export const short = (a) => (a ? a.slice(0, 6) + "…" + a.slice(-4) : "");
export const amount = (e, units) => `${P.decimalText(units, e.decimals)} ${e.symbol}`;
export const eth = (units) => `${P.decimalText(units, 18)} ${NET.currency ?? "ETH"}`;
export const txUrl = (h) => (NET.explorer ? `${NET.explorer}/tx/${h}` : h);
export const addrUrl = (a) => (NET.explorer ? `${NET.explorer}/address/${a}` : a);
export const caseUrl = (id) => (NET.kleros?.court ? NET.kleros.court + id : "#");
export const pageUrl = (page, ev) => new URL(`${page}?e=${ev}`, location.href).href;

/** "Wed 4 Nov 2026, 18:00" in the visitor's timezone, with the zone name. */
export function when(ts) {
  const d = new Date(ts * 1000);
  return d.toLocaleString(undefined, { weekday: "short", day: "numeric", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit", timeZoneName: "short" });
}
export function duration(s) {
  s = Math.max(0, Math.round(s));
  const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
  return d ? `${d} d ${h} h` : h ? `${h} h ${m} min` : `${m} min`;
}
// The chain's clock, when it runs ahead of this computer's (a test chain, or a computer whose clock is late).
let clockOffset = 0;
export async function syncClock() {
  const b = await reader().getBlock("latest").catch(() => null);
  if (b) clockOffset = Math.max(0, b.timestamp - Date.now() / 1000);
}
export const nowS = () => Math.floor(Date.now() / 1000 + clockOffset);

export function esc(s) {
  return String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
}
export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

/** Shows a message in an element: kind = "ok" | "err" | "busy" | "". */
export function say(el, text, kind = "") {
  if (typeof el === "string") el = $(el);
  if (!el) return;
  el.className = "note " + kind;
  el.innerHTML = text;
  el.hidden = !text;
}

/** Runs a button's action with a busy state and an error message under it. */
export function action(btn, out, fn) {
  btn.addEventListener("click", async () => {
    if (btn.disabled) return;
    btn.disabled = true;
    const label = btn.textContent;
    btn.textContent = "Working…";
    try {
      await fn();
    } catch (e) {
      say(out, esc(plainError(e)), "err");
    } finally {
      btn.disabled = false;
      if (btn.textContent === "Working…") btn.textContent = label; // keep a label the action set (e.g. the wallet address)
    }
  });
}

export function notDeployedNote() {
  return `Proof of Presence is not deployed on ${esc(NET.name ?? "this network")} yet. A developer deploys it once with the <a href="deploy.html">deploy page</a>, then adds the addresses to <code>deployments/</code>.`;
}
