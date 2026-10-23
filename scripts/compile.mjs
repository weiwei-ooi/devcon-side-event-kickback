// Compiles the contracts with solc-js (no external downloads) into build/*.json
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import solc from "solc";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const files = {
  "GroundTruthKickback.sol": path.join(root, "contracts/GroundTruthKickback.sol"),
  "MockUSDC.sol": path.join(root, "test/MockUSDC.sol"),
};

const input = {
  language: "Solidity",
  sources: Object.fromEntries(
    Object.entries(files).map(([k, p]) => [k, { content: fs.readFileSync(p, "utf8") }])
  ),
  settings: {
    optimizer: { enabled: true, runs: 200 },
    evmVersion: "paris", // safe across L2s
    outputSelection: { "*": { "*": ["abi", "evm.bytecode.object"] } },
  },
};

const out = JSON.parse(solc.compile(JSON.stringify(input)));
const errors = (out.errors || []).filter((e) => e.severity === "error");
for (const e of out.errors || []) console.error(e.formattedMessage);
if (errors.length) process.exit(1);

fs.mkdirSync(path.join(root, "build"), { recursive: true });
// For "Verify & Publish" on Arbiscan (Solidity standard-JSON input, compiler v0.8.24)
fs.writeFileSync(
  path.join(root, "build", "GroundTruthKickback.standard-input.json"),
  JSON.stringify({ ...input, sources: { "GroundTruthKickback.sol": input.sources["GroundTruthKickback.sol"] } }, null, 2)
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
