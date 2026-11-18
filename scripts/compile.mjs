// Compiles the contracts with solc-js (no downloads) into build/*.json, plus the standard-JSON input used to verify
// the source on Etherscan (compiler 0.8.28, optimizer 200 runs, EVM paris).
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const production = ["PresenceCaseWriter.sol", "PresenceEvent.sol", "PresenceFactory.sol"];
const files = {
  ...Object.fromEntries(production.map((f) => [f, path.join(root, "contracts", f)])),
  "test/MockKleros.sol": path.join(root, "test/mocks/MockKleros.sol"),
  "test/TestWallet.sol": path.join(root, "test/mocks/TestWallet.sol"),
  "test/TestToken.sol": path.join(root, "test/mocks/TestToken.sol"),
};
const settings = {
  optimizer: { enabled: true, runs: 200 },
  evmVersion: "paris",
  outputSelection: { "*": { "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object"] } },
};
const input = {
  language: "Solidity",
  sources: Object.fromEntries(Object.entries(files).map(([k, p]) => [k, { content: fs.readFileSync(p, "utf8") }])),
  settings,
};
const out = JSON.parse(solc.compile(JSON.stringify(input), { import: (p) => ({ contents: fs.readFileSync(path.join(root, "contracts", p), "utf8") }) }));
for (const e of out.errors || []) if (e.severity === "error" || !/Unreachable|shadows/.test(e.message)) console.error(e.formattedMessage);
if ((out.errors || []).some((e) => e.severity === "error")) process.exit(1);

const build = path.join(root, "build");
fs.rmSync(build, { recursive: true, force: true });
fs.mkdirSync(build, { recursive: true });
fs.writeFileSync(
  path.join(build, "standard-input.json"),
  JSON.stringify({ ...input, sources: Object.fromEntries(production.map((f) => [f, input.sources[f]])) }, null, 2)
);
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    const runtime = c.evm.deployedBytecode.object.length / 2;
    fs.writeFileSync(path.join(build, `${name}.json`), JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2));
    console.log(`compiled ${file}:${name} (${runtime} bytes)`);
    if (production.includes(file) && runtime > 24576) {
      console.error(`${name} is over the 24 KB contract size limit`);
      process.exit(1);
    }
  }
}
