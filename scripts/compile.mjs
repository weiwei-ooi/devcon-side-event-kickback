// Compiles the contracts with solc-js (no external downloads) into build/*.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "TruthPaysKickback.sol": path.join(root, "contracts/TruthPaysKickback.sol"),
  // test stand-ins: Kleros Court v1 (KlerosLiquid + Dispute Resolver), wallet contracts and a token
  "MockKleros.sol": path.join(root, "test/MockKleros.sol"),
  "TestWallet.sol": path.join(root, "test/TestWallet.sol"),
  "TestToken.sol": path.join(root, "test/TestToken.sol"),
};

const input = {
  language: "Solidity",
  sources: Object.fromEntries(
    Object.entries(files).map(([k, p]) => [k, { content: fs.readFileSync(p, "utf8") }])
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    // paris: the settings the contract is verified with on Etherscan (no PUSH0; runs on every test chain)
    evmVersion: "paris",
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(path.join(root, "build"), { recursive: true });
// start from an empty build folder, so a contract that was removed (e.g. the old USDC and Kleros v2 mocks) can't linger
for (const f of fs.readdirSync(path.join(root, "build"))) if (f.endsWith(".json")) fs.rmSync(path.join(root, "build", f));
// For "Verify & Publish" on Etherscan (Solidity standard-JSON input, compiler v0.8.28,
// optimizer on with 200 runs, EVM version paris)
fs.writeFileSync(
  path.join(root, "build", "TruthPaysKickback.standard-input.json"),
  JSON.stringify({ ...input, sources: { "TruthPaysKickback.sol": input.sources["TruthPaysKickback.sol"] } }, null, 2)
);
for (const [file, contracts] of Object.entries(out.contracts)) {
  for (const [name, c] of Object.entries(contracts)) {
    fs.writeFileSync(
      path.join(root, "build", `${name}.json`),
      JSON.stringify({ abi: c.abi, bytecode: "0x" + c.evm.bytecode.object }, null, 2)
    );
    console.log(`compiled ${file}:${name}`);
  }
}
