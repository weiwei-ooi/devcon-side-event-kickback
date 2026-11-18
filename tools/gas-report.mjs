import { startChain, deployAll, DAY } from "../test/helpers.mjs";
import { ethers } from "ethers";
const c = await startChain({ port: 18599, accounts: 3 });
const owner = c.wallets[0];
const P = await deployAll(owner);
for (const a of [P.caseWriter, P.implementation, P.factoryAddress]) {
  const logs = await c.prov.getCode(a); console.log(a, (logs.length-2)/2, "bytes");
}
let total = 0n;
for (let b = 0; b <= await c.prov.getBlockNumber(); b++) { const bl = await c.prov.getBlock(b, true); for (const h of bl.transactions) { const r = await c.prov.getTransactionReceipt(h); total += r.gasUsed; } }
console.log("total deploy gas incl. mocks", total);
const t = (await c.prov.getBlock("latest")).timestamp;
const r = await (await P.factory.createEvent(["Truth Pays: Queryable Data, Prediction Markets & Onchain Justice", "https://luma.com/qewnqhas", ethers.ZeroAddress, 10n**16n, t+100, t+5000, t+5000+14*DAY, 150])).wait();
console.log("createEvent gas", r.gasUsed);
await c.server.close();
