// Local chain (ganache) with stand-ins for Kleros Court v1 (KlerosLiquid) and its Dispute Resolver, and a deployed
// Proof of Presence protocol. Shared by the contract tests and the web page tests.
import fs from "node:fs";
import path from "node:path";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import ganache from "ganache";
import { ethers } from "ethers";
import { deployProtocol, extraDataOf } from "../scripts/protocol.mjs";

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const load = (n) => JSON.parse(fs.readFileSync(path.join(root, "build", `${n}.json`), "utf8"));
export const E = (x) => ethers.parseEther(String(x));
export const DAY = 86400;
export const FEE_PER_JUROR = E("0.005");
export const FEE = 3n * FEE_PER_JUROR;
export const EXTRA = extraDataOf(0, 3);
export const POLICY = "/ipfs/QmPolicyForTestsXXXXXXXXXXXXXXXXXXXXXXXXXXXXX/attendance-policy.md";
export const KGAS = { gasLimit: 500_000 };
export const keyOf = (i) => "0x" + (i + 1).toString(16).padStart(64, "0");

export async function startChain({ port, accounts = 40, chainId = 1337 } = {}) {
  const server = ganache.server({
    logging: { quiet: true },
    chain: { chainId },
    miner: { blockGasLimit: 60_000_000 },
    wallet: { accounts: Array.from({ length: accounts }, (_, i) => ({ secretKey: keyOf(i), balance: "0x56BC75E2D63100000" })) },
  });
  await server.listen(port);
  const prov = new ethers.JsonRpcProvider(`http://127.0.0.1:${port}`, chainId, { staticNetwork: true, cacheTimeout: -1 });
  prov.pollingInterval = 50;
  // ganache estimates exactly the gas used; real wallets add a margin
  const estimate = prov.estimateGas.bind(prov);
  prov.estimateGas = async (tx) => ((await estimate(tx)) * 13n) / 10n;
  const wallets = Array.from({ length: accounts }, (_, i) => new ethers.NonceManager(new ethers.Wallet(keyOf(i), prov)));
  return { server, prov, wallets };
}

export async function deploy(name, signer, ...params) {
  const { abi, bytecode } = load(name);
  const c = await new ethers.ContractFactory(abi, bytecode, signer).deploy(...params);
  await c.waitForDeployment();
  return c;
}

/** Kleros stand-ins plus the protocol (case writer, implementation, factory). */
export async function deployAll(owner, { challengePeriod = DAY, matchPeriod = DAY } = {}) {
  const liquid = await deploy("MockKlerosLiquid", owner);
  await (await liquid.setFeeForJuror(FEE_PER_JUROR, KGAS)).wait();
  const proxy = await deploy("MockArbitrableProxy", owner, liquid.target);
  const templateText = fs.readFileSync(path.join(root, "docs/metaevidence.template.json"), "utf8");
  const artifacts = Object.fromEntries(["PresenceCaseWriter", "PresenceEvent", "PresenceFactory"].map((n) => [n, load(n)]));
  const d = await deployProtocol(owner, artifacts, {
    disputeResolver: proxy.target,
    extraData: EXTRA,
    policyURI: POLICY,
    templateText,
    network: "Test chain",
    explorer: "https://explorer.example",
    challengePeriod,
    matchPeriod,
  });
  const factory = new ethers.Contract(d.factory, artifacts.PresenceFactory.abi, owner);
  return { ...d, liquid, proxy, factory, factoryAddress: d.factory, artifacts };
}

export const eventAbi = () => load("PresenceEvent").abi;
export const iface = () => new ethers.Interface([...load("PresenceEvent").abi, ...load("PresenceFactory").abi, ...load("PresenceCaseWriter").abi]);

/** The custom error behind a failed call. */
export function errName(e, i = iface()) {
  if (e.revert?.name) return e.revert.name;
  const data = e.data ?? e.info?.error?.data;
  try {
    return i.parseError(data ?? "0x")?.name;
  } catch {
    return undefined;
  }
}

export async function reverts(contract, method, params, errorName) {
  try {
    await contract[method].staticCall(...params);
  } catch (e) {
    assert.equal(errName(e), errorName, `expected ${errorName}, got ${errName(e) ?? e.shortMessage}`);
    return;
  }
  assert.fail(`${method} did not revert (expected ${errorName})`);
}
