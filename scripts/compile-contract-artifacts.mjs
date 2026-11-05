import { readFile, mkdir, writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import solc from "solc";

const expectedVersion = "0.8.37";
if (!solc.version().startsWith(expectedVersion + "+")) {
  throw new Error(`SOLC_VERSION_MISMATCH:${solc.version()}`);
}

const contracts = [
  ["packages/contracts/src/AgentDIDRegistryV1.sol", "AgentDIDRegistryV1"],
  ["packages/contracts/src/AgentManagementRegistryV1.sol", "AgentManagementRegistryV1"],
];
const sources = Object.fromEntries(await Promise.all(contracts.map(async ([sourceName]) => [
  sourceName,
  { content: await readFile(resolve(sourceName), "utf8") },
])));

const input = {
  language: "Solidity",
  sources,
  settings: {
    optimizer: { enabled: true, runs: 200 },
    viaIR: true,
    evmVersion: "paris",
    metadata: { bytecodeHash: "ipfs" },
    outputSelection: {
      "*": {
        "*": ["abi", "evm.bytecode.object", "evm.deployedBytecode.object", "metadata"],
      },
    },
  },
};

const output = JSON.parse(solc.compile(JSON.stringify(input), { import: resolveImport }));
const errors = (output.errors || []).filter((entry) => entry.severity === "error");
if (errors.length > 0) {
  throw new Error(errors.map((entry) => entry.formattedMessage).join("\n"));
}

for (const [sourceName, contractName] of contracts) {
  const compiled = output.contracts?.[sourceName]?.[contractName];
  if (!compiled?.evm?.bytecode?.object || !compiled?.evm?.deployedBytecode?.object) {
    throw new Error(`CONTRACT_ARTIFACT_MISSING:${contractName}`);
  }
  const artifact = {
    _format: "memo-solc-js-artifact-1",
    contractName,
    sourceName,
    compiler: { version: solc.version(), evmVersion: "paris", viaIR: true },
    abi: compiled.abi,
    bytecode: `0x${compiled.evm.bytecode.object}`,
    deployedBytecode: `0x${compiled.evm.deployedBytecode.object}`,
    metadata: compiled.metadata,
  };
  const outputPath = resolve(`packages/contracts/out/${contractName}.sol/${contractName}.json`);
  await mkdir(dirname(outputPath), { recursive: true });
  await writeFile(outputPath, JSON.stringify(artifact, null, 2) + "\n", { mode: 0o644 });
}

process.stdout.write(JSON.stringify({
  compiled: contracts.map(([, contractName]) => contractName),
  solc: solc.version(),
  evmVersion: "paris",
}) + "\n");

function resolveImport(importPath) {
  const mapped = importPath.startsWith("@openzeppelin/contracts/")
    ? importPath.replace("@openzeppelin/contracts/", "node_modules/@openzeppelin/contracts-paris/")
    : importPath.startsWith("@account-abstraction/")
      ? importPath.replace("@account-abstraction/", "node_modules/@account-abstraction/")
      : importPath;
  try {
    return { contents: readFileSyncUtf8(resolve(mapped)) };
  } catch {
    return { error: `IMPORT_NOT_FOUND:${importPath}` };
  }
}

function readFileSyncUtf8(path) {
  // solc's import callback is synchronous by design.
  return readFileSync(path, "utf8");
}
