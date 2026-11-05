import { Injectable } from "@nestjs/common";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAddress } from "ethers";
import {
  ENTRY_POINT_V07_RUNTIME_CODE_HASH,
  assertDeploymentManifest,
  type DeploymentManifest,
  type Environment,
} from "../../../packages/protocol/src/index.js";

export interface RuntimeConfig {
  environment: Environment;
  port: number;
  primaryRpcUrl: string;
  secondaryRpcUrl: string;
  bundlerUrl: string;
  dataRoot: string;
  sessionSigningKey: string;
  requiredConfirmations: number;
  entryPointCodeHash: string;
  platformOrigins: string[];
  minEntryPointDepositWei: bigint;
  minBundlerExecutorBalanceWei: bigint;
  bundlerExecutorAddress?: string;
  manifestPath: string;
  manifest: DeploymentManifest;
}

@Injectable()
export class RuntimeConfigService {
  readonly value: RuntimeConfig;

  constructor(injected?: RuntimeConfig) {
    this.value = injected ?? loadRuntimeConfig(process.env);
  }

  publicChainConfig() {
    const manifest = this.value.manifest;
    const didDomain = {
      name: "MEMO Agent DID Registry",
      version: "1",
      chainId: manifest.chainId,
      verifyingContract: manifest.didRegistry.address,
    };
    const managementDomain = {
      name: "MEMO Agent DID Management",
      version: "1",
      chainId: manifest.chainId,
      verifyingContract: manifest.managementRegistry.address,
    };
    return {
      chainId: manifest.chainId,
      networkName: manifest.networkName,
      environment: manifest.environment,
      rpcUrl: manifest.publicRpcUrl,
      wssUrl: manifest.publicWssUrl || null,
      nativeCurrency: manifest.nativeCurrency,
      entryPoint: manifest.entryPoint,
      simpleAccountFactory: manifest.simpleAccountFactory,
      relayerSmartAccount: manifest.relayerSmartAccount.address,
      relayerSmartAccountDetails: {
        address: manifest.relayerSmartAccount.address,
        ownerAddress: manifest.relayerSmartAccount.ownerAddress,
        ownerProvider: manifest.relayerSmartAccount.ownerProvider,
        runtimeCodeHash: manifest.relayerSmartAccount.runtimeCodeHash,
      },
      didRegistry: {
        address: manifest.didRegistry.address,
        deploymentBlock: manifest.didRegistry.deploymentBlock,
        domain: didDomain,
      },
      managementRegistry: {
        address: manifest.managementRegistry.address,
        deploymentBlock: manifest.managementRegistry.deploymentBlock,
        domain: managementDomain,
      },
      contracts: {
        agentDidRegistry: { address: manifest.didRegistry.address, domain: didDomain },
        agentManagementRegistry: { address: manifest.managementRegistry.address, domain: managementDomain },
      },
      deploymentBlock: Math.min(manifest.didRegistry.deploymentBlock, manifest.managementRegistry.deploymentBlock),
      requiredConfirmations: this.value.requiredConfirmations,
      finality: manifest.finality,
      walletAddChainEnabled: process.env.MEMO_ALLOW_WALLET_ADD_CHAIN === "true",
    };
  }
}

export function loadRuntimeConfig(env: NodeJS.ProcessEnv): RuntimeConfig {
  const environment = (env.MEMO_ENVIRONMENT || "local") as Environment;
  if (!["local", "preprod", "production"].includes(environment)) throw new Error("INVALID_ENVIRONMENT");
  // This preprod release intentionally ships only the phase-one SQLite/file
  // persistence adapters. Never let an operator mistake those for the phase-two
  // PostgreSQL/S3 production stack. Contract deployment has its own separately
  // acknowledged command and is not affected by this runtime gate.
  if (environment === "production") throw new Error("PRODUCTION_RUNTIME_REQUIRES_POSTGRES_S3_ADAPTERS");
  const manifestPath = resolve(env.MEMO_DEPLOYMENT_MANIFEST || "deploy/local/985.json");
  const manifest = assertDeploymentManifest(JSON.parse(readFileSync(manifestPath, "utf8")));
  if (manifest.environment !== environment) throw new Error("MANIFEST_ENVIRONMENT_MISMATCH");
  const primaryRpcUrl = required(env.MEMO_PRIMARY_RPC_URL, "MEMO_PRIMARY_RPC_URL");
  const secondaryRpcUrl = required(env.MEMO_SECONDARY_RPC_URL, "MEMO_SECONDARY_RPC_URL");
  const bundlerUrl = required(env.MEMO_BUNDLER_URL, "MEMO_BUNDLER_URL");
  if (environment !== "local") {
    for (const value of [primaryRpcUrl, secondaryRpcUrl, bundlerUrl]) {
      if (!value.startsWith("https://")) throw new Error("PRODUCTION_ENDPOINT_REQUIRES_HTTPS");
    }
    if (primaryRpcUrl === secondaryRpcUrl) throw new Error("SECONDARY_RPC_MUST_BE_INDEPENDENT");
  }
  const requiredConfirmations = positiveInt(
    env.MEMO_REQUIRED_CONFIRMATIONS || String(manifest.finality.fallbackConfirmations),
    "MEMO_REQUIRED_CONFIRMATIONS",
  );
  const sessionSigningKey = required(env.MEMO_SESSION_SIGNING_KEY, "MEMO_SESSION_SIGNING_KEY");
  if (sessionSigningKey.length < 32) throw new Error("SESSION_SIGNING_KEY_TOO_SHORT");
  const bundlerExecutorAddress = env.MEMO_BUNDLER_EXECUTOR_ADDRESS
    ? getAddress(env.MEMO_BUNDLER_EXECUTOR_ADDRESS)
    : undefined;
  if (environment !== "local" && !bundlerExecutorAddress) throw new Error("MISSING_CONFIG:MEMO_BUNDLER_EXECUTOR_ADDRESS");
  return {
    environment,
    port: positiveInt(env.PORT || "4273", "PORT"),
    primaryRpcUrl,
    secondaryRpcUrl,
    bundlerUrl,
    dataRoot: resolve(env.MEMO_DATA_ROOT || ".data/local"),
    sessionSigningKey,
    requiredConfirmations,
    entryPointCodeHash: env.MEMO_ENTRYPOINT_CODE_HASH
      || manifest.entryPoint.runtimeCodeHash
      || ENTRY_POINT_V07_RUNTIME_CODE_HASH,
    platformOrigins: (env.MEMO_PLATFORM_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean),
    minEntryPointDepositWei: BigInt(env.MEMO_MIN_ENTRYPOINT_DEPOSIT_WEI || "100000000000000000"),
    minBundlerExecutorBalanceWei: BigInt(env.MEMO_MIN_BUNDLER_EXECUTOR_BALANCE_WEI || "100000000000000000"),
    bundlerExecutorAddress,
    manifestPath,
    manifest,
  };
}

function required(value: string | undefined, name: string): string {
  if (!value) throw new Error("MISSING_CONFIG:" + name);
  return value;
}

function positiveInt(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new Error("INVALID_CONFIG:" + name);
  return parsed;
}
