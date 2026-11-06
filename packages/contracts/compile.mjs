import fs from "node:fs";
import path from "node:path";
import solc from "solc";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
export function compile() {
  const directory = path.join(root, "packages/contracts/src");
  const sources = Object.fromEntries(
    fs
      .readdirSync(directory)
      .filter((n) => n.endsWith(".sol"))
      .map((n) => [
        n,
        { content: fs.readFileSync(path.join(directory, n), "utf8") },
      ]),
  );
  const input = {
    language: "Solidity",
    sources,
    settings: {
      optimizer: { enabled: true, runs: 200 },
      viaIR: true,
      evmVersion: "paris",
      outputSelection: {
        "*": {
          "*": [
            "abi",
            "evm.bytecode.object",
            "evm.deployedBytecode.object",
            "evm.deployedBytecode.immutableReferences",
          ],
        },
      },
    },
  };
  const output = JSON.parse(
    solc.compile(JSON.stringify(input), {
      import: (name) => {
        try {
          return {
            contents: fs.readFileSync(
              path.join(root, "node_modules", name),
              "utf8",
            ),
          };
        } catch {
          return { error: `Missing import ${name}` };
        }
      },
    }),
  );
  const errors = (output.errors ?? []).filter((e) => e.severity === "error");
  if (errors.length)
    throw new Error(errors.map((e) => e.formattedMessage).join("\n"));
  const artifacts = {};
  for (const name of ["AgentDIDRegistry", "AgentManagementRegistry"]) {
    const c = output.contracts[`${name}.sol`][name];
    artifacts[name] = {
      contractName: name,
      compiler: solc.version(),
      settings: input.settings,
      abi: c.abi,
      bytecode: `0x${c.evm.bytecode.object}`,
      runtimeBytecode: `0x${c.evm.deployedBytecode.object}`,
      immutableReferences: c.evm.deployedBytecode.immutableReferences,
    };
    const out = path.join(root, "packages/contracts/artifacts");
    fs.mkdirSync(out, { recursive: true });
    fs.writeFileSync(
      path.join(out, `${name}.json`),
      JSON.stringify(artifacts[name], null, 2) + "\n",
    );
    fs.writeFileSync(
      path.join(out, `${name}.abi.json`),
      JSON.stringify(c.abi, null, 2) + "\n",
    );
  }
  return artifacts;
}
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  compile();
  console.log(
    "Compiled Agent DID and Management registries (Solidity 0.8.28, EVM paris).",
  );
}
