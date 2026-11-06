import {
  Contract,
  Interface,
  JsonRpcProvider,
  Transaction,
  getAddress,
  isHexString,
  keccak256,
  recoverAddress,
  type Signer,
  type BlockTag,
  type Log,
} from "ethers";
import { randomUUID } from "node:crypto";
import { ChainError, requireChain, rpc } from "./errors.js";
import {
  abis,
  validateManifest,
  intentValidator,
  eventValidator,
  type DeploymentManifest,
} from "./manifest.js";
import {
  actionDefinition,
  hashJson,
  makeIntent,
  sha256,
  toDid,
  type ActionType,
  type ActionSignature,
  type Intent,
  type Message,
  type Snapshot,
} from "./protocol.js";
import type { Submission, SubmissionJournal } from "./journal.js";

const statuses = ["NONE", "ACTIVE", "SUSPENDED", "REVOKED"];
export interface AdapterOptions {
  manifest: unknown;
  primary: JsonRpcProvider;
  secondary: JsonRpcProvider;
  signer?: Signer;
  journal?: SubmissionJournal;
  minimumBalance?: bigint;
  signerHealth?: () => Promise<boolean>;
  gasPriceCap?: bigint;
  gasLimitCap?: bigint;
  logChunkSize?: number;
  allowFinalityFallback?: boolean;
}
export class OpbnbChainAdapter {
  readonly manifest: DeploymentManifest;
  private readonly interfaces = {
    didRegistry: new Interface(abis.didRegistry),
    managementRegistry: new Interface(abis.managementRegistry),
  };
  constructor(private readonly options: AdapterOptions) {
    this.manifest = validateManifest(options.manifest);
    requireChain(options.primary !== options.secondary, "NETWORK_MISMATCH");
    requireChain(
      Number.isSafeInteger(options.logChunkSize ?? 200) &&
        (options.logChunkSize ?? 200) >= 1 &&
        (options.logChunkSize ?? 200) <= 2000,
    );
  }
  private get providers() {
    return [this.options.primary, this.options.secondary];
  }
  private async network(): Promise<void> {
    await rpc(async () => {
      for (const p of this.providers) {
        requireChain(
          BigInt(await p.send("eth_chainId", [])) === 5611n,
          "NETWORK_MISMATCH",
        );
        requireChain(
          (await p.getBlock(0))?.hash?.toLowerCase() ===
            this.manifest.network.genesisHash.toLowerCase(),
          "NETWORK_MISMATCH",
        );
      }
    });
  }
  private async agreedBlock(
    tag: BlockTag = "latest",
  ): Promise<Snapshot & { parentHash: string }> {
    return rpc(async () => {
      let target = tag;
      if (tag === "latest") {
        const heads = await Promise.all(
          this.providers.map((p) => p.getBlock("latest")),
        );
        requireChain(heads.every(Boolean), "CHAIN_STATE_UNCERTAIN");
        target = Math.min(...heads.map((b) => b!.number));
      }
      const [a, b] = await Promise.all(
        this.providers.map((p) => p.getBlock(target)),
      );
      requireChain(
        a && b && a.hash && a.hash === b.hash && a.number === b.number,
        "CHAIN_STATE_UNCERTAIN",
      );
      return {
        blockNumber: a.number,
        blockHash: a.hash,
        timestamp: a.timestamp,
        parentHash: a.parentHash,
      };
    });
  }
  async verifyDeployment() {
    await this.network();
    const head = await this.agreedBlock();
    await rpc(async () => {
      for (const key of ["didRegistry", "managementRegistry"] as const) {
        const c = this.manifest.contracts[key];
        const block = await this.agreedBlock(c.deploymentBlockNumber);
        requireChain(
          block.blockHash.toLowerCase() === c.deploymentBlockHash.toLowerCase(),
          "DEPLOYMENT_MISMATCH",
        );
        for (const p of this.providers) {
          const code = await p.getCode(c.address, head.blockNumber);
          requireChain(
            code !== "0x" &&
              keccak256(code).toLowerCase() === c.runtimeCodeHash.toLowerCase(),
            "DEPLOYMENT_MISMATCH",
          );
          const receipt = await p.getTransactionReceipt(c.deploymentTxHash);
          requireChain(
            receipt?.status === 1 &&
              receipt.blockHash.toLowerCase() ===
                c.deploymentBlockHash.toLowerCase() &&
              receipt.contractAddress &&
              getAddress(receipt.contractAddress) === getAddress(c.address),
            "DEPLOYMENT_MISMATCH",
          );
          const contract = new Contract(c.address, abis[key], p);
          const domain = await contract.eip712Domain({
            blockTag: head.blockNumber,
          });
          requireChain(
            domain[0] === "0x0f" &&
              domain[1] === c.domain.name &&
              domain[2] === "1" &&
              domain[3] === 5611n &&
              getAddress(domain[4]) === getAddress(c.address),
            "DEPLOYMENT_MISMATCH",
          );
        }
      }
      const registry = await this.call(
        "managementRegistry",
        "didRegistry",
        [],
        head,
      );
      requireChain(
        getAddress(registry[0]) ===
          getAddress(this.manifest.contracts.didRegistry.address),
        "DEPLOYMENT_MISMATCH",
      );
    });
    requireChain(
      (await this.agreedBlock(head.blockNumber)).blockHash === head.blockHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    return {
      verified: true as const,
      deploymentId: this.manifest.deploymentId,
      networkId: this.manifest.network.caip2,
      head,
      checkedAt: new Date().toISOString(),
    };
  }
  async readiness() {
    const verification = await this.verifyDeployment();
    requireChain(
      this.options.signer &&
        this.options.journal &&
        this.options.signerHealth &&
        this.options.minimumBalance !== undefined &&
        this.options.minimumBalance > 0n &&
        this.options.gasPriceCap &&
        this.options.gasPriceCap > 0n &&
        this.options.gasLimitCap &&
        this.options.gasLimitCap > 0n,
      "CHAIN_STATE_UNCERTAIN",
    );
    requireChain(
      await rpc(() => this.options.signerHealth!()),
      "CHAIN_STATE_UNCERTAIN",
    );
    const address = await rpc(() => this.options.signer!.getAddress());
    const balances = await rpc(() =>
      Promise.all(this.providers.map((p) => p.getBalance(address))),
    );
    requireChain(
      balances.every((b) => b >= this.options.minimumBalance!),
      "INSUFFICIENT_FUNDS",
    );
    return {
      ...verification,
      relayer: address,
      balance: balances.reduce((a, b) => (a < b ? a : b)).toString(),
    };
  }
  private async call(
    key: keyof typeof abis,
    method: string,
    args: unknown[],
    block: Snapshot,
  ) {
    return rpc(async () => {
      const data = this.interfaces[key].encodeFunctionData(method, args);
      const values = await Promise.all(
        this.providers.map((p) =>
          p.call({
            to: this.manifest.contracts[key].address,
            data,
            blockTag: block.blockNumber,
          }),
        ),
      );
      requireChain(
        values[0] === values[1] &&
          (await this.agreedBlock(block.blockNumber)).blockHash ===
            block.blockHash,
        "CHAIN_STATE_UNCERTAIN",
      );
      return this.interfaces[key].decodeFunctionResult(method, values[0]);
    });
  }
  async readBlock(tag: BlockTag = "latest") {
    await this.network();
    return this.agreedBlock(tag);
  }
  async readIdentity(address: string, tag: BlockTag = "latest") {
    await this.verifyDeployment();
    return this.identityAt(address, await this.agreedBlock(tag));
  }
  private async identityAt(address: string, block: Snapshot) {
    const r = await this.call(
      "didRegistry",
      "identities",
      [getAddress(address)],
      block,
    );
    return {
      identityAccount: getAddress(address),
      status: statuses[Number(r[0])],
      revision: r[1].toString(),
      nonce: r[2].toString(),
      identityPublicKeyHash: r[3] as string,
      documentHash: r[4] as string,
      profileHash: r[5] as string,
      source: block,
    };
  }
  async readRelationship(agent: string, tag: BlockTag = "latest") {
    await this.verifyDeployment();
    return this.relationshipAt(agent, await this.agreedBlock(tag));
  }
  private async relationshipAt(agent: string, block: Snapshot) {
    const [r, identity] = await Promise.all([
      this.call(
        "managementRegistry",
        "relationships",
        [getAddress(agent)],
        block,
      ),
      this.identityAt(agent, block),
    ]);
    return {
      manager: r[0] as string,
      relationshipIdHash: r[1] as string,
      scopesHash: r[2] as string,
      expiresAt: r[3].toString(),
      discoverable: r[4] as boolean,
      ended: r[5] as boolean,
      revision: r[6].toString(),
      nonce: r[7].toString(),
      live:
        identity.status === "ACTIVE" && !r[5] && r[3] > BigInt(block.timestamp),
      source: block,
    };
  }
  async readCredentialRevocation(
    agent: string,
    credentialIdHash: string,
    tag: BlockTag = "latest",
  ) {
    await this.verifyDeployment();
    const source = await this.agreedBlock(tag);
    const r = await this.call(
      "didRegistry",
      "revokedCredentials",
      [getAddress(agent), credentialIdHash],
      source,
    );
    return { revoked: r[0] as boolean, source };
  }
  async buildIntent(
    actionType: ActionType,
    payload: Message,
    intentId = randomUUID(),
    ttlSeconds = 300,
  ): Promise<Intent> {
    await this.verifyDeployment();
    requireChain(
      Number.isSafeInteger(ttlSeconds) && ttlSeconds > 0 && ttlSeconds <= 900,
    );
    const block = await this.agreedBlock();
    const chainSnapshot: Snapshot = {
      blockNumber: block.blockNumber,
      blockHash: block.blockHash,
      timestamp: block.timestamp,
    };
    const definition = actionDefinition(actionType);
    const domainKey =
      definition.domain === "identity" ? "didRegistry" : "managementRegistry";
    requireChain(
      !["nonce", "expectedRevision", "deadline"].some((k) =>
        Object.hasOwn(payload, k),
      ),
    );
    const agent = payload[
      domainKey === "didRegistry" ? "identityAccount" : "agent"
    ] as string;
    const state =
      domainKey === "didRegistry"
        ? await this.identityAt(agent, block)
        : await this.relationshipAt(agent, block);
    return makeIntent({
      intentId,
      deploymentId: this.manifest.deploymentId,
      actionType,
      domain: this.manifest.contracts[domainKey].domain,
      message: {
        ...payload,
        expectedRevision: state.revision,
        nonce: state.nonce,
        deadline: String(block.timestamp + ttlSeconds),
      },
      chainSnapshot,
    });
  }
  private checkedIntent(intent: Intent) {
    requireChain(intentValidator(intent));
    const d = actionDefinition(intent.actionType);
    const key = d.domain === "identity" ? "didRegistry" : "managementRegistry";
    requireChain(
      intent.deploymentId === this.manifest.deploymentId &&
        intent.networkId === this.manifest.network.caip2,
      "DEPLOYMENT_MISMATCH",
    );
    requireChain(
      hashJson(intent.domain) === hashJson(this.manifest.contracts[key].domain),
      "INVALID_SIGNATURE",
    );
    const rebuilt = makeIntent({
      ...intent,
      domain: this.manifest.contracts[key].domain,
    });
    requireChain(
      hashJson(intent.types) === hashJson(rebuilt.types) &&
        hashJson(intent.requiredSigners) ===
          hashJson(rebuilt.requiredSigners) &&
        intent.digest === rebuilt.digest,
      "INVALID_SIGNATURE",
    );
    return { key, definition: d } as const;
  }
  async verifySignedAction(intent: Intent, signatures: ActionSignature[]) {
    const { key } = this.checkedIntent(intent);
    await this.verifyDeployment();
    const block = await this.agreedBlock();
    requireChain(
      BigInt(intent.message.deadline as string) >= BigInt(block.timestamp),
      "ACTION_EXPIRED",
    );
    requireChain(
      (await this.agreedBlock(intent.chainSnapshot.blockNumber)).blockHash ===
        intent.chainSnapshot.blockHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    const agent = intent.message[
      key === "didRegistry" ? "identityAccount" : "agent"
    ] as string;
    const state =
      key === "didRegistry"
        ? await this.identityAt(agent, block)
        : await this.relationshipAt(agent, block);
    requireChain(
      state.nonce === intent.message.nonce &&
        state.revision === intent.message.expectedRevision,
      "NONCE_CONFLICT",
    );
    requireChain(
      Array.isArray(signatures) &&
        signatures.length === intent.requiredSigners.length,
      "INVALID_SIGNATURE",
    );
    for (const required of intent.requiredSigners) {
      const matches = signatures.filter(
        (s) =>
          s &&
          s.role === required.role &&
          typeof s.address === "string" &&
          /^0x[0-9a-fA-F]{40}$/.test(s.address) &&
          s.address.toLowerCase() === required.address.toLowerCase(),
      );
      requireChain(
        matches.length === 1 && isHexString(matches[0].signature),
        "INVALID_SIGNATURE",
      );
      const signature = matches[0].signature;
      const codes = await rpc(() =>
        Promise.all(
          this.providers.map((p) =>
            p.getCode(required.address, block.blockNumber),
          ),
        ),
      );
      requireChain(codes[0] === codes[1], "CHAIN_STATE_UNCERTAIN");
      const code = codes[0];
      if (required.role === "agent")
        requireChain(code === "0x", "INVALID_SIGNATURE");
      if (code === "0x") {
        try {
          requireChain(
            getAddress(recoverAddress(intent.digest, signature)) ===
              getAddress(required.address),
            "INVALID_SIGNATURE",
          );
        } catch {
          throw new ChainError("INVALID_SIGNATURE");
        }
      } else {
        const checker = new Interface([
          "function isValidSignature(bytes32,bytes) view returns(bytes4)",
        ]);
        const data = checker.encodeFunctionData("isValidSignature", [
          intent.digest,
          signature,
        ]);
        let answers: string[];
        try {
          answers = await Promise.all(
            this.providers.map((p) =>
              p.call({
                to: required.address,
                data,
                blockTag: block.blockNumber,
              }),
            ),
          );
        } catch (error) {
          if ((error as { code?: string }).code === "CALL_EXCEPTION")
            throw new ChainError("INVALID_SIGNATURE");
          throw new ChainError("CHAIN_UNAVAILABLE", true);
        }
        requireChain(
          answers.every((a) => a === answers[0]),
          "CHAIN_STATE_UNCERTAIN",
        );
        try {
          requireChain(
            checker.decodeFunctionResult("isValidSignature", answers[0])[0] ===
              "0x1626ba7e",
            "INVALID_SIGNATURE",
          );
        } catch {
          throw new ChainError("INVALID_SIGNATURE");
        }
      }
    }
    // Enforces lifecycle, relationship terms and permissions even before enqueue.
    await this.simulate(intent, signatures);
    return { valid: true as const, signers: intent.requiredSigners };
  }
  private transactionData(intent: Intent, signatures: ActionSignature[]) {
    const { key } = this.checkedIntent(intent);
    const args = intent.requiredSigners.map(
      (s) => signatures.find((x) => x.role === s.role)!.signature,
    );
    const method =
      intent.actionType[0].toLowerCase() + intent.actionType.slice(1);
    return {
      key,
      to: this.manifest.contracts[key].address,
      data: this.interfaces[key].encodeFunctionData(method, [
        intent.message,
        ...args,
      ]),
    };
  }
  private async simulate(intent: Intent, signatures: ActionSignature[]) {
    const tx = this.transactionData(intent, signatures);
    try {
      await Promise.all(
        this.providers.map((p) => p.call({ to: tx.to, data: tx.data })),
      );
    } catch (error) {
      const e = error as { code?: string; data?: string };
      if (e.code === "CALL_EXCEPTION") {
        let name: string | undefined;
        try {
          name = this.interfaces[tx.key].parseError(e.data ?? "0x")?.name;
        } catch {
          /* safe generic revert */
        }
        const codes = {
          InvalidAction: "INVALID_ACTION",
          InvalidSignature: "INVALID_SIGNATURE",
          NonceConflict: "NONCE_CONFLICT",
          ActionExpired: "ACTION_EXPIRED",
        } as const;
        throw new ChainError(
          codes[name as keyof typeof codes] ?? "CONTRACT_REVERT",
        );
      }
      throw new ChainError("CHAIN_UNAVAILABLE", true);
    }
  }
  async submitSignedAction(
    intent: Intent,
    signatures: ActionSignature[],
    requestId: string,
  ) {
    requireChain(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        requestId,
      ),
    );
    const { journal, signer } = this.options;
    requireChain(journal && signer, "CHAIN_STATE_UNCERTAIN");
    const submissionId = sha256(
      `${this.manifest.deploymentId}:${requestId}`,
    ).slice(2);
    return journal.exclusive(async () => {
      // Recover an already signed transaction before revalidating its now-consumed nonce.
      const existing = await journal.get(submissionId);
      if (existing) {
        this.checkedIntent(intent);
        requireChain(
          existing.digest === intent.digest &&
            existing.deploymentId === intent.deploymentId &&
            existing.requestId === requestId,
          "NONCE_CONFLICT",
        );
        const decoded = Transaction.from(existing.rawTransaction);
        const definition = actionDefinition(intent.actionType);
        const registryKey =
          definition.domain === "identity"
            ? "didRegistry"
            : "managementRegistry";
        requireChain(
          decoded.chainId === 5611n &&
            decoded.value === 0n &&
            decoded.to ===
              getAddress(this.manifest.contracts[registryKey].address),
          "DEPLOYMENT_MISMATCH",
        );
        return this.broadcast(existing);
      }
      await this.readiness();
      // Single in-flight policy: reserve the relayer nonce across crashes/response loss.
      // An unresolved saved transaction must be reconciled using its original requestId.
      for (const prior of await journal.entries()) {
        requireChain(
          prior.deploymentId === this.manifest.deploymentId,
          "DEPLOYMENT_MISMATCH",
        );
        const receipts = await rpc(() =>
          Promise.all(
            this.providers.map((p) => p.getTransactionReceipt(prior.txHash)),
          ),
        );
        if (!receipts[0] || !receipts[1])
          throw new ChainError("SUBMISSION_UNKNOWN", true, true);
        requireChain(
          receipts[0].blockHash === receipts[1].blockHash &&
            (await this.agreedBlock(receipts[0].blockNumber)).blockHash ===
              receipts[0].blockHash,
          "CHAIN_STATE_UNCERTAIN",
        );
      }
      await this.verifySignedAction(intent, signatures);
      const { to, data } = this.transactionData(intent, signatures);
      const from = await rpc(() => signer.getAddress());
      const nonce = await rpc(() =>
        this.options.primary.getTransactionCount(from, "pending"),
      );
      const secondaryNonce = await rpc(() =>
        this.options.secondary.getTransactionCount(from, "pending"),
      );
      requireChain(nonce === secondaryNonce, "CHAIN_STATE_UNCERTAIN");
      const gasPrice = BigInt(
        await rpc(() => this.options.primary.send("eth_gasPrice", [])),
      );
      requireChain(
        gasPrice > 0n && gasPrice <= this.options.gasPriceCap!,
        "CHAIN_STATE_UNCERTAIN",
      );
      const estimate = await rpc(() =>
        this.options.primary.estimateGas({ from, to, data }),
      );
      const gasLimit = (estimate * 120n) / 100n;
      requireChain(
        gasLimit <= this.options.gasLimitCap!,
        "CHAIN_STATE_UNCERTAIN",
      );
      const balance = await rpc(() => this.options.primary.getBalance(from));
      requireChain(
        balance >= gasLimit * gasPrice + this.options.minimumBalance!,
        "INSUFFICIENT_FUNDS",
      );
      // Sign through the supplied server-side signer/KMS; never Agent keys.
      let rawTransaction: string;
      try {
        rawTransaction = await signer.signTransaction({
          to,
          data,
          value: 0n,
          nonce,
          chainId: 5611,
          type: 0,
          gasPrice,
          gasLimit,
        });
      } catch {
        throw new ChainError("CHAIN_UNAVAILABLE", true);
      }
      const decoded = Transaction.from(rawTransaction);
      requireChain(
        decoded.from === getAddress(from) &&
          decoded.to === getAddress(to) &&
          decoded.chainId === 5611n &&
          decoded.data === data &&
          decoded.nonce === nonce &&
          decoded.value === 0n &&
          decoded.gasPrice === gasPrice &&
          decoded.gasLimit === gasLimit,
        "INVALID_SIGNATURE",
      );
      const saved: Submission = {
        submissionId,
        requestId,
        deploymentId: intent.deploymentId,
        digest: intent.digest,
        txHash: keccak256(rawTransaction),
        rawTransaction,
        acceptedAt: new Date().toISOString(),
        registry: to,
        agent: (intent.message.identityAccount ??
          intent.message.agent) as string,
      };
      await journal.put(saved); // fsync before broadcast; response loss cannot produce a second transaction.
      return this.broadcast(saved);
    });
  }
  private async broadcast(saved: Submission) {
    await this.verifyDeployment();
    requireChain(
      keccak256(saved.rawTransaction) === saved.txHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    try {
      const known = await this.options.primary.getTransaction(saved.txHash);
      if (!known)
        await this.options.primary.broadcastTransaction(saved.rawTransaction);
    } catch {
      throw new ChainError("SUBMISSION_UNKNOWN", true, true);
    }
    return {
      submissionId: saved.submissionId,
      txHash: saved.txHash,
      acceptedAt: saved.acceptedAt,
      state: "SUBMITTED" as const,
    };
  }
  async getSubmission(submissionId: string) {
    requireChain(this.options.journal, "CHAIN_STATE_UNCERTAIN");
    const saved = await this.options.journal.get(submissionId);
    requireChain(
      saved && saved.deploymentId === this.manifest.deploymentId,
      "INVALID_ACTION",
    );
    await this.verifyDeployment();
    return rpc(async () => {
      const receipts = await Promise.all(
        this.providers.map((p) => p.getTransactionReceipt(saved.txHash)),
      );
      if (receipts.some((r) => !r)) {
        const known = await Promise.all(
          this.providers.map((p) => p.getTransaction(saved.txHash)),
        );
        return {
          state:
            receipts.every((r) => !r) && known.every(Boolean)
              ? ("PENDING" as const)
              : ("UNKNOWN" as const),
          submissionId,
          txHash: saved.txHash,
        };
      }
      const [r, other] = receipts;
      requireChain(
        r &&
          other &&
          r.blockHash === other.blockHash &&
          r.status === other.status,
        "CHAIN_STATE_UNCERTAIN",
      );
      const block = await this.agreedBlock(r.blockNumber);
      requireChain(block.blockHash === r.blockHash, "CHAIN_STATE_UNCERTAIN");
      if (r.status !== 1)
        return {
          state: "REVERTED" as const,
          submissionId,
          txHash: saved.txHash,
          blockNumber: r.blockNumber,
          blockHash: r.blockHash,
          errorCode: "CONTRACT_REVERT",
        };
      const events = await this.readEvents(r.blockNumber, r.blockNumber);
      const matching = events.events.filter(
        (e) =>
          e.txHash === saved.txHash &&
          e.actionDigest === saved.digest &&
          e.agentDid === toDid(5611, saved.agent),
      );
      requireChain(
        matching.length === 1 &&
          r.to &&
          getAddress(r.to) === getAddress(saved.registry),
        "CHAIN_STATE_UNCERTAIN",
      );
      const finality = await this.evaluateFinality(r.blockNumber, r.blockHash);
      const rawReceipt = await this.options.primary.send(
        "eth_getTransactionReceipt",
        [saved.txHash],
      );
      return {
        state: "INCLUDED" as const,
        submissionId,
        txHash: saved.txHash,
        blockNumber: r.blockNumber,
        blockHash: r.blockHash,
        status: "success",
        gasUsed: r.gasUsed.toString(),
        executionFee: r.fee.toString(),
        l1Fee: rawReceipt.l1Fee ? BigInt(rawReceipt.l1Fee).toString() : null,
        events: matching,
        ...finality,
      };
    });
  }
  async evaluateFinality(blockNumber: number, blockHash: string) {
    requireChain(
      (await this.agreedBlock(blockNumber)).blockHash === blockHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    const head = await this.agreedBlock();
    const confirmations = Math.max(0, head.blockNumber - blockNumber + 1);
    if (this.manifest.finality.mode === "finalized-tag") {
      try {
        const finalized = await this.agreedBlock("finalized");
        return {
          confirmed: finalized.blockNumber >= blockNumber,
          confirmations,
          finalitySource: "finalized-tag" as const,
        };
      } catch (e) {
        if (
          !this.options.allowFinalityFallback ||
          (e instanceof ChainError && e.code === "CHAIN_STATE_UNCERTAIN")
        )
          throw e;
      }
    }
    return {
      confirmed: confirmations >= this.manifest.finality.fallbackConfirmations,
      confirmations,
      finalitySource: "confirmations" as const,
    };
  }
  async readEvents(from: number, to: number) {
    requireChain(
      Number.isSafeInteger(from) &&
        Number.isSafeInteger(to) &&
        from >= 1 &&
        to >= from &&
        to - from < 2000,
    );
    await this.verifyDeployment();
    const start = await this.agreedBlock(from),
      end = await this.agreedBlock(to);
    const chunk = this.options.logChunkSize ?? 200;
    const events: any[] = [];
    await rpc(async () => {
      for (let low = from; low <= to; low += chunk) {
        const high = Math.min(to, low + chunk - 1);
        const filter = {
          address: Object.values(this.manifest.contracts).map((c) => c.address),
          fromBlock: low,
          toBlock: high,
        };
        const [a, b] = await Promise.all(
          this.providers.map((p) => p.getLogs(filter)),
        );
        const normalized = (logs: Log[]) =>
          logs
            .map((l) => [
              l.blockHash,
              l.transactionHash,
              l.index,
              l.address.toLowerCase(),
              l.data,
              l.topics,
            ])
            .sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)));
        requireChain(
          JSON.stringify(normalized(a)) === JSON.stringify(normalized(b)),
          "CHAIN_STATE_UNCERTAIN",
        );
        for (const log of a) {
          requireChain(
            !log.removed && log.blockNumber >= low && log.blockNumber <= high,
            "CHAIN_STATE_UNCERTAIN",
          );
          const key =
            getAddress(log.address) ===
            getAddress(this.manifest.contracts.didRegistry.address)
              ? "didRegistry"
              : "managementRegistry";
          let parsed;
          try {
            parsed = this.interfaces[key].parseLog(log);
          } catch {
            throw new ChainError("DEPLOYMENT_MISMATCH");
          }
          // EIP712DomainChanged is an OZ metadata event, not a business projection.
          requireChain(parsed, "DEPLOYMENT_MISMATCH");
          if (parsed.name === "EIP712DomainChanged") continue;
          const args = parsed.args;
          const block = await this.agreedBlock(log.blockNumber);
          requireChain(
            block.blockHash === log.blockHash,
            "CHAIN_STATE_UNCERTAIN",
          );
          const payload: Record<string, unknown> = {};
          for (const field of parsed.fragment.inputs.slice(4)) {
            const value = args[field.name];
            payload[field.name] =
              field.name === "status"
                ? statuses[Number(value)]
                : typeof value === "bigint"
                  ? value.toString()
                  : value;
          }
          if (parsed.name === "AgentRegistered")
            payload.identityAccount = args.agent;
          const event = {
            schema: "memo.agent-chain-event/1",
            deploymentId: this.manifest.deploymentId,
            networkId: this.manifest.network.caip2,
            eventType: parsed.name,
            agentDid: toDid(5611, args.agent),
            actionDigest: args.actionDigest,
            revision: args.revision.toString(),
            nonce: args.nonce.toString(),
            txHash: log.transactionHash,
            blockNumber: log.blockNumber,
            blockHash: log.blockHash,
            transactionIndex: log.transactionIndex,
            logIndex: log.index,
            blockTimestamp: block.timestamp,
            payload,
          };
          requireChain(eventValidator(event), "DEPLOYMENT_MISMATCH");
          events.push(event);
        }
      }
    });
    requireChain(
      (await this.agreedBlock(from)).blockHash === start.blockHash &&
        (await this.agreedBlock(to)).blockHash === end.blockHash,
      "CHAIN_STATE_UNCERTAIN",
    );
    const unique = [
      ...new Map(
        events.map((e) => [`${e.blockHash}:${e.txHash}:${e.logIndex}`, e]),
      ).values(),
    ];
    unique.sort(
      (a, b) =>
        a.blockNumber - b.blockNumber ||
        a.transactionIndex - b.transactionIndex ||
        a.logIndex - b.logIndex,
    );
    return {
      fromBlockHash: start.blockHash,
      toBlockHash: end.blockHash,
      complete: true as const,
      events: unique,
    };
  }
  async publicConfig() {
    await this.verifyDeployment();
    const m = this.manifest;
    return {
      deploymentId: m.deploymentId,
      network: m.network,
      contracts: Object.fromEntries(
        Object.entries(m.contracts).map(([key, c]) => [
          key,
          {
            address: c.address,
            interfaceVersion: c.interfaceVersion,
            domain: c.domain,
          },
        ]),
      ),
      finality: m.finality,
      transport: m.transport,
      capabilities: {
        identity: true,
        management: true,
        instanceRevocation: true,
        erc4337: false,
        eas: false,
      },
    };
  }
}
