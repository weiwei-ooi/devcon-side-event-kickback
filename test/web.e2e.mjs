// Browser test of the pages (Playwright + a local chain): an organiser creates an event in the organiser panel, guests
// book on the deposit page (ETH and a token), one books during the event, the organiser pastes a check-in list and
// closes the list, a guest left off challenges, the organiser disputes it (the case description goes to a stand-in
// for Kleros's IPFS upload), payouts are released with the case's share set aside, the ruling comes, the case is
// settled and everyone is paid from the panel.
// Needs Playwright with Chromium (preinstalled in Claude's cloud sessions; elsewhere: npm i -g playwright && npx playwright install chromium).
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";
import { ethers } from "ethers";
import { startChain, deployAll, deploy, root, E, DAY, FEE, KGAS, keyOf } from "./helpers.mjs";
import { ipfsPathOf } from "../scripts/protocol.mjs";
import { serve } from "../scripts/serve.mjs";

const require = createRequire(import.meta.url);
let chromium;
try {
  ({ chromium } = require("playwright"));
} catch {
  ({ chromium } = require("/opt/node-tools/node_modules/playwright"));
}
const RPC_PORT = 18571, WEB_PORT = 18572;
const BASE = `http://127.0.0.1:${WEB_PORT}`;
const OUT = path.join(root, "dist-test");
let chain, P, browser, web, usdc;
const uploads = [];

before(async () => {
  chain = await startChain({ port: RPC_PORT, accounts: 12 });
  P = await deployAll(chain.wallets[0]);
  usdc = await deploy("TestToken", chain.wallets[0], "USDC", 6);
  const dep = { chainId: 1337, name: "Test chain", explorer: "https://explorer.example", rpcs: [`http://127.0.0.1:${RPC_PORT}`], factory: P.factoryAddress, implementation: P.implementation, ipfsUpload: `${BASE}/__upload`, ipfsGateway: `${BASE}/__ipfs`, kleros: { court: "https://court.example/cases/" } };
  fs.writeFileSync(path.join(root, "build", "test-deployment.json"), JSON.stringify(dep));
  execFileSync("node", [path.join(root, "scripts/build-web.mjs"), "--deployment", path.join(root, "build/test-deployment.json"), "--out", OUT]);
  web = await serve(OUT, WEB_PORT);
  browser = await chromium.launch();
});
after(async () => {
  await browser?.close();
  web?.close();
  await chain?.server.close();
  fs.rmSync(OUT, { recursive: true, force: true });
});

/** A page whose window.ethereum is account `i` of the local chain (ganache signs for unlocked accounts). */
async function pageFor(i) {
  const ctx = await browser.newContext();
  const page = await ctx.newPage();
  page.on("dialog", (d) => d.accept());
  page.on("pageerror", (e) => console.error("page error:", e.message));
  const account = new ethers.Wallet(keyOf(i)).address;
  await page.addInitScript(({ rpc, account }) => {
    let id = 0;
    const call = async (method, params = []) => {
      const r = await fetch(rpc, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) });
      const j = await r.json();
      if (j.error) throw Object.assign(new Error(j.error.message), { code: j.error.code, data: j.error.data });
      return j.result;
    };
    window.ethereum = {
      isMetaMask: true,
      on() {},
      async request({ method, params }) {
        if (method === "eth_requestAccounts" || method === "eth_accounts") return [account];
        if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
        if (method === "eth_sendTransaction") params = [{ ...params[0], from: account }];
        // ganache estimates exactly the gas used; real wallets add a margin
        if (method === "eth_estimateGas") return "0x" + ((BigInt(await call(method, params)) * 13n) / 10n).toString(16);
        return call(method, params);
      },
    };
  }, { rpc: `http://127.0.0.1:${RPC_PORT}`, account });
  // stand-in for Kleros's IPFS upload service and gateway
  await page.route(`${BASE}/__upload**`, async (route) => {
    const body = route.request().postDataBuffer().toString("utf8");
    const json = body.slice(body.indexOf("\r\n\r\n") + 4, body.lastIndexOf("\r\n--"));
    uploads.push(json);
    await route.fulfill({ json: { cids: [ipfsPathOf(json)] } });
  });
  await page.route(`${BASE}/__ipfs/**`, (route) => route.fulfill({ status: 200, body: "{}" }));
  return { page, account };
}
const warp = async (s) => {
  await chain.prov.send("evm_increaseTime", [s]);
  await chain.prov.send("evm_mine", []);
};
const chainNow = async () => (await chain.prov.getBlock("latest")).timestamp;
const local = (ts) => {
  const d = new Date(ts * 1000 - new Date(ts * 1000).getTimezoneOffset() * 60000);
  return d.toISOString().slice(0, 16);
};
async function waitNote(page, sel, re, timeout = 20000) {
  await page.waitForFunction(([s, r]) => new RegExp(r).test(document.querySelector(s)?.textContent ?? ""), [sel, re.source], { timeout });
}

test("organiser creates an event, guests book (also during the event), list, challenge, dispute, payout", async () => {
  const org = await pageFor(1);
  await org.page.goto(`${BASE}/organiser.html`);
  await org.page.click("#connect");
  await org.page.waitForFunction(() => document.querySelector("#connect").textContent.includes("…"));
  // the browser's clock and the chain's agree (ganache uses real time until we warp)
  const t = await chainNow();
  await org.page.fill("#fName", "Truth Pays: Test Dinner");
  await org.page.fill("#fUrl", "https://luma.com/test");
  await org.page.fill("#fStart", local(t + 3600));
  await org.page.fill("#fEnd", local(t + 3 * 3600));
  await org.page.fill("#fAmount", "0.01");
  await org.page.fill("#fCap", "10");
  await org.page.click("#create");
  await org.page.waitForURL(/organiser\.html\?e=0x/, { timeout: 30000 });
  const evAddr = new URL(org.page.url()).searchParams.get("e");
  await org.page.waitForSelector("#dash:not([hidden])");
  assert.match(await org.page.textContent("#name"), /Truth Pays: Test Dinner/);
  const guestLink = await org.page.inputValue("#guestLink");
  assert.match(guestLink, /event\.html\?e=0x/);
  const ev = new ethers.Contract(evAddr, P.artifacts.PresenceEvent.abi, chain.prov);
  assert.equal(await ev.owner(), org.account);

  // three guests book before the event
  const guests = [];
  for (const i of [2, 3, 4]) {
    const g = await pageFor(i);
    await g.page.goto(guestLink);
    await g.page.waitForSelector("#ev:not([hidden])");
    assert.match(await g.page.textContent("#deposit"), /0\.01 ETH/);
    await g.page.click("#connect");
    await g.page.waitForSelector("#pay:not([disabled])");
    await g.page.click("#pay");
    await waitNote(g.page, "#bookNote", /You're in/);
    assert.match(await g.page.inputValue("#txLink"), /^https:\/\/explorer\.example\/tx\/0x/);
    assert.equal(await g.page.getAttribute("#back", "href"), "https://luma.com/test");
    guests.push(g);
  }
  // a walk-in books while the event is running
  await warp(3600 + 1800);
  const walkIn = await pageFor(5);
  await walkIn.page.goto(guestLink);
  await walkIn.page.waitForSelector("#ev:not([hidden])");
  await walkIn.page.click("#connect");
  await walkIn.page.waitForSelector("#pay:not([disabled])");
  await walkIn.page.click("#pay");
  await waitNote(walkIn.page, "#bookNote", /You're in/);
  assert.equal(await ev.stakerCount(), 4n);

  // the event ends; the organiser pastes a check-in list (two guests + the walk-in) and closes the list
  await warp(2 * 3600);
  await org.page.reload();
  await org.page.click("#connect");
  await org.page.waitForSelector("#closeList:not([hidden])");
  await org.page.click("#pasteBox summary");
  await org.page.fill("#paste", `name,eth_address\nA,${guests[0].account}\nB,${guests[1].account}\nW,${walkIn.account}\nX,0x000000000000000000000000000000000000dEaD`);
  await org.page.click("#doPaste");
  await waitNote(org.page, "#pasteNote", /3 of the 4/);
  await org.page.click("#closeList");
  await waitNote(org.page, "#guestNote", /List closed/, 30000);
  assert.equal(await ev.phase(), 1n);
  assert.equal(await ev.attendeeCount(), 3n);

  // the guest left off challenges from the deposit page
  const left = guests[2];
  await left.page.reload();
  await left.page.waitForSelector("#ev:not([hidden])");
  await left.page.click("#connectTop");
  await left.page.waitForSelector("#challengeBox:not([hidden])");
  await left.page.click("#challenge");
  await waitNote(left.page, "#mineNote", /Challenge sent/, 30000);
  // the organiser disputes it: the case description is uploaded first, then the Kleros case opens
  await org.page.reload();
  await org.page.click("#connect");
  await org.page.waitForSelector("[data-match]");
  await org.page.click("[data-match]");
  await waitNote(org.page, "#chNote", /Kleros case opened/, 30000);
  const c = await ev.challenges(left.account);
  assert.equal(c.state, 2n);
  const [text] = await ev.caseMetaEvidence(left.account);
  assert.ok(uploads.includes(text), "the case description was uploaded byte for byte");
  // evidence from the guest's page goes to the Dispute Resolver
  await left.page.reload();
  await left.page.waitForSelector("#ev:not([hidden])");
  await left.page.click("#connectTop");
  await left.page.waitForSelector("#caseBox:not([hidden])");
  await left.page.click("#caseBox details summary");
  await left.page.fill("#evTitle", "Photo at the venue");
  await left.page.fill("#evText", "https://example.org/photo.jpg");
  await left.page.click("#sendEvidence");
  await waitNote(left.page, "#mineNote", /Evidence sent/, 30000);

  // the challenge window ends; payouts are released with one share set aside
  await warp(DAY + 60);
  await org.page.reload();
  await org.page.click("#connect");
  await org.page.waitForSelector("#release");
  await org.page.click("#release");
  await waitNote(org.page, "#nextNote", /Payouts released/, 30000);
  const share = (4n * E("0.01")) / 4n;
  assert.equal(await ev.payoutShare(), share);
  // jurors: did not attend. Settle, then send everyone their money
  await (await P.liquid.giveFinalRuling(c.arbitratorDisputeID, 2, KGAS)).wait();
  await org.page.reload();
  await org.page.click("#connect");
  await org.page.waitForSelector("[data-settle]");
  await org.page.click("[data-settle]");
  await waitNote(org.page, "#chNote", /Settled/, 30000);
  const b0 = await chain.prov.getBalance(guests[0].account);
  await org.page.waitForSelector("#pushAll");
  await org.page.click("#pushAll");
  await waitNote(org.page, "#nextNote", /Sent to 3 wallet/, 30000);
  const each = share + share / 3n;
  assert.equal(await chain.prov.getBalance(guests[0].account), b0 + each);
  assert.equal(await ev.reservedPool(), 0n);
  // the guest who lost sees it on the page
  await left.page.reload();
  await left.page.waitForSelector("#ev:not([hidden])");
  await left.page.click("#connectTop");
  await waitNote(left.page, "#caseText", /did not attend/);
});

test("token event: the deposit page asks for an approval, then the deposit", async () => {
  const t = await chainNow();
  const f = P.factory.connect(chain.wallets[1]);
  const r = await (await f.createEvent(["USDC Meetup", "", usdc.target, 25_000_000n, t + 600, t + 7200, t + 7200 + 8 * DAY, 0])).wait();
  const evAddr = r.logs.map((l) => { try { return f.interface.parseLog(l); } catch { return null; } }).find((x) => x?.name === "EventCreated").args.eventContract;
  const g = await pageFor(6);
  await (await usdc.connect(chain.wallets[0]).mint(g.account, 100_000_000n)).wait();
  await g.page.goto(`${BASE}/event.html?e=${evAddr}`);
  await g.page.waitForSelector("#ev:not([hidden])");
  assert.match(await g.page.textContent("#deposit"), /25 USDC/);
  await g.page.click("#connect");
  await g.page.waitForSelector("#approve:not([hidden])");
  await g.page.click("#approve");
  await waitNote(g.page, "#bookNote", /Approved/, 30000);
  await g.page.click("#pay");
  await waitNote(g.page, "#bookNote", /You're in/, 30000);
  assert.equal(await usdc.balanceOf(evAddr), 25_000_000n);
});

test("pages refuse addresses that are not this factory's events, and the home page lists events", async () => {
  const g = await pageFor(7);
  await g.page.goto(`${BASE}/event.html?e=${P.implementation}`);
  await waitNote(g.page, "#loadNote", /not an event created with Proof of Presence/);
  await g.page.goto(`${BASE}/event.html`);
  await waitNote(g.page, "#loadNote", /no event in it/);
  await g.page.goto(`${BASE}/`);
  await waitNote(g.page, "#recent", /USDC Meetup/);
});
