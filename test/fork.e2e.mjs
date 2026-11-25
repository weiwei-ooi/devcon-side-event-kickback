// End-to-end test on a LOCAL fork of Ethereum mainnet (never real mainnet), with the REAL Kleros contracts as they are
// at the fork block: Kleros's Dispute Resolver 0x4b89…82a4 and KlerosLiquid 0x988b…8069. It deploys the whole protocol,
// creates an event, takes deposits (one during the event), closes the list, opens a real Kleros case (paying the real
// arbitration fee), lets another challenge expire, releases payouts with the case's share set aside, delivers a ruling
// by impersonating KlerosLiquid (only possible on a fork) and checks everyone is paid to the wei.
//
//   FORK_URL=https://ethereum-rpc.publicnode.com npm run test:fork
//
// Needs network access to a mainnet RPC (not available in Claude's cloud container: run it on a laptop).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import ganache from "ganache";
import { ethers } from "ethers";
import { root, load, keyOf, DAY } from "./helpers.mjs";
import { deployProtocol, extraDataOf, NETWORKS, ipfsPathOf, renderCase } from "../scripts/protocol.mjs";

const FORK_URL = process.env.FORK_URL || "https://ethereum-rpc.publicnode.com";
const K = NETWORKS[1].kleros;
const LIQUID = ethers.getAddress(K.arbitrator);
const RESOLVER = ethers.getAddress(K.disputeResolver);
const PORT = 18581;
const D = ethers.parseEther("0.01");
let server, prov, w, P, ev;

before(async () => {
  server = ganache.server({
    logging: { quiet: true },
    fork: { url: FORK_URL },
    chain: { chainId: 1 },
    wallet: { accounts: Array.from({ length: 10 }, (_, i) => ({ secretKey: keyOf(i), balance: "0x56BC75E2D63100000" })), unlockedAccounts: [LIQUID] },
  });
  await server.listen(PORT);
  prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${PORT}`, 1, { staticNetwork: true, cacheTimeout: -1 });
  prov.pollingInterval = 100;
  w = Array.from({ length: 10 }, (_, i) => new ethers.NonceManager(new ethers.Wallet(keyOf(i), prov)));
  await prov.send("evm_setAccountBalance", [LIQUID, "0x56BC75E2D63100000"]).catch(() => {});
});
after(async () => server && (await server.close()));

const send = async (p) => (await p).wait();
const warp = async (s) => {
  await prov.send("evm_increaseTime", [s]);
  await prov.send("evm_mine", []);
};
const now = async () => (await prov.getBlock("latest")).timestamp;
const A = (s) => s.signer?.address ?? s.address;

test("deploy the protocol against the real Kleros Dispute Resolver", async () => {
  const artifacts = Object.fromEntries(["PresenceCaseWriter", "PresenceEvent", "PresenceFactory"].map((n) => [n, load(n)]));
  const templateText = fs.readFileSync(path.join(root, "docs/metaevidence.template.json"), "utf8");
  // POP_CASE_WRITER reuses a live case writer (as a v2 deploy does), with the policy it was made with
  const caseWriter = process.env.POP_CASE_WRITER || undefined;
  const policyURI = process.env.POP_POLICY || ipfsPathOf(fs.readFileSync(path.join(root, "docs/attendance-policy.md"), "utf8"));
  if (caseWriter) console.log(`# reusing case writer ${caseWriter}, policy ${policyURI}`);
  const gas = [];
  if (process.env.POP_FACTORY) {
    // test the LIVE deployment as it is on mainnet: no new contracts
    const f = new ethers.Contract(process.env.POP_FACTORY, artifacts.PresenceFactory.abi, prov);
    P = { factory: process.env.POP_FACTORY, implementation: await f.implementation() };
    console.log(`# live factory ${P.factory}, implementation ${P.implementation}`);
  } else P = await deployProtocol(w[0], artifacts, { disputeResolver: RESOLVER, extraData: extraDataOf(K.subcourt, K.jurors), policyURI, templateText, network: NETWORKS[1].name, explorer: NETWORKS[1].explorer, caseWriter }, (n, tx) => gas.push([n, tx.hash]));
  for (const [n, h] of gas) console.log(`# ${n}: ${(await prov.getTransactionReceipt(h)).gasUsed} gas`);
  P.factoryC = new ethers.Contract(P.factory, artifacts.PresenceFactory.abi, w[0]);
  const impl = new ethers.Contract(P.implementation, artifacts.PresenceEvent.abi, prov);
  assert.equal(await impl.arbitrator(), LIQUID);
  console.log(`# Kleros fee now: ${ethers.formatEther(await impl.challengeDeposit())} ETH`);
});

test("a full event on mainnet Kleros: deposits until the end, list, real case, payout, ruling", async () => {
  const t = await now();
  const r = await send(P.factoryC.connect(w[1]).createEvent(["Fork Night", "https://luma.com/fork", ethers.ZeroAddress, D, t + 3600, t + 4 * 3600, t + 4 * 3600 + 14 * DAY, 0]));
  console.log(`# createEvent: ${r.gasUsed} gas`);
  const log = r.logs.map((l) => { try { return P.factoryC.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "EventCreated");
  ev = new ethers.Contract(log.args.eventContract, load("PresenceEvent").abi, w[1]);
  const g = w.slice(2, 8);
  for (const x of g.slice(0, 5)) await send(x.sendTransaction({ to: ev.target, value: D }));
  await warp(2 * 3600); // during the event
  await send(ev.connect(g[5]).deposit({ value: D }));
  await warp(2 * 3600 + 1);
  await send(ev.postAttendance([A(g[0]), A(g[1]), A(g[5])], true));
  const fee = await ev.challengeDeposit();
  await send(ev.connect(g[2]).challenge({ value: fee }));
  await send(ev.connect(g[3]).challenge({ value: fee }));
  const m = await send(ev.matchChallenge(A(g[2]), { value: fee }));
  console.log(`# matchChallenge (opens a real Kleros case): ${m.gasUsed} gas`);
  const c = await ev.challenges(A(g[2]));
  const resolver = new ethers.Contract(RESOLVER, ["function disputes(uint256) view returns (bytes, bool isRuled, uint256 ruling, uint256 disputeIDOnArbitratorSide)", "function rule(uint256,uint256)", "event MetaEvidence(uint256 indexed _metaEvidenceID, string _evidence)"], prov);
  const d = await resolver.disputes(c.localDisputeID);
  assert.equal(d.disputeIDOnArbitratorSide, c.arbitratorDisputeID);
  const [text, uri] = await ev.caseMetaEvidence(A(g[2]));
  assert.equal(uri, ipfsPathOf(text));
  const me = (await prov.getLogs({ address: RESOLVER, fromBlock: m.blockNumber, toBlock: m.blockNumber })).map((l) => { try { return resolver.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "MetaEvidence");
  assert.equal(me.args._evidence, uri);
  assert.ok(JSON.parse(text).description.includes("0.01 ETH"));
  const st = await ev.appealStatus(A(g[2])); // evidence period: no appeal yet
  assert.equal(st.end, 0n);
  void renderCase;
  // g3's challenge is not matched: after both windows it counts as attended
  await warp(DAY + 60);
  await send(ev.connect(g[4]).releasePayouts([A(g[3])]));
  const pool = 6n * D;
  const share = pool / 5n; // g0, g1, g5, g3 + one share set aside for g2's case
  assert.equal(await ev.payoutShare(), share);
  // Kleros rules "did not attend" (impersonated KlerosLiquid delivering the ruling to the Dispute Resolver)
  const liquidSigner = await prov.getSigner(LIQUID);
  await send(resolver.connect(liquidSigner).rule(c.arbitratorDisputeID, 2));
  const owner0 = await prov.getBalance(A(w[1]));
  await send(ev.connect(g[4]).resolveChallenge(A(g[2])));
  assert.equal(await prov.getBalance(A(w[1])), owner0 + 2n * fee - c.arbitrationPaid); // the matcher wins the rest
  const each = share + share / 4n;
  const finalList = [g[0], g[1], g[5], g[3]];
  const b0 = await Promise.all(finalList.map((x) => prov.getBalance(A(x))));
  await send(ev.connect(g[4]).distribute(finalList.map(A)));
  for (const [i, x] of finalList.entries()) assert.equal(await prov.getBalance(A(x)), b0[i] + each);
  assert.equal(await ev.reservedPool(), 0n);
  assert.ok((await prov.getBalance(ev.target)) <= 4n);
});
