import {
  Interface,
  JsonRpcProvider,
  Wallet,
  concat,
  getBytes,
  getAddress,
  isHexString,
  keccak256,
  toBeHex,
  zeroPadValue,
  verifyMessage,
} from "ethers";
import { randomUUID } from "node:crypto";
import { entryPoint07Address } from "viem/account-abstraction";
import { createPublicClient, defineChain, http, type Address, type PublicClient } from "viem";
import { getAccountNonce } from "permissionless/actions";
import {
  CHAIN_ID,
  ENTRY_POINT_V07,
  type DeploymentManifest,
  nonZeroAddress,
} from "../../protocol/src/index.js";

export interface JsonRpcRequest {
  method: string;
  params?: unknown[];
}

export class RpcEndpoint {
  private nextId = 1;

  constructor(
    readonly url: string,
    private readonly fetcher: typeof fetch = fetch,
  ) {}

  async request<T>(method: string, params: unknown[] = []): Promise<T> {
    const response = await this.fetcher(this.url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: this.nextId++, method, params }),
    });
    let payload: { result?: T; error?: { code: number; message: string; data?: unknown } };
    try {
      payload = await response.json() as typeof payload;
    } catch {
      throw new Error("RPC_HTTP_" + response.status);
    }
    if (payload.error) {
      const error = new Error(payload.error.message) as Error & { code?: number; data?: unknown };
      error.code = payload.error.code;
      error.data = payload.error.data;
      throw error;
    }
    if (!response.ok) throw new Error("RPC_HTTP_" + response.status);
    return payload.result as T;
  }
}

export interface ChainGuardOptions {
  expectedEntryPointCodeHash: string;
  maxHeadDistance?: number;
}

export interface ChainGuardResult {
  chainId: number;
  primaryHead: number;
  secondaryHead: number;
  entryPointCodeHash: string;
  simpleAccountFactoryCodeHash: string;
  relayerSmartAccountCodeHash: string;
  registryCodeHash: string;
  managementRegistryCodeHash: string;
}

export class ChainWriteGuard {
  constructor(
    private readonly primary: RpcEndpoint,
    private readonly secondary: RpcEndpoint,
    private readonly manifest: DeploymentManifest,
    private readonly options: ChainGuardOptions,
  ) {}

  async verify(): Promise<ChainGuardResult> {
    const [primaryChain, secondaryChain, primaryHeadHex, secondaryHeadHex] = await Promise.all([
      this.primary.request<string>("eth_chainId"),
      this.secondary.request<string>("eth_chainId"),
      this.primary.request<string>("eth_blockNumber"),
      this.secondary.request<string>("eth_blockNumber"),
    ]);
    const primaryChainId = Number(BigInt(primaryChain));
    const secondaryChainId = Number(BigInt(secondaryChain));
    if (primaryChainId !== CHAIN_ID || secondaryChainId !== CHAIN_ID) throw new Error("CHAIN_ID_MISMATCH");
    const primaryHead = Number(BigInt(primaryHeadHex));
    const secondaryHead = Number(BigInt(secondaryHeadHex));
    if (Math.abs(primaryHead - secondaryHead) > (this.options.maxHeadDistance ?? 3)) {
      throw new Error("RPC_HEAD_DIVERGENCE");
    }
    const compareBlock = Math.min(primaryHead, secondaryHead);
    if (compareBlock > 0) {
      const blockTag = toBeHex(compareBlock);
      const [a, b] = await Promise.all([
        this.primary.request<{ hash: string }>("eth_getBlockByNumber", [blockTag, false]),
        this.secondary.request<{ hash: string }>("eth_getBlockByNumber", [blockTag, false]),
      ]);
      if (!a?.hash || !b?.hash || a.hash.toLowerCase() !== b.hash.toLowerCase()) throw new Error("RPC_CANONICAL_HEAD_MISMATCH");
    }
    const [entryPointCode, factoryCode, smartAccountCode, registryCode, managementCode] = await Promise.all([
      this.primary.request<string>("eth_getCode", [ENTRY_POINT_V07, "latest"]),
      this.primary.request<string>("eth_getCode", [this.manifest.simpleAccountFactory.address, "latest"]),
      this.primary.request<string>("eth_getCode", [this.manifest.relayerSmartAccount.address, "latest"]),
      this.primary.request<string>("eth_getCode", [this.manifest.didRegistry.address, "latest"]),
      this.primary.request<string>("eth_getCode", [this.manifest.managementRegistry.address, "latest"]),
    ]);
    const entryPointCodeHash = runtimeHash(entryPointCode, "ENTRYPOINT_NOT_DEPLOYED");
    const simpleAccountFactoryCodeHash = runtimeHash(factoryCode, "SIMPLE_ACCOUNT_FACTORY_NOT_DEPLOYED");
    const relayerSmartAccountCodeHash = runtimeHash(smartAccountCode, "RELAYER_SMART_ACCOUNT_NOT_DEPLOYED");
    const registryCodeHash = runtimeHash(registryCode, "DID_REGISTRY_NOT_DEPLOYED");
    const managementRegistryCodeHash = runtimeHash(managementCode, "MANAGEMENT_REGISTRY_NOT_DEPLOYED");
    assertHash(entryPointCodeHash, this.options.expectedEntryPointCodeHash, "ENTRYPOINT_CODE_HASH_MISMATCH");
    assertHash(
      simpleAccountFactoryCodeHash,
      this.manifest.simpleAccountFactory.runtimeCodeHash,
      "SIMPLE_ACCOUNT_FACTORY_CODE_HASH_MISMATCH",
    );
    assertHash(
      relayerSmartAccountCodeHash,
      this.manifest.relayerSmartAccount.runtimeCodeHash,
      "RELAYER_SMART_ACCOUNT_CODE_HASH_MISMATCH",
    );
    assertHash(registryCodeHash, this.manifest.didRegistry.runtimeCodeHash, "DID_REGISTRY_CODE_HASH_MISMATCH");
    assertHash(
      managementRegistryCodeHash,
      this.manifest.managementRegistry.runtimeCodeHash,
      "MANAGEMENT_REGISTRY_CODE_HASH_MISMATCH",
    );
    return {
      chainId: primaryChainId,
      primaryHead,
      secondaryHead,
      entryPointCodeHash,
      simpleAccountFactoryCodeHash,
      relayerSmartAccountCodeHash,
      registryCodeHash,
      managementRegistryCodeHash,
    };
  }
}

function runtimeHash(code: string, missingCode: string): string {
  if (!isHexString(code) || code === "0x") throw new Error(missingCode);
  return keccak256(code);
}

function assertHash(actual: string, expected: string, code: string): void {
  if (!/^0x[0-9a-fA-F]{64}$/.test(expected) || actual.toLowerCase() !== expected.toLowerCase()) throw new Error(code);
}

export interface UserOperationV07 {
  sender: string;
  nonce: string;
  factory?: string;
  factoryData?: string;
  callData: string;
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  maxFeePerGas: string;
  maxPriorityFeePerGas: string;
  paymaster?: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
  paymasterData?: string;
  signature: string;
}

export interface UserOperationGasEstimate {
  callGasLimit: string;
  verificationGasLimit: string;
  preVerificationGas: string;
  paymasterVerificationGasLimit?: string;
  paymasterPostOpGasLimit?: string;
}

export interface UserOperationReceiptV07 {
  userOpHash: string;
  entryPoint: string;
  sender: string;
  nonce: string;
  actualGasCost: string;
  actualGasUsed: string;
  success: boolean;
  reason?: string;
  receipt: {
    transactionHash: string;
    blockHash: string;
    blockNumber: string;
    status: string;
    logs: Array<Record<string, unknown>>;
  };
}

export class BundlerClientV07 {
  constructor(
    private readonly rpc: RpcEndpoint,
    readonly entryPoint: string = ENTRY_POINT_V07,
  ) {
    if (getAddress(entryPoint07Address) !== getAddress(ENTRY_POINT_V07) || getAddress(entryPoint) !== getAddress(ENTRY_POINT_V07)) {
      throw new Error("ENTRYPOINT_VERSION_NOT_V07");
    }
  }

  async assertSupported(): Promise<void> {
    const values = await this.rpc.request<string[]>("eth_supportedEntryPoints");
    if (!values.some((value) => getAddress(value) === getAddress(this.entryPoint))) {
      throw new Error("BUNDLER_ENTRYPOINT_UNSUPPORTED");
    }
  }

  estimate(userOperation: UserOperationV07): Promise<UserOperationGasEstimate> {
    return this.rpc.request("eth_estimateUserOperationGas", [userOperation, this.entryPoint]);
  }

  send(userOperation: UserOperationV07): Promise<string> {
    return this.rpc.request("eth_sendUserOperation", [userOperation, this.entryPoint]);
  }

  receipt(userOpHash: string): Promise<UserOperationReceiptV07 | null> {
    return this.rpc.request("eth_getUserOperationReceipt", [userOpHash]);
  }

  byHash(userOpHash: string): Promise<Record<string, unknown> | null> {
    return this.rpc.request("eth_getUserOperationByHash", [userOpHash]);
  }
}

export interface UserOperationSigner {
  readonly address: string;
  signDigest(digest: string): Promise<string>;
}

export class DevelopmentPrivateKeySigner implements UserOperationSigner {
  private readonly wallet: Wallet;

  constructor(privateKey: string, rpcUrl?: string, allowDockerLocalNetwork = false) {
    if (process.env.NODE_ENV === "production") throw new Error("DEV_PRIVATE_KEY_FORBIDDEN_IN_PRODUCTION");
    if (!privateKey || !/^0x[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error("INVALID_DEV_RELAYER_PRIVATE_KEY");
    const loopback = rpcUrl ? /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(rpcUrl) : true;
    const isolatedDockerNetwork = rpcUrl === "http://anvil:8545" && allowDockerLocalNetwork;
    if (!loopback && !isolatedDockerNetwork) {
      throw new Error("DEV_PRIVATE_KEY_REQUIRES_LOOPBACK_RPC");
    }
    this.wallet = new Wallet(privateKey);
  }

  get address(): string {
    return this.wallet.address;
  }

  async signDigest(digest: string): Promise<string> {
    return this.wallet.signMessage(getBytes(digest));
  }
}

export interface KmsDigestSigner extends UserOperationSigner {
  readonly keyId: string;
  readonly provider: "kms" | "hsm";
}

export interface RemoteKmsSignerOptions {
  provider: "kms" | "hsm";
  keyId: string;
  address: string;
  endpoint: string;
  bearerToken?: string;
  fetcher?: typeof fetch;
}

/**
 * Adapter for a private KMS/HSM signing bridge. The bridge signs the EIP-191
 * hash used by SimpleAccount v0.7 and returns a canonical 65-byte Ethereum
 * signature. The private key never enters this process.
 */
export class RemoteKmsDigestSigner implements KmsDigestSigner {
  readonly provider: "kms" | "hsm";
  readonly keyId: string;
  readonly address: string;
  private readonly endpoint: string;
  private readonly bearerToken?: string;
  private readonly fetcher: typeof fetch;

  constructor(options: RemoteKmsSignerOptions) {
    const endpoint = new URL(options.endpoint);
    if (endpoint.protocol !== "https:") throw new Error("KMS_SIGNER_ENDPOINT_REQUIRES_HTTPS");
    this.provider = options.provider;
    this.keyId = options.keyId;
    this.address = getAddress(options.address);
    this.endpoint = endpoint.toString();
    this.bearerToken = options.bearerToken;
    this.fetcher = options.fetcher || fetch;
  }

  async signDigest(digest: string): Promise<string> {
    if (!isHexString(digest, 32)) throw new Error("INVALID_USER_OPERATION_DIGEST");
    const response = await this.fetcher(this.endpoint, {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10_000),
      headers: {
        "content-type": "application/json",
        ...(this.bearerToken ? { authorization: `Bearer ${this.bearerToken}` } : {}),
      },
      body: JSON.stringify({
        requestId: "sign_" + randomUUID(),
        provider: this.provider,
        keyId: this.keyId,
        algorithm: "secp256k1-eip191",
        digest,
      }),
    });
    if (!response.ok) throw new Error("KMS_SIGNER_HTTP_" + response.status);
    const payload = await response.json() as { signature?: string; address?: string };
    if (!payload.signature || !isHexString(payload.signature, 65)) throw new Error("KMS_SIGNER_INVALID_SIGNATURE");
    if (payload.address && getAddress(payload.address) !== this.address) throw new Error("KMS_SIGNER_ADDRESS_MISMATCH");
    if (getAddress(verifyMessage(getBytes(digest), payload.signature)) !== this.address) {
      throw new Error("KMS_SIGNER_SIGNATURE_RECOVERY_MISMATCH");
    }
    return payload.signature;
  }
}

const SIMPLE_ACCOUNT = new Interface(["function execute(address dest,uint256 value,bytes func)"]);
const ENTRY_POINT = new Interface([
  "function getNonce(address sender,uint192 key) view returns (uint256)",
  "function getUserOpHash((address sender,uint256 nonce,bytes initCode,bytes callData,bytes32 accountGasLimits,uint256 preVerificationGas,bytes32 gasFees,bytes paymasterAndData,bytes signature) userOp) view returns (bytes32)",
  "function balanceOf(address account) view returns (uint256)",
]);

export interface BuildUserOperationInput {
  sender: string;
  target: string;
  targetCallData: string;
  factory?: string;
  factoryData?: string;
  maxFeePerGas: bigint;
  maxPriorityFeePerGas: bigint;
}

export class SimpleAccountV07Client {
  private readonly provider: JsonRpcProvider;
  private readonly viemClient: PublicClient;

  constructor(
    rpcUrl: string,
    private readonly bundler: BundlerClientV07,
    private readonly signer: UserOperationSigner,
  ) {
    this.provider = new JsonRpcProvider(rpcUrl, CHAIN_ID, { staticNetwork: true });
    this.viemClient = createPublicClient({
      chain: defineChain({
        id: CHAIN_ID,
        name: "MEMO Mainnet",
        nativeCurrency: { name: "MEMO", symbol: "MEMO", decimals: 18 },
        rpcUrls: { default: { http: [rpcUrl] } },
      }),
      transport: http(rpcUrl),
    });
  }

  async buildAndSign(input: BuildUserOperationInput): Promise<UserOperationV07> {
    const sender = nonZeroAddress(input.sender);
    const target = nonZeroAddress(input.target);
    const nonce = await getAccountNonce(this.viemClient, {
      address: sender as Address,
      entryPointAddress: ENTRY_POINT_V07,
      key: 0n,
    });
    const unsigned: UserOperationV07 = {
      sender,
      nonce: toBeHex(nonce),
      ...(input.factory ? { factory: nonZeroAddress(input.factory), factoryData: input.factoryData ?? "0x" } : {}),
      callData: SIMPLE_ACCOUNT.encodeFunctionData("execute", [target, 0, input.targetCallData]),
      callGasLimit: "0x0",
      verificationGasLimit: "0x0",
      preVerificationGas: "0x0",
      maxFeePerGas: toBeHex(input.maxFeePerGas),
      maxPriorityFeePerGas: toBeHex(input.maxPriorityFeePerGas),
      signature: dummySignature(),
    };
    const estimate = await this.bundler.estimate(unsigned);
    const estimated: UserOperationV07 = {
      ...unsigned,
      callGasLimit: estimate.callGasLimit,
      verificationGasLimit: estimate.verificationGasLimit,
      preVerificationGas: estimate.preVerificationGas,
    };
    const hash = await this.getUserOperationHash(estimated);
    return { ...estimated, signature: await this.signer.signDigest(hash) };
  }

  async send(input: BuildUserOperationInput): Promise<{ userOpHash: string; operation: UserOperationV07 }> {
    const operation = await this.buildAndSign(input);
    return { userOpHash: await this.bundler.send(operation), operation };
  }

  async entryPointDeposit(account: string): Promise<bigint> {
    const result = await this.provider.call({
      to: ENTRY_POINT_V07,
      data: ENTRY_POINT.encodeFunctionData("balanceOf", [nonZeroAddress(account)]),
    });
    return ENTRY_POINT.decodeFunctionResult("balanceOf", result)[0] as bigint;
  }

  private async getUserOperationHash(operation: UserOperationV07): Promise<string> {
    const packed = packUserOperation(operation);
    const result = await this.provider.call({
      to: ENTRY_POINT_V07,
      data: ENTRY_POINT.encodeFunctionData("getUserOpHash", [packed]),
    });
    return ENTRY_POINT.decodeFunctionResult("getUserOpHash", result)[0] as string;
  }
}

export function packUserOperation(operation: UserOperationV07) {
  if (operation.paymaster) throw new Error("PAYMASTER_FORBIDDEN");
  const initCode = operation.factory
    ? concat([nonZeroAddress(operation.factory), operation.factoryData ?? "0x"])
    : "0x";
  return {
    sender: nonZeroAddress(operation.sender),
    nonce: BigInt(operation.nonce),
    initCode,
    callData: operation.callData,
    accountGasLimits: packUint128Pair(BigInt(operation.verificationGasLimit), BigInt(operation.callGasLimit)),
    preVerificationGas: BigInt(operation.preVerificationGas),
    gasFees: packUint128Pair(BigInt(operation.maxPriorityFeePerGas), BigInt(operation.maxFeePerGas)),
    paymasterAndData: "0x",
    signature: operation.signature,
  };
}

function packUint128Pair(high: bigint, low: bigint): string {
  const max = (1n << 128n) - 1n;
  if (high < 0n || low < 0n || high > max || low > max) throw new Error("UINT128_OVERFLOW");
  return toBeHex((high << 128n) | low, 32);
}

function dummySignature(): string {
  return concat([zeroPadValue("0x01", 32), zeroPadValue("0x01", 32), "0x1b"]);
}
