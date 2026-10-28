// The shared core (scripts/core.mjs), which the scripts, the owner console and the admin panel use:
// it stays browser-safe; lib.mjs keeps every export; the live contract's constructor arguments and
// case description are unchanged; parseCsv reads text exactly like readCsv (csv-parse); the generic
// juror policy and case description template (for any organiser's event) keep the live rules, name
// the wallet and fit the contract; the event's own clock is read back from a case description
// (eventClock, on the table of test/event-clock-cases.mjs); and on a local chain (ganache), checkGuests and buildPayout give
// exactly the lists verify-deposits.mjs and build-payout.mjs write, for a contract deployed from the
// new-event form with the generic template.
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync, execFile } from "node:child_process";
import { promisify } from "node:util";
import ganache from "ganache";
import { ethers } from "ethers";
import { parse } from "csv-parse/sync";
import * as core from "../scripts/core.mjs";
import * as lib from "../scripts/lib.mjs";
import { CLOCK_CASES } from "./event-clock-cases.mjs";

const execFileP = promisify(execFile);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const read = (f) => fs.readFileSync(path.join(root, f), "utf8");
const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"));
const E = (x) => ethers.parseEther(String(x));
const DAY = 86400;
const GENERIC_TEXT = read(core.GENERIC_METAEVIDENCE_TEMPLATE);
const GENERIC_POLICY_TEXT = read(core.GENERIC_POLICY);
const GENERIC_POLICY_PATH = core.ipfsPathOf(GENERIC_POLICY_TEXT);
// a new event as the admin panel's form would give it
const FORM = {
  eventTitle: "Onchain Justice Night: Talks & \"Dinner\"",
  eventName: "Onchain Justice Night, Berlin 2027",
  eventWhen: "Friday 12 March 2027, 19:00-23:00 CET",
  eventWhere: "Café Example, Main Street 1, Berlin",
  hosts: "Kleros and friends",
  eventLink: "https://luma.com/your-event",
  deposit: "0.01",
  eventStart: "2027-03-12T19:00:00+01:00",
};
const ORGANISER = "0x259a1084C2043a7B3b5b288596E05C41b8EFa5d6";
const MAINNET = { chainId: 1, explorer: "https://etherscan.io", rpcUrl: "https://rpc.mevblocker.io", logChunk: 5000, kleros: { policyURI: GENERIC_POLICY_PATH } };
// EIP-55 test vectors: mixed case once checksummed
const W = "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", C = "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359";
const json = (v) => JSON.stringify(v, (_, x) => (typeof x === "bigint" ? x.toString() : x));

// ---------------------------------------------------------------- the module itself

test("core.mjs is browser-safe: it imports only ethers and uses no Node API", () => {
  const src = read("scripts/core.mjs");
  const imports = [...src.matchAll(/^\s*import\s[^;]*?from\s+"([^"]+)"/gm)].map((m) => m[1]);
  assert.deepEqual(imports, ["ethers"]);
  const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:"'`\\])\/\/.*$/gm, "$1");
  for (const re of [/\bprocess\./, /\bBuffer\b/, /\brequire\(/, /\bimport\.meta\b/, /node:/, /__dirname|__filename/, /\bimport\(/])
    assert.doesNotMatch(code, re, `core.mjs uses ${re}`);
});

test("lib.mjs still exports everything it did, and the core's own functions are the same objects", () => {
  const before = ("DEPOSITED_EVENT DEPOSITED_TOPIC TOKEN_TRANSFER_TOPIC CHAINS SYMBOL DECIMALS DEFAULT_RPC DEFAULT_LOG_CHUNK MAX_DEPOSIT_ETH args loadConfig " +
    "MIN_SETTLEMENT_WINDOW CHALLENGE_PERIOD MATCH_PERIOD PAYOUT_GAS TX_GAS_CAP gasLimitFor KLEROS KLEROS_IPFS_UPLOAD KLEROS_IPFS_GATEWAY RULINGS " +
    "KLEROS_PERIODS IPFS_PATH_RE isIpfsPath STALE_PINS SLOT MAX_METAEVIDENCE_BYTES MAX_TEMPLATE_BYTES DEFAULT_METAEVIDENCE_TEMPLATE ipfsCidV0 " +
    "ipfsPathOf renderCase caseTemplate klerosConfig deployArgs STATUS PHASES CHALLENGE_STATE provider readCsv csvCell uncell writeCsv writeJson " +
    "detectColumns TX_HASH_RE extractTxHash extractTxHashes normAddress fmt fmtEth isContractCode depKey OTHER_NETWORKS otherNetworkOf " +
    "depositsInLogs verifyTx verifyRegistrations MONEY_CODES UNREAD_CODES resolveClaims pairReturns getLogsChunked incomingDeposits safeBatch " +
    "lumaDecision loadAbi").split(" ");
  for (const name of before) assert.ok(name in lib, `lib.mjs lost ${name}`);
  for (const name of Object.keys(core))
    if (name !== "caseTemplate" && name !== "deployArgs") assert.equal(lib[name], core[name], `lib.mjs ${name} is not core.mjs ${name}`);
});

// ---------------------------------------------------------------- the live contract

test("the live contract's constructor arguments and case description are unchanged (config.json, config.rehearsal.json)", () => {
  const { abi } = load("TruthPaysKickback");
  const iface = new ethers.Interface(abi);
  // keccak256 of the encoded constructor arguments, from lib.mjs before the core existed (7f5ae1a): the
  // contract at 0xd5c6A73c05FA431c748781DaBAA99Fe2590d677D was deployed from config.json with these
  const GOLDEN = {
    "config.json": { args: "0xa589c22ae97e8bbf894dc9b0c4ccda747eeb55f10d5093ddac6c3814a83ca8f3", sample: "/ipfs/QmPKFnR1fdqFVF2beZbb8cou1SpUowpbN6dL6sbyS8A3f6" },
    "config.rehearsal.json": { args: "0x4a18422e2410ce159e4cafce5785bab70fde3c6ebb5a07506e521fdb00d1fa22", sample: "/ipfs/QmaTmB7ZmU4bReTho27imPXmrTHkQQM6kDwvdykmSfnJzh" },
  };
  for (const [file, golden] of Object.entries(GOLDEN)) {
    const cfg = lib.loadConfig(path.join(root, file));
    const owner = cfg.owner;
    const args = lib.deployArgs(cfg, owner);
    assert.equal(ethers.keccak256(iface.encodeDeploy(args)), golden.args, `${file}: constructor arguments changed`);
    // the core with the template's text gives the same, and so does the console's way: its /settings.json
    // computes them for the zero address and the page puts the connected wallet in (test/fork.e2e.mjs too)
    const text = read(cfg.kleros.metaEvidenceTemplate);
    assert.equal(json(core.deployArgs(cfg, owner, text)), json(args));
    assert.equal(json(lib.deployArgs(cfg, owner, text)), json(args));
    const settings = JSON.parse(json(lib.deployArgs(cfg, ethers.ZeroAddress)));
    const fromConsole = [BigInt(settings[0]), settings[1], owner, BigInt(settings[3]), BigInt(settings[4]), settings[5]];
    assert.equal(ethers.keccak256(iface.encodeDeploy(fromConsole)), golden.args, `${file}: the console's constructor arguments changed`);
    // the case description jurors see, for a sample wallet: same text, same IPFS path
    const t = lib.caseTemplate(cfg, owner);
    assert.equal(t.file, path.join(root, "docs/metaevidence.template.json"));
    assert.equal(core.ipfsPathOf(t.sample), golden.sample);
    assert.deepEqual(core.caseTemplate(text, core.templateValues(cfg, owner)), { pieces: t.pieces, slots: t.slots, sample: t.sample });
    assert.deepEqual(lib.caseTemplate(text, core.templateValues(cfg, owner)), { pieces: t.pieces, slots: t.slots, sample: t.sample });
    // normalizeConfig is loadConfig without the file
    assert.equal(json(core.normalizeConfig(JSON.parse(read(file)), path.join(root, file))), json(cfg));
  }
});

test("the live juror policy and case description template are byte-for-byte unchanged", () => {
  const sha = (f) => crypto.createHash("sha256").update(fs.readFileSync(path.join(root, f))).digest("hex");
  assert.equal(sha("docs/attendance-policy.md"), "3a641f2590e36d4330225dcd5341949290f5ef7bf431bb89656078c0f2f453cd");
  assert.equal(sha("docs/metaevidence.template.json"), "db9bfefb39db242ed57372a9f71978d78b30bdd935f0df618393ce4d9b70f3a0");
  // and the pinned path in the live config is the one computed from the file
  assert.equal(core.ipfsPathOf(read("docs/attendance-policy.md")), lib.loadConfig(path.join(root, "config.json")).kleros.policyURI);
});

// ---------------------------------------------------------------- CSV

const CSV_OPTS = { columns: true, skip_empty_lines: true, bom: true, relax_column_count: true };
const viaCsvParse = (text) => { try { return JSON.stringify(parse(text, CSV_OPTS)); } catch { return "error"; } };
const viaCore = (text) => { try { return JSON.stringify(core.parseCsv(text)); } catch { return "error"; } };

test("parseCsv reads CSV text exactly like readCsv (csv-parse), quirks included", () => {
  const cases = [
    "a,b\n1,2\n", "a,b\r\n1,2\r\n3,4", "a,b\r1,2\r3,4", "a,b\r\n1,2\n3,4\r\n", "a,b\n1,2\r\n3,4\n", "a,b\n1\n", "a,b\n1,2,3\n",
    "a,a\n1,2\n", "a,b\n\n\n1,2\n\n", "a,b\n,\n", "a,b\n \n1,2", '﻿a,b\n"x ""y""",2\n', 'a,b\n"multi\nline",2\n',
    'a,b\n"multi\r\nline",2\r\n', 'a,b\nab"c,2\n', 'a,b\n"ab"c,2\n', 'a,b\n"ab" ,2\n', 'a,b\n"ab",2 \n', "a,b\n1,2\n3", "", "a,b",
    "a,b\n", ",b\n1,2\n", 'a,b\n"",""\n', 'a,b\n"a\rb",2\n', 'a,b\n1,"2"\n', "a,b\r\n\r\n1,2\r\n", "a\n1\n\n", 'a\n""\n', "a,b\n1,2\r",
    "a,b\n1\r2,3\n", "a,b\r\n1\r2,3\r\n", "a,b\r\n1\n2,3\r\n", 'a,b\n" x",2\n', "a,b\n﻿1,2\n", "a,b,c\n1,2\n", 'a,b\n"1"\n',
    'a\n"x', 'a\n""""\n', '"a\r\nb",c\r\n1,2\r\n', '"a"\r1\r', 'a\n"x"\0\n', "﻿", "\n\na,b\n1,2", "__proto__,b\n1,2\n",
  ];
  for (const c of cases) assert.equal(viaCore(c), viaCsvParse(c), JSON.stringify(c));
  // a Luma export: BOM, CRLF, quoted answers with commas, quotes and line breaks, a free guest's short row
  const luma = "﻿api_id,name,email,ticket_name,approval_status,checked_in_at,eth_address,\"Deposit tx link (Committed Spot only), etherscan.io\"\r\n" +
    `gst-1,"Ana ""A"" Lee",ana@x.io,Committed Spot (0.01 ETH),approved,2026-11-04T13:00:00.000Z,0x${"ab".repeat(20)},"https://etherscan.io/tx/0x${"12".repeat(32)}\nthanks, Ana"\r\n` +
    "gst-2,Ben,ben@x.io,Request to Join (Free),pending_approval,,\r\n\r\n";
  assert.equal(viaCore(luma), viaCsvParse(luma));
  assert.equal(core.parseCsv(luma)[0].name, 'Ana "A" Lee');
  // random text over the characters that matter (seeded, so a failure can be replayed)
  let seed = 20261028;
  const rand = () => ((seed = (seed * 1103515245 + 12345) >>> 0) / 2 ** 32);
  const alphabet = ["a", "b", "a", ",", ",", '"', '"', "\n", "\r", "\r\n", " ", "é", "﻿", "\0", "x"];
  for (let i = 0; i < 5000; i++) {
    const text = Array.from({ length: Math.floor(rand() * 30) }, () => alphabet[Math.floor(rand() * alphabet.length)]).join("");
    assert.equal(viaCore(text), viaCsvParse(text), `case ${i}: ${JSON.stringify(text)}`);
  }
  // and well-formed exports: fields quoted when they must be, mixed line endings, blank lines, short and long rows
  const pick = (a) => a[Math.floor(rand() * a.length)];
  let rowsSeen = 0;
  for (let i = 0; i < 3000; i++) {
    const field = () => {
      const v = Array.from({ length: Math.floor(rand() * 6) }, () => pick(["a", "b", "é", " ", ",", '"', "\n", "\r\n", "0x1f"])).join("");
      return /[",\r\n]/.test(v) || rand() < 0.2 ? `"${v.replace(/"/g, '""')}"` : v;
    };
    const eol = pick(["\n", "\r\n", "\r"]);
    const lines = Array.from({ length: 1 + Math.floor(rand() * 5) }, () => (rand() < 0.1 ? "" : Array.from({ length: 1 + Math.floor(rand() * 4) }, field).join(",")));
    const text = (rand() < 0.2 ? "﻿" : "") + lines.join(rand() < 0.9 ? eol : pick(["\n", "\r\n"])) + (rand() < 0.5 ? eol : "");
    const expected = viaCsvParse(text);
    if (expected !== "error") rowsSeen += JSON.parse(expected).length;
    assert.equal(viaCore(text), expected, `case ${i}: ${JSON.stringify(text)}`);
  }
  assert.ok(rowsSeen > 3000, `only ${rowsSeen} rows compared`);
});

test("toCsv is what writeCsv writes, with formula-safe cells that read back unchanged", () => {
  const rows = [
    { name: "=HYPERLINK(\"x\")", email: "a@x.io", note: "line 1\nline 2, \"quoted\"" },
    { name: "+cmd", email: "-b@x.io", note: "@sum" },
    { name: "Ana", email: "", note: undefined },
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-csv-"));
  lib.writeCsv(path.join(dir, "x.csv"), rows, ["name", "email", "note"]);
  const text = fs.readFileSync(path.join(dir, "x.csv"), "utf8");
  assert.equal(text, core.toCsv(rows, ["name", "email", "note"]));
  assert.deepEqual(core.parseCsv(text), lib.readCsv(path.join(dir, "x.csv")));
  assert.deepEqual(core.parseCsv(text).map((r) => core.uncell(r.name)), ['=HYPERLINK("x")', "+cmd", "Ana"]);
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---------------------------------------------------------------- generic texts for new events

test("the generic juror policy keeps the live rules, never names the live event, and has its own IPFS path", () => {
  const live = read("docs/attendance-policy.md"), generic = GENERIC_POLICY_TEXT;
  assert.doesNotMatch(generic, /Truth Pays|Devcon|Mumbai|Hitchki|BKC|\bIST\b|Luma|Arkiv|Golem|Web3|2026/);
  assert.match(generic, /the event named in the case description/);
  assert.match(generic, /the deposit contract that created the case/);
  const sections = (t) => t.split(/^## /m).slice(1).map((s) => [s.slice(0, s.indexOf("\n")), s.slice(s.indexOf("\n"))]);
  const liveS = Object.fromEntries(sections(live)), genS = Object.fromEntries(sections(generic));
  // the same rules, word for word, where nothing is event-specific
  for (const h of ["Answers", "Appeals", "What happens after the final ruling"]) assert.equal(genS[h], liveS[h], `section "${h}" differs`);
  for (const rule of [
    "If the evidence and the contract disagree, the contract is correct.",
    "Evidence sent from the organiser's wallet named in the case description is the organiser's own statement. A statement presented as the organiser's but sent from another wallet is not.",
    "The challenger must show that attendance is **more likely than not**.",
    "Sending someone else in their place does not count as attending, unless the organiser approved the transfer of the spot before the event.",
    "If the organiser confirms in the case that the person attended, rule **Attended**.",
    "If neither side provides meaningful evidence, rule **Did not attend** (the challenger has not shown attendance).",
    "Evidence that is clearly edited, generated, or from another date or place should be ignored, and counts against the party who submitted it.",
    "has 1 day to challenge, paying an ETH deposit equal to the Kleros fee.",
    "has 1 day to match that deposit. Matching creates this dispute.",
    "\"Refuse to arbitrate\" (option 0) can be funded like an answer",
  ]) {
    assert.ok(live.includes(rule), `the live policy no longer says: ${rule}`);
    assert.ok(generic.includes(rule), `the generic policy lost: ${rule}`);
  }
  assert.ok(core.isIpfsPath(GENERIC_POLICY_PATH) && !core.STALE_PINS.some((p) => GENERIC_POLICY_PATH.includes(p)));
  assert.notEqual(GENERIC_POLICY_PATH, core.ipfsPathOf(live));
});

test("the generic case description is valid ERC-1497 once filled in: it names the event, the wallet and the organiser, and fits", () => {
  const cfg = core.newEventConfig(FORM, MAINNET, ORGANISER);
  assert.equal(cfg.claimDeadline, "2027-03-26T18:00:00.000Z"); // 14 days after the start by default
  assert.equal(cfg.depositUnits, E("0.01"));
  const args = core.deployArgs(cfg, ORGANISER, GENERIC_TEXT, { name: "metaevidence.generic.template.json" });
  const [deposit, eventName, owner, start, end, [resolver, extraData, pieces, slots, policyURI]] = args;
  assert.deepEqual([deposit, eventName, owner, start, end], [E("0.01"), FORM.eventName, ORGANISER, 1804874400, 1806084000]);
  assert.equal(resolver, ethers.getAddress(core.KLEROS[1].disputeResolver)); // Kleros's own Dispute Resolver on mainnet
  assert.equal(extraData, ethers.AbiCoder.defaultAbiCoder().encode(["uint256", "uint256"], [0, 3])); // General Court, 3 jurors
  assert.equal(policyURI, GENERIC_POLICY_PATH);
  const text = core.renderCase({ pieces, slots }, W, C);
  const meta = JSON.parse(text);
  // ERC-1497 metaevidence, the same shape as the live template
  const liveMeta = JSON.parse(lib.caseTemplate(lib.loadConfig(path.join(root, "config.json")), ORGANISER).sample);
  assert.deepEqual(Object.keys(meta), Object.keys(liveMeta));
  assert.equal(meta.category, "Event attendance");
  assert.deepEqual(meta.rulingOptions.titles, ["Attended", "Did not attend"]);
  assert.equal(meta.rulingOptions.type, "single-select");
  assert.equal(meta.rulingOptions.descriptions.length, 2);
  assert.equal(meta.fileURI, GENERIC_POLICY_PATH);
  for (const key of ["title", "question"]) assert.ok(meta[key].includes(W), `${key} names the wallet`);
  for (const d of meta.rulingOptions.descriptions) assert.ok(d.includes(W));
  for (const v of [FORM.eventTitle, FORM.eventName, FORM.eventWhen, FORM.eventWhere, FORM.hosts, FORM.eventLink, W, C, ORGANISER, "0.01 ETH",
    `https://etherscan.io/address/${C}#readContract`])
    assert.ok(meta.description.includes(v), `the description names ${v}`);
  assert.deepEqual(meta.aliases, {
    [W]: "Challenger (the guest's wallet)", [W.toLowerCase()]: "Challenger (the guest's wallet)",
    [ORGANISER]: "Organiser (the deposit contract's owner wallet)", [ORGANISER.toLowerCase()]: "Organiser (the deposit contract's owner wallet)",
  });
  assert.doesNotMatch(text, /\{\{|\}\}|Truth Pays|Devcon|Mumbai|Luma/);
  assert.ok(core.isIpfsPath(core.ipfsPathOf(text)));
  // the template's placeholders are all known ones; it uses every runtime value and the organiser
  const used = new Set([...GENERIC_TEXT.matchAll(/\{\{(\w+)\}\}/g)].map((m) => m[1]));
  assert.deepEqual([...used].sort(), ["contract", "deposit", "eventLink", "eventName", "eventTitle", "eventWhen", "eventWhere", "explorer", "hosts", "owner", "ownerLower", "policyURI", "wallet", "walletLower"]);
  // every field at its longest (3-byte characters, or quotes that JSON doubles) still fits the contract
  for (const fill of [(f) => "€".repeat(f.max), (f) => '"\\'.repeat(f.max / 2)]) {
    const big = Object.fromEntries(core.EVENT_FIELDS.map((f) => [f.key, f.link ? "https://x.io/" + "a".repeat(f.max - 13) : fill(f)]));
    const t = core.caseTemplate(GENERIC_TEXT, core.templateValues(core.newEventConfig({ ...FORM, ...big }, MAINNET, ORGANISER), ORGANISER));
    const size = ethers.dataLength(ethers.AbiCoder.defaultAbiCoder().encode(["string[]", "bytes"], [t.pieces, t.slots]));
    assert.ok(size < core.MAX_TEMPLATE_BYTES / 2, `template of ${size} bytes`);
    assert.equal(JSON.parse(t.sample).question.includes(big.eventTitle), true); // escaped, not broken
  }
});

test("the new-event form and the generic template refuse what would not work, with plain messages", () => {
  const refuse = (over, re) => assert.throws(() => core.newEventConfig({ ...FORM, ...over }, MAINNET, ORGANISER), re, JSON.stringify(over));
  refuse({ eventTitle: " " }, /^Error: Event title: please fill this in\.$/);
  refuse({ eventWhere: "" }, /Venue or city: please fill this in/);
  refuse({ eventName: "x".repeat(81) }, /Short name is too long \(81 characters, at most 80\)/);
  refuse({ hosts: "Ann\nBob" }, /Hosts: please keep it on one line/);
  // characters that disguise a text (the generic guest page strips the same ones from a name): next line (C1),
  // line and paragraph separators, zero-width characters, text-direction overrides and isolates, the byte-order mark
  const ch = (code) => String.fromCharCode(code);
  for (const code of [0x85, 0x9f, 0x2028, 0x2029, 0x200b, 0x200f, 0x202e, 0x202a, 0x2066, 0x2069, 0xfeff])
    refuse({ eventWhere: `Caf${ch(0xe9)} ${ch(code)}nilreb` }, /Venue or city: please keep it on one line, without invisible or text-direction characters/);
  refuse({ eventName: `OJN${ch(0x200b)}${ch(0x2066)}x${ch(0x2069)}` }, /Short name: please keep it on one line, without invisible/);
  // NFC: "é" typed as e + combining accent is kept as the single character the preview shows
  assert.equal(core.eventDetails({ ...FORM, eventWhere: `Cafe${ch(0x301)}, Berlin` }).eventWhere, `Caf${ch(0xe9)}, Berlin`);
  refuse({ eventTitle: "{{wallet}}" }, /Event title can't contain "\{\{" or "\}\}"/);
  refuse({ eventLink: "luma.com/x" }, /Registration link must be a web address starting with https:\/\//);
  refuse({ deposit: "" }, /Deposit: type an amount of ETH such as 0\.01/);
  refuse({ deposit: "0" }, /Deposit: it must be more than 0 ETH/);
  refuse({ deposit: "25" }, /more than 1 ETH per guest looks like a mistake/);
  refuse({ eventStart: "2027-03-12T19:00" }, /Event start: pick a date, a time and a timezone/);
  refuse({ claimDeadline: "2027-03-18T19:00:00+01:00" }, /at least 7 days after the event starts/);
  assert.throws(() => core.newEventConfig(FORM, MAINNET, ""), /Connect your wallet first/);
  // every wrong field at once, for the form to highlight
  try { core.eventDetails({ ...FORM, eventTitle: "", hosts: "" }); assert.fail("accepted"); } catch (e) {
    assert.deepEqual(Object.keys(e.fields), ["eventTitle", "hosts"]);
  }
  // the template itself: a generic placeholder with no value, and the live checks still apply
  const cfg = core.newEventConfig(FORM, MAINNET, ORGANISER);
  const values = core.templateValues(cfg, ORGANISER);
  assert.throws(() => core.caseTemplate(GENERIC_TEXT, { ...values, eventWhere: "" }, { name: "the template" }), /the template names the event's "Venue or city" \(\{\{eventWhere\}\}\), but it is empty/);
  assert.throws(() => core.caseTemplate(GENERIC_TEXT, { ...values, owner: "" }), /names the organiser's wallet/);
  assert.throws(() => core.deployArgs({ ...cfg, kleros: { policyURI: "" } }, ORGANISER, GENERIC_TEXT), /kleros\.policyURI/);
  assert.throws(() => core.deployArgs(cfg, ORGANISER, undefined), /No case description template/);
  // a value that looks like a placeholder never becomes one: the contract's slots stay the template's own
  const plain = core.caseTemplate(GENERIC_TEXT, values);
  const tricky = core.caseTemplate(GENERIC_TEXT, { ...values, hosts: "{{wallet}} and {{contract}}" });
  assert.equal(tricky.slots, plain.slots);
  assert.ok(JSON.parse(tricky.sample).description.includes("hosted by {{wallet}} and {{contract}}"));
});

test("describeWhen writes the date and time in the event's own timezone", () => {
  assert.equal(core.describeWhen("2026-11-04T18:00:00+05:30", "2026-11-04T22:00:00+05:30", "IST"), "Wednesday 4 November 2026, 18:00-22:00 IST");
  assert.equal(core.describeWhen("2027-03-12T19:00:00+01:00", "2027-03-12T23:00:00+01:00"), "Friday 12 March 2027, 19:00-23:00 UTC+01:00");
  assert.equal(core.describeWhen("2027-03-12T22:00:00-05:00", "2027-03-13T02:30:00-05:00", "EST"), "Friday 12 March 2027, 22:00 to Saturday 13 March 2027, 02:30 EST");
  assert.throws(() => core.describeWhen("2027-03-12T19:00", "2027-03-12T23:00"), /with a timezone/);
  assert.throws(() => core.describeWhen("2027-03-12T19:00:00Z", "2027-03-12T18:00:00Z"), /must end after it starts/);
  // a timezone name that contradicts the offset is refused: jurors would read another time than the contract keeps
  // (a Berlin summer event created in winter with the winter offset, or India's IST typed with Tokyo's +09:00)
  const summer = ["2027-06-12T19:00:00+01:00", "2027-06-12T23:00:00+01:00"];
  for (const zone of ["CEST", "EST", "UTC", "GMT+2", "UTC+02:00", "Berlin time (CEST)"])
    assert.throws(() => core.describeWhen(...summer, zone), new RegExp(`Timezone name: "${zone.match(/CEST|EST|UTC\+02:00|GMT\+2|UTC/)[0].replace("+", "\\+")}" is not UTC\\+01:00`), zone);
  assert.throws(() => core.describeWhen("2027-06-12T19:00:00+09:00", "2027-06-12T23:00:00+09:00", "IST"), /Timezone name: "IST" is not UTC\+09:00/);
  for (const zone of ["CET", "BST", "UTC+1", "GMT+01:00", "Berlin time", "West Africa Time"])
    assert.match(core.describeWhen(...summer, zone), new RegExp(`19:00-23:00 ${zone.replace("+", "\\+").replace("(", "\\(").replace(")", "\\)")}$`), zone);
  assert.equal(core.describeWhen("2027-06-12T19:00:00+02:00", "2027-06-12T23:00:00+02:00", "CEST"), "Saturday 12 June 2027, 19:00-23:00 CEST");
  assert.equal(core.describeWhen("2027-06-12T19:00:00+05:30", "2027-06-12T23:00:00+05:30", "IST"), "Saturday 12 June 2027, 19:00-23:00 IST");
  const ch = (code) => String.fromCharCode(code);
  for (const code of [0x202e, 0x2028, 0x200b, 0x85]) assert.throws(() => core.describeWhen(...summer, `C${ch(code)}ET`), /Timezone name: please keep it on one line, without invisible/);
  assert.throws(() => core.describeWhen(...summer, "x".repeat(41)), /Timezone name is too long/);
  assert.throws(() => core.describeWhen(...summer, "{{wallet}}"), /Timezone name can't contain/);
});

test("eventClock reads the event's own clock from its case description, or gives none", () => {
  // the table the generic guest page's copy is checked against too (test/site-generic.e2e.mjs)
  for (const [what, text, start, expected] of CLOCK_CASES) assert.deepEqual(core.eventClock(text, start), expected, what);
  // every offset the admin panel's form offers (core.TZ_OFFSETS) comes back from the case description it writes, named
  // by the offset without a timezone name, and by the name with one
  const OFFSETS = core.TZ_OFFSETS.map((t) => (t[0] === "-" ? -1 : 1) * (Number(t.slice(1, 3)) * 60 + Number(t.slice(4, 6))));
  assert.equal(OFFSETS.length, 40);
  assert.deepEqual(OFFSETS.map(core.offsetText), core.TZ_OFFSETS);
  assert.deepEqual(OFFSETS, [...OFFSETS].sort((a, b) => a - b));
  for (const off of OFFSETS) {
    const iso = (h) => `2027-03-12T${h}:00${core.offsetText(off)}`, start = Date.parse(iso("19:00")) / 1000;
    const when = (zone) => JSON.stringify({ title: `Did wallet ${W} attend Night (${core.describeWhen(iso("19:00"), iso("23:00"), zone)})?` });
    assert.deepEqual(core.eventClock(when(""), start), { offset: off, zone: `UTC${core.offsetText(off)}` }, String(off));
    assert.deepEqual(core.eventClock(when(`GMT${core.offsetText(off)}`), start), { offset: off, zone: `GMT${core.offsetText(off)}` }, String(off));
  }
  // a case as the hosted panel renders it from readEvent's template is the contract's own text: the same clock
  const t = core.caseTemplate(GENERIC_TEXT, core.templateValues(core.newEventConfig({ ...FORM, eventWhen: core.describeWhen("2027-03-12T19:00:00+01:00", "2027-03-12T23:00:00+01:00", "CET") }, MAINNET, ORGANISER), ORGANISER));
  assert.deepEqual(core.eventClock(core.renderCase(t, ORGANISER, C), Date.parse(FORM.eventStart) / 1000), { offset: 60, zone: "CET" });
  // the names it trusts: the UTC / GMT forms of exactly that offset, and the abbreviations whose first meaning it is
  for (const [name, off] of [["IST", 330], ["CET", 60], ["UTC", 0], ["GMT", 0], ["UTC+5:30", 330], ["UTC+0530", 330], ["GMT\u221203:30", -210], [" CEST ", 120],
    ["PST", -480], ["CST", -360], ["BST", 60], ["AST", -240]])
    assert.ok(core.zoneIs(name, off), `${name} ${off}`);
  // not: another offset, other text, or a name read first as another timezone (Irish IST, Philippine PST, Cuban or
  // Chinese CST, Bangladeshi BST, Arabian AST), though checkZoneName lets the organiser write them
  for (const [name, off] of [["IST", 420], ["CET", 120], ["UTC+02:00", 60], ["UTC+05:75", 375], ["Berlin time", 60], ["cet", 60], ["constructor", 0], ["toString", 0], ["", 0], ["UTC+1 CET", 60],
    ["IST", 60], ["IST", 120], ["PST", 480], ["CST", -300], ["CST", 480], ["BST", 360], ["AST", 180]])
    assert.ok(!core.zoneIs(name, off), `${name} ${off}`);
  for (const [name, offs] of Object.entries(core.ZONE_OFFSETS)) for (const off of offs) {
    assert.doesNotThrow(() => core.checkZoneName(name, off), name);
    assert.ok(core.TZ_OFFSETS.includes(core.offsetText(off)), `${name} ${off} is an offset the form offers`);
  }
});

// ---------------------------------------------------------------- the lists, on a local chain

let server, prov, rpcUrl;
const keys = Array.from({ length: 9 }, (_, i) => "0x" + (i + 0x31).toString(16).padStart(64, "0"));
before(async () => {
  execFileSync("node", [path.join(root, "scripts/compile.mjs")], { stdio: "ignore" });
  const port = await new Promise((resolve, reject) => {
    const s = net.createServer().once("error", reject).listen(0, "127.0.0.1", () => { const { port } = s.address(); s.close(() => resolve(port)); });
  });
  server = ganache.server({ logging: { quiet: true }, chain: { chainId: 1337 }, wallet: { accounts: keys.map((k) => ({ secretKey: k, balance: "0x56BC75E2D63100000" })) } });
  await server.listen(port);
  rpcUrl = `http://127.0.0.1:${port}`;
  prov = new ethers.JsonRpcProvider(rpcUrl, 1337, { staticNetwork: true, cacheTimeout: -1 });
  prov.pollingInterval = 50;
  const estimate = prov.estimateGas.bind(prov);
  prov.estimateGas = async (tx) => ((await estimate(tx)) * 12n) / 10n; // a margin, like real wallets
});
after(async () => server && (await server.close()));

test("checkGuests and buildPayout give exactly the lists the scripts write (a contract made from the new-event form)", async () => {
  const [owner, ana, ben, cai, dan, eve, gus, sid, pat] = keys.map((k) => new ethers.NonceManager(new ethers.Wallet(k, prov)));
  const addr = (w) => w.getAddress();
  const me = await addr(owner);
  const deploy = async (name, ...params) => (await new ethers.ContractFactory(load(name).abi, load(name).bytecode, owner).deploy(...params)).waitForDeployment();
  const liquid = await deploy("MockKlerosLiquid");
  const proxy = await deploy("MockArbitrableProxy", liquid.target);
  const { abi } = load("TruthPaysKickback");

  // the organiser fills in the form; the contract is deployed with the core's constructor arguments and the generic template
  const t0 = (await prov.getBlock("latest")).timestamp;
  const network = { chainId: 1337, rpcUrl, explorer: "https://etherscan.io", logChunk: 7,
    kleros: { disputeResolver: proxy.target, arbitrator: liquid.target, policyURI: GENERIC_POLICY_PATH } };
  const newCfg = core.newEventConfig({ ...FORM, eventStart: new Date((t0 + 3600) * 1000).toISOString() }, network, me);
  const kick = await deploy("TruthPaysKickback", ...core.deployArgs(newCfg, me, GENERIC_TEXT));
  const deployBlock = (await kick.deploymentTransaction().wait()).blockNumber;

  // everything about the event, read back on-chain
  const ev = await core.readEvent(prov, kick.target.toLowerCase(), abi);
  assert.deepEqual([ev.contract, ev.eventName, ev.depositAmount, ev.eventStart, ev.claimDeadline, ev.owner, ev.disputeResolver, ev.arbitrator, ev.policyURI, ev.phase],
    [kick.target, FORM.eventName, E("0.01"), t0 + 3600, t0 + 3600 + 14 * DAY, me, proxy.target, liquid.target, GENERIC_POLICY_PATH, 0]);
  assert.equal(core.isKnownResolver(1337, ev.disputeResolver), false); // a page warns: not Kleros's own Dispute Resolver
  assert.equal(core.isKnownResolver(1, core.KLEROS[1].disputeResolver.toUpperCase().replace("0X", "0x")), true);
  const [caseText, caseUri] = await kick.caseMetaEvidence(await addr(ana));
  assert.equal(caseText, core.renderCase(ev.metaEvidenceTemplate, await addr(ana), kick.target));
  assert.equal(caseUri, core.ipfsPathOf(caseText));
  assert.ok(JSON.parse(caseText).description.includes(FORM.eventWhere));
  await assert.rejects(core.readEvent(prov, await addr(eve), abi), (e) => e.code === "NO_KICKBACK_CONTRACT" && /no contract at/.test(e.message));
  await assert.rejects(core.readEvent(prov, liquid.target, abi), (e) => e.code === "NOT_KICKBACK" && /not a kickback deposit contract/.test(e.message));
  await assert.rejects(core.readEvent(prov, "0x1234", abi), (e) => e.code === "NOT_KICKBACK");
  // its code is the compiled contract's, but for the constructor's values (zeroed): answers alone can be faked
  const runtime = await lib.kickbackRuntime();
  assert.ok(runtime.immutables.length > 0 && /^0x[0-9a-f]{64}$/.test(runtime.sha256));
  assert.equal(core.codeFingerprint(await prov.getCode(kick.target), runtime.immutables), runtime.sha256);
  assert.notEqual(core.codeFingerprint(await prov.getCode(kick.target)), runtime.sha256); // the immutables do differ from the compiled code's zeros
  assert.deepEqual(await core.readEvent(prov, kick.target, abi, { runtime }), ev);
  await assert.rejects(core.readEvent(prov, kick.target, abi, { runtime: { ...runtime, sha256: ethers.ZeroHash } }),
    (e) => e.code === "UNKNOWN_CODE" && /answers like a kickback deposit contract, but its code is not/.test(e.message));
  await assert.rejects(core.readEvent(prov, liquid.target, abi, { runtime }), (e) => e.code === "NOT_KICKBACK");
  const cfg = core.contractConfig(ev, network, deployBlock);
  assert.deepEqual(await core.depositsOverview({ prov, cfg, abi, scanFrom: deployBlock }), { deposits: [], returns: [], check: null }); // no deposit yet
  assert.equal(cfg.receiver, kick.target);
  assert.equal(cfg.depositUnits, E("0.01"));
  await assert.rejects(core.checkContract(prov, { ...cfg, depositUnits: E("0.02"), deposit: "0.02" }, abi), (e) => e.code === "DEPOSIT_MISMATCH" && e.depositAmount === E("0.01"));

  // guests pay: approved, declined, waiting, overpaid, short, a stray nobody claims, a copied tx link
  const pay = async (g, eth) => (await (await g.sendTransaction({ to: kick.target, value: E(eth) })).wait()).hash;
  const tx = { ana: await pay(ana, "0.01"), ben: await pay(ben, "0.01"), cai: await pay(cai, "0.015"), dan: await pay(dan, "0.01"),
    eve: await pay(eve, "0.005"), pat: await pay(pat, "0.01") };
  await pay(sid, "0.01"); // a stray: nobody pastes it
  const H = "name,email,ticket_name,approval_status,checked_in_at,eth_address,Deposit tx link (Committed Spot only)";
  const T = "Committed Spot (0.01 ETH)";
  const row = async (name, w, status, txLink, checkedIn = "") => `${name},${name.toLowerCase()}@x.io,${T},${status},${checkedIn},${w ? await addr(w) : ""},${txLink}`;
  const lines = async (checked = {}) => [
    await row("Ana", ana, "approved", `https://etherscan.io/tx/${tx.ana}`, checked.Ana),
    await row("Ben", ben, "declined", tx.ben),
    await row("Cai", cai, "approved", `"see ${tx.cai}, thanks"`, checked.Cai),
    await row("Dan", null, "approved", tx.dan, checked.Dan), // wallet taken from the sender
    await row("Eve", eve, "approved", tx.eve),
    await row("Gus", gus, "approved", tx.ana), // a copy of Ana's link
    await row("Pat", pat, "pending_approval", tx.pat),
    `Hal,hal@x.io,Request to Join (Free),approved,${checked.Hal ?? ""},,`,
    `=Mal,"mal@x.io",${T},approved,,,not sure`,
  ];
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "core-e2e-"));
  const guestsCsv = "﻿" + [H, ...(await lines())].join("\r\n") + "\r\n";
  fs.writeFileSync(path.join(dir, "guests.csv"), guestsCsv);
  // the scripts get the same settings in config.json
  fs.writeFileSync(path.join(dir, "config.json"), JSON.stringify({
    eventName: ev.eventName, chain: "local", chainId: 1337, rpcUrl, explorer: "https://etherscan.io", logChunk: 7, deposit: "0.01",
    receiver: kick.target, contract: kick.target, eventStart: new Date(ev.eventStart * 1000).toISOString(),
    claimDeadline: new Date(ev.claimDeadline * 1000).toISOString(), depositDeadline: new Date(ev.eventStart * 1000).toISOString(),
    owner: me, mode: "live", deployBlock, kleros: { disputeResolver: proxy.target, arbitrator: liquid.target, policyURI: GENERIC_POLICY_PATH },
  }));
  const run = (script, ...params) =>
    execFileP("node", [path.join(root, "scripts", script), "--config", "config.json", "--out", "out", ...params], { cwd: dir, encoding: "utf8" });
  const outText = (f) => fs.readFileSync(path.join(dir, "out", f), "utf8");
  const outJson = (f) => JSON.parse(outText(f));
  const unstamped = (l) => { const { generatedAt, ...rest } = JSON.parse(json(l)); return rest; };

  const check = async () => {
    const { stdout, stderr } = await run("verify-deposits.mjs", "--guests", "guests.csv");
    const info = [], warnings = [];
    const r = await core.checkGuests({ prov, cfg, abi, rows: core.parseCsv(guestsCsv), scanFrom: cfg.deployBlock, log: { info: (m) => info.push(m), warn: (m) => warnings.push(m) } });
    for (const [key, file] of [["verified", "verified.csv"], ["issues", "issues.csv"], ["toReview", "to-review.csv"], ["returns", "returns.csv"],
      ["claims", "claims.csv"], ["unmatched", "unmatched.csv"]])
      assert.equal(core.toCsv(r[key], core.CHECK_COLUMNS[key]), outText(file), file);
    assert.deepEqual(unstamped(r.lists.newStakers), unstamped(outJson("new-stakers.json")));
    assert.deepEqual(unstamped(r.lists.refunds), unstamped(outJson("refunds.json")));
    // the script prints the same progress lines and warnings
    assert.deepEqual(warnings, r.warnings);
    assert.equal(stderr, warnings.map((w) => w + "\n").join(""));
    for (const line of info) assert.ok(stdout.includes(line + "\n"), line);
    return r;
  };
  let r = await check();
  const wallets = (list) => list.items.map((i) => i.wallet);
  assert.deepEqual(wallets(r.lists.newStakers), [await addr(ana), await addr(cai), await addr(dan)]);
  assert.deepEqual(wallets(r.lists.refunds), [await addr(ben)]);
  assert.deepEqual(r.toReview.map((v) => v.name), ["Pat"]);
  assert.deepEqual(r.returns.map((x) => [x.name, x.code, x.to_return]), [["Cai", "OVERPAID", "0.005"], ["Eve", "AMOUNT_TOO_LOW", "0.005"]]);
  assert.deepEqual(r.issueCounts, { BAD_TX_HASH: 1, DUPLICATE_TX: 1, AMOUNT_TOO_LOW: 1, OVERPAID: 1 });
  assert.deepEqual(r.openUnmatched.map((u) => u.from), [await addr(sid)]);
  assert.equal(r.held.length, 5);

  // a page's Deposits table, with no Luma export: every deposit, checked by the same rules
  const people = { Ana: ana, Ben: ben, Cai: cai, Dan: dan, Eve: eve, Pat: pat, Sid: sid };
  const nameOf = new Map(await Promise.all(Object.entries(people).map(async ([n, w]) => [await addr(w), n])));
  const overview = async () => {
    const o = await core.depositsOverview({ prov, cfg, abi, scanFrom: cfg.deployBlock });
    return { ...o, rows: o.deposits.map((d) => [nameOf.get(d.from), d.status, ethers.formatEther(d.held), d.code, d.canRegister, d.canRefund]) };
  };
  let o = await overview();
  assert.deepEqual(o.rows, [
    ["Ana", "unregistered", "0.01", "VERIFIED", true, true], ["Ben", "unregistered", "0.01", "VERIFIED", true, true],
    ["Cai", "unregistered", "0.015", "VERIFIED", true, true], ["Dan", "unregistered", "0.01", "VERIFIED", true, true],
    ["Eve", "unregistered", "0.005", "AMOUNT_TOO_LOW", false, false], ["Pat", "unregistered", "0.01", "VERIFIED", true, true],
    ["Sid", "unregistered", "0.01", "VERIFIED", true, true]]);
  assert.deepEqual(o.returns.map((x) => [nameOf.get(x.wallet), x.code, x.to_return]), [["Cai", "OVERPAID", "0.005"], ["Eve", "AMOUNT_TOO_LOW", "0.005"]]);
  const first = o.deposits[0];
  const firstBlock = await prov.getBlock(first.block);
  assert.deepEqual([first.tx, first.amount, first.explorer, first.sentAt],
    [tx.ana, E("0.01"), `https://etherscan.io/tx/${tx.ana}`, new Date(firstBlock.timestamp * 1000).toISOString()]);
  assert.match(o.deposits[2].note, /overpaid by 0\.005 ETH/);
  assert.deepEqual([o.check.unmatched, o.check.warnings], [[], []]);

  // the organiser registers and refunds from the lists, and checks again: nothing left to do
  await (await kick.connect(owner).registerStakers(wallets(r.lists.newStakers))).wait();
  await (await kick.connect(owner).rejectAndRefund(wallets(r.lists.refunds))).wait();
  r = await check();
  assert.deepEqual([r.lists.newStakers.items.length, r.lists.refunds.items.length], [0, 0]);
  assert.deepEqual(r.verified.map((v) => [v.name, v.onchain]), [["Ana", "registered"], ["Ben", "refunded"], ["Cai", "registered"], ["Dan", "registered"], ["Pat", "unregistered"]]);
  o = await overview();
  assert.deepEqual(o.rows, [
    ["Ana", "registered", "0.01", "VERIFIED", false, true], ["Ben", "refunded", "0.0", "VERIFIED", false, false],
    ["Cai", "registered", "0.015", "VERIFIED", false, true], ["Dan", "registered", "0.01", "VERIFIED", false, true],
    ["Eve", "unregistered", "0.005", "AMOUNT_TOO_LOW", false, false], ["Pat", "unregistered", "0.01", "VERIFIED", true, true],
    ["Sid", "unregistered", "0.01", "VERIFIED", true, true]]);
  // whether a whole deposit of each payment is still held for a spot (staked, or not returned)
  assert.deepEqual(o.deposits.map((d) => [nameOf.get(d.from), d.heldForSpot]),
    [["Ana", true], ["Ben", false], ["Cai", true], ["Dan", true], ["Eve", false], ["Pat", true], ["Sid", true]]);
  // Ben, refunded, pays again: the new deposit can be registered (the contract accepts a refunded wallet)
  const benAgain = await pay(ben, "0.01");
  o = await overview();
  const benNew = o.deposits.find((d) => d.tx === benAgain);
  assert.deepEqual([benNew.status, benNew.code, benNew.heldForSpot, benNew.canRegister, benNew.canRefund], ["refunded, paid again", "VERIFIED", true, true, false]);

  // after the event: Ana checked in on Luma, Cai is on the door list, Dan did not come
  await prov.send("evm_increaseTime", [3600 + 600]);
  await prov.send("evm_mine", []);
  // a late payment: "unregistered" whatever happens to it, so only heldForSpot says whether it is still there
  const gusLate = await pay(gus, "0.01");
  const gusRow = async () => (await core.depositsOverview({ prov, cfg, abi, scanFrom: cfg.deployBlock })).deposits.find((d) => d.tx === gusLate);
  let g = await gusRow();
  assert.deepEqual([g.status, g.code, g.heldForSpot, g.canRegister], ["unregistered", "OUTSIDE_WINDOW", true, false]);
  await (await kick.connect(owner).refund(await addr(gus), E("0.01"))).wait(); // returned with "Return a stray transfer"
  g = await gusRow();
  assert.deepEqual([g.status, g.held, g.heldForSpot], ["unregistered", 0n, false]);
  const afterCsv = [H, ...(await lines({ Ana: "2027-03-12T19:30:00.000Z", Hal: "2027-03-12T19:40:00.000Z" }))].join("\n");
  fs.writeFileSync(path.join(dir, "after.csv"), afterCsv);
  const doorCsv = "email,note\ncai@x.io,came late\nnobody@x.io,\n";
  fs.writeFileSync(path.join(dir, "door.csv"), doorCsv);
  const { stdout: log } = await run("build-payout.mjs", "--checkins", "after.csv", "--extra-checkins", "door.csv");
  assert.match(log, /Door list: 2 rows, 1 matched a staker/);
  const p = await core.buildPayout({ prov, cfg, abi, checkins: core.parseCsv(afterCsv), verified: r.verified, claims: r.claims, extra: core.parseCsv(doorCsv), extraName: "door.csv" });
  assert.deepEqual(p.attendees.map((x) => x.wallet), outJson("attendees.json"));
  assert.deepEqual(p.plan, outJson("payout-plan.json"));
  assert.equal(core.toCsv(p.payoutRows, core.PAYOUT_COLUMNS), outText("payout.csv"));
  assert.equal(p.summaryMarkdown, outText("payout-summary.md"));
  assert.deepEqual(p.door.unmatched, [{ email: "nobody@x.io", wallet: null }]);
  assert.deepEqual([p.plan.attendees, p.plan.share, p.unknown], [[await addr(ana), await addr(cai)], E("0.015").toString(), []]);
  // a heading for any event
  const titled = await core.buildPayout({ prov, cfg, abi, checkins: core.parseCsv(afterCsv), verified: r.verified, claims: r.claims, title: ev.eventName });
  assert.match(titled.summaryMarkdown, /^# Onchain Justice Night, Berlin 2027: deposit settlement/);
  assert.deepEqual(titled.plan.attendees, [await addr(ana)]); // without the door list Cai is a no-show
  // a registered staker no verified registration names is reported, for the caller to decide
  const lost = await core.buildPayout({ prov, cfg, abi, checkins: core.parseCsv(afterCsv), verified: r.verified.filter((v) => v.name !== "Dan"), claims: [] });
  assert.deepEqual(lost.unknown, [await addr(dan)]);
  assert.match(lost.unknownNote, /^1 registered stakers have no Luma registration that verified their wallet/);
  // a door list with a wallet column alone (no Luma export, e.g. a registration page without a tx link question)
  const doorOnly = await core.buildPayout({ prov, cfg, abi, checkins: null, extra: core.parseCsv(`wallet\n${await addr(ana)}\n${await addr(cai)}\n`), extraName: "door.csv" });
  assert.deepEqual([doorOnly.plan.attendees, doorOnly.plan.share, doorOnly.plan.stakers], [[await addr(ana), await addr(cai)], E("0.015").toString(), 3]);
  assert.deepEqual(doorOnly.unknown, [await addr(ana), await addr(cai), await addr(dan)]); // nobody verified: the caller decides about Dan
  await assert.rejects(core.buildPayout({ prov, cfg, abi, checkins: null }), /Give the Luma export after the event, a door list, or both/);

  // the plan is what the contract accepts: post it, wait out the challenge window, pay
  await (await kick.connect(owner).postAttendance(p.plan.attendees, BigInt(p.plan.share))).wait();
  // once the list is posted: nobody can be registered or have their stake refunded; an unregistered payer still can
  o = await overview();
  assert.deepEqual(o.rows.filter((x) => ["Ana", "Pat"].includes(x[0])), [["Ana", "registered", "0.01", "VERIFIED", false, false], ["Pat", "unregistered", "0.01", "VERIFIED", false, true]]);
  await prov.send("evm_increaseTime", [core.CHALLENGE_PERIOD + 60]);
  await prov.send("evm_mine", []);
  const before = await Promise.all([ana, cai, dan].map(async (w) => prov.getBalance(await addr(w))));
  await (await kick.connect(owner).releasePayouts()).wait();
  const after = await Promise.all([ana, cai, dan].map(async (w) => prov.getBalance(await addr(w))));
  assert.deepEqual(after.map((x, i) => x - before[i]), [E("0.015"), E("0.015"), 0n]);
  fs.rmSync(dir, { recursive: true, force: true });
});
