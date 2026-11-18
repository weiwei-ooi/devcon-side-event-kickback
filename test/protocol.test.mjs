// The shared JS helpers: the case template split, the IPFS path (checked against known `ipfs add` results),
// the UTC and amount texts the contract writes, and the organiser form check.
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ethers } from "ethers";
import { caseTemplate, renderCase, sampleFacts, ipfsCidV0, utcText, decimalText, jsonSafe, eventConfig, SLOT } from "../scripts/protocol.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const TEMPLATE = fs.readFileSync(path.join(root, "docs/metaevidence.template.json"), "utf8");
const V = { policyURI: "/ipfs/QmPolicy/attendance-policy.md", network: "Ethereum mainnet", explorer: "https://etherscan.io" };

test("IPFS CIDv0 matches `ipfs add` for known files", () => {
  assert.equal(ipfsCidV0("hello world\n"), "QmT78zSuBmuS4z925WZfrqQ1qHaJ56DQaTfyMUF7F8ff5o");
});

test("texts: UTC dates and amounts as the contract writes them", () => {
  assert.equal(utcText(0), "1970-01-01 00:00 UTC");
  assert.equal(utcText(1793800000), "2026-11-04 13:46 UTC");
  assert.equal(decimalText(10n ** 16n, 18), "0.01");
  assert.equal(decimalText(25_000_000n, 6), "25");
  assert.equal(decimalText(1n, 18), "0.000000000000000001");
  assert.ok(jsonSafe("Truth & Justice: Night 1 (Mumbai) – dinner"));
  assert.ok(!jsonSafe('a "b"') && !jsonSafe("a\\b") && !jsonSafe("a\nb"));
});

test("template: the repo's template splits into pieces and slots and renders valid ERC-1497 JSON", () => {
  const t = caseTemplate(TEMPLATE, V);
  const slots = [...ethers.getBytes(t.slots)];
  for (const k of ["wallet", "walletLower", "contract", "organiser", "organiserLower", "eventName", "eventStart", "eventEnd", "deposit"]) assert.ok(slots.includes(SLOT[k]), k);
  const meta = JSON.parse(renderCase(t, sampleFacts()));
  assert.equal(meta.fileURI, V.policyURI);
  assert.deepEqual(meta.rulingOptions.titles, ["Attended", "Did not attend"]);
  assert.ok(meta.question.includes(ethers.getAddress(sampleFacts().staker)));
  assert.throws(() => caseTemplate(TEMPLATE, { ...V, policyURI: "" }), /policyURI/);
  assert.throws(() => caseTemplate(TEMPLATE.replace("{{eventName}}", "{{nope}}"), V), /Unknown placeholder/);
  assert.throws(() => caseTemplate(TEMPLATE.replaceAll("{{wallet}}", "x"), V), /wallet/);
});

test("organiser form: plain messages for common mistakes", () => {
  const t = 1_800_000_000;
  const ok = { name: "Night", depositAmount: 1n, eventStart: t + 10, eventEnd: t + 20, claimDeadline: t + 20 + 7 * 86400 };
  assert.equal(eventConfig(ok, t).capacity, 0);
  assert.throws(() => eventConfig({ ...ok, name: "" }, t), /name/);
  assert.throws(() => eventConfig({ ...ok, url: "http://x" }, t), /https/);
  assert.throws(() => eventConfig({ ...ok, depositAmount: 0n }, t), /more than 0/);
  assert.throws(() => eventConfig({ ...ok, eventEnd: t + 5 }, t), /end after/);
  assert.throws(() => eventConfig({ ...ok, eventStart: t - 30, eventEnd: t - 20 }, t), /past/);
  assert.throws(() => eventConfig({ ...ok, claimDeadline: t + 30 }, t), /7 days/);
});
