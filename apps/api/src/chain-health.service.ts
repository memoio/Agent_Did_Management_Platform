import { Injectable, OnApplicationBootstrap } from "@nestjs/common";
import { Interface, JsonRpcProvider, formatEther, getAddress } from "ethers";
import {
  BundlerClientV07,
  ChainWriteGuard,
  RpcEndpoint,
} from "../../../packages/aa-client/src/index.js";
import { ENTRY_POINT_V07 } from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "./config.service.js";

const ENTRY_POINT = new Interface(["function balanceOf(address account) view returns (uint256)"]);
const SIMPLE_ACCOUNT = new Interface(["function owner() view returns (address)"]);

@Injectable()
export class ChainHealthService implements OnApplicationBootstrap {
  private readonly primary: RpcEndpoint;
  private readonly secondary: RpcEndpoint;
  private readonly bundler: BundlerClientV07;
  private readonly guard: ChainWriteGuard;
  private readonly provider: JsonRpcProvider;
  private lastGuard?: { checkedAt: string; result: unknown };

  constructor(private readonly config: RuntimeConfigService) {
    this.primary = new RpcEndpoint(config.value.primaryRpcUrl);
    this.secondary = new RpcEndpoint(config.value.secondaryRpcUrl);
    this.bundler = new BundlerClientV07(new RpcEndpoint(config.value.bundlerUrl));
    this.guard = new ChainWriteGuard(this.primary, this.secondary, config.value.manifest, {
      expectedEntryPointCodeHash: config.value.entryPointCodeHash,
    });
    this.provider = new JsonRpcProvider(config.value.primaryRpcUrl, 985, { staticNetwork: true });
  }

  async onApplicationBootstrap(): Promise<void> {
    if (process.env.MEMO_SKIP_STARTUP_CHAIN_GUARD === "true") {
      if (this.config.value.environment !== "local" && process.env.NODE_ENV !== "test") throw new Error("CHAIN_GUARD_BYPASS_FORBIDDEN");
      return;
    }
    await this.assertWritable();
  }

  async assertWritable() {
    const result = await this.guard.verify();
    await this.bundler.assertSupported();
    const ownerData = await this.provider.call({
      to: this.config.value.manifest.relayerSmartAccount.address,
      data: SIMPLE_ACCOUNT.encodeFunctionData("owner"),
    });
    const owner = getAddress(SIMPLE_ACCOUNT.decodeFunctionResult("owner", ownerData)[0] as string);
    if (owner !== getAddress(this.config.value.manifest.relayerSmartAccount.ownerAddress)) {
      throw new Error("RELAYER_SMART_ACCOUNT_OWNER_MISMATCH");
    }
    this.lastGuard = { checkedAt: new Date().toISOString(), result };
    return { ...result, relayerSmartAccountOwner: owner };
  }

  async health() {
    const result = await this.assertWritable();
    const account = this.config.value.manifest.relayerSmartAccount.address;
    const [balance, depositData, executorBalance] = await Promise.all([
      this.provider.getBalance(account),
      this.provider.call({ to: ENTRY_POINT_V07, data: ENTRY_POINT.encodeFunctionData("balanceOf", [account]) }),
      this.config.value.bundlerExecutorAddress
        ? this.provider.getBalance(this.config.value.bundlerExecutorAddress)
        : Promise.resolve(undefined),
    ]);
    const deposit = ENTRY_POINT.decodeFunctionResult("balanceOf", depositData)[0] as bigint;
    return {
      status: "ok",
      chain: result,
      bundler: {
        entryPointVersion: "0.7",
        safeModeRequired: true,
        ...(executorBalance === undefined ? {} : {
          executorBalanceWei: executorBalance.toString(),
          executorBalanceHealthy: executorBalance >= this.config.value.minBundlerExecutorBalanceWei,
        }),
      },
      relayerSmartAccount: {
        address: account,
        ownerAddress: this.config.value.manifest.relayerSmartAccount.ownerAddress,
        ownerProvider: this.config.value.manifest.relayerSmartAccount.ownerProvider,
        runtimeCodeHash: this.config.value.manifest.relayerSmartAccount.runtimeCodeHash,
        balanceWei: balance.toString(),
        balance: formatEther(balance),
        entryPointDepositWei: deposit.toString(),
        depositHealthy: deposit >= this.config.value.minEntryPointDepositWei,
      },
      lastGuard: this.lastGuard,
    };
  }

  async latestBlock() {
    const block = await this.provider.getBlock("latest");
    if (!block) throw new Error("CHAIN_HEAD_UNAVAILABLE");
    return { number: block.number, hash: block.hash, parentHash: block.parentHash, timestamp: block.timestamp };
  }

  async transaction(hash: string) {
    const [transaction, receipt] = await Promise.all([
      this.provider.getTransaction(hash),
      this.provider.getTransactionReceipt(hash),
    ]);
    if (!transaction) throw new Error("TRANSACTION_NOT_FOUND");
    return {
      hash: transaction.hash,
      from: transaction.from,
      to: transaction.to,
      nonce: transaction.nonce,
      data: transaction.data,
      value: transaction.value.toString(),
      receipt: receipt ? {
        blockNumber: receipt.blockNumber,
        blockHash: receipt.blockHash,
        gasUsed: receipt.gasUsed.toString(),
        gasPrice: receipt.gasPrice.toString(),
        feeWei: (receipt.gasUsed * receipt.gasPrice).toString(),
        status: receipt.status,
      } : null,
    };
  }
}
