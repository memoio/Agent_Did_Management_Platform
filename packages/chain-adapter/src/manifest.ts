import { Ajv2020 } from "ajv/dist/2020.js";
import addFormatsModule from "ajv-formats";
import { getAddress } from "ethers";
import schema from "../../../specs/chain-integration-v1/deployment-manifest.schema.json" with { type: "json" };
import intentSchema from "../../../specs/chain-integration-v1/action-intent.schema.json" with { type: "json" };
import eventSchema from "../../../specs/chain-integration-v1/normalized-event.schema.json" with { type: "json" };
import { type Domain, sha256 } from "./protocol.js";
import { requireChain } from "./errors.js";
import didArtifact from "../../contracts/artifacts/AgentDIDRegistry.abi.json" with { type: "json" };
import managementArtifact from "../../contracts/artifacts/AgentManagementRegistry.abi.json" with { type: "json" };

const ajv = new Ajv2020({ strict: false });
const addFormats = addFormatsModule as unknown as (a: Ajv2020) => void;
addFormats(ajv);
const manifestValidator = ajv.compile(schema);
export const intentValidator = ajv.compile(intentSchema);
export const eventValidator = ajv.compile(eventSchema);
export const abis = {
  didRegistry: didArtifact,
  managementRegistry: managementArtifact,
};
export interface ContractManifest {
  address: string;
  interfaceVersion: string;
  runtimeCodeHash: string;
  abiSha256: string;
  deploymentTxHash: string;
  deploymentBlockNumber: number;
  deploymentBlockHash: string;
  domain: Domain;
}
export interface DeploymentManifest {
  schema: "memo.agent-chain-deployment/1";
  deploymentId: string;
  environment: "testnet";
  network: {
    name: string;
    caip2: string;
    chainId: number;
    genesisHash: string;
    publicRpcUrl: string;
    publicWssUrl?: string;
    explorerUrl: string;
    nativeCurrency: { name: string; symbol: string; decimals: number };
  };
  contracts: {
    didRegistry: ContractManifest;
    managementRegistry: ContractManifest;
  };
  finality: {
    mode: "finalized-tag" | "confirmations";
    fallbackConfirmations: number;
    maxReorgDepth: number;
  };
  transport: { kind: "direct-relayer" };
  sourceCommit: string;
  createdAt: string;
}
export function validateManifest(value: unknown): DeploymentManifest {
  requireChain(manifestValidator(value), "DEPLOYMENT_MISMATCH");
  const m = structuredClone(value) as unknown as DeploymentManifest;
  requireChain(
    m.network.chainId === 5611 &&
      m.network.caip2 === "eip155:5611" &&
      m.transport.kind === "direct-relayer",
    "NETWORK_MISMATCH",
  );
  requireChain(BigInt(m.network.genesisHash) !== 0n, "DEPLOYMENT_MISMATCH");
  for (const key of ["didRegistry", "managementRegistry"] as const) {
    const c = m.contracts[key];
    requireChain(
      c.interfaceVersion === "1" &&
        BigInt(c.address) !== 0n &&
        BigInt(c.runtimeCodeHash) !== 0n &&
        BigInt(c.deploymentTxHash) !== 0n &&
        BigInt(c.deploymentBlockHash) !== 0n,
      "DEPLOYMENT_MISMATCH",
    );
    requireChain(
      c.domain.chainId === m.network.chainId &&
        getAddress(c.domain.verifyingContract) === getAddress(c.address) &&
        c.domain.version === "1" &&
        c.domain.name ===
          (key === "didRegistry"
            ? "MEMO Agent DID Registry"
            : "MEMO Agent DID Management"),
      "DEPLOYMENT_MISMATCH",
    );
    // ABI files are released with exact pretty-printed bytes plus a trailing LF.
    requireChain(
      c.abiSha256 === sha256(JSON.stringify(abis[key], null, 2) + "\n"),
      "DEPLOYMENT_MISMATCH",
    );
  }
  requireChain(
    getAddress(m.contracts.didRegistry.address) !==
      getAddress(m.contracts.managementRegistry.address),
    "DEPLOYMENT_MISMATCH",
  );
  for (const uri of [
    m.network.publicRpcUrl,
    m.network.publicWssUrl,
    m.network.explorerUrl,
  ].filter(Boolean) as string[]) {
    const url = new URL(uri);
    requireChain(
      !url.username && !url.password && !url.search && !url.hash,
      "DEPLOYMENT_MISMATCH",
    );
  }
  return m;
}
