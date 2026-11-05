import { Injectable } from "@nestjs/common";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { getAddress, verifyMessage } from "ethers";
import { addressFromDid, didForAddress } from "../../../packages/protocol/src/index.js";
import { ChainStore, type StoreRow } from "./store.service.js";

export interface Principal {
  kind: "agent" | "wallet";
  subject: string;
  tenantId: string;
}

@Injectable()
export class SessionService {
  constructor(private readonly store: ChainStore) {}

  createAgentChallenge(agentDid: string) {
    const account = addressFromDid(agentDid);
    const challengeId = "ach_" + randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    const issuedAt = new Date().toISOString();
    const expiresAt = Date.now() + 5 * 60_000;
    const message = [
      "MEMO Agent DID Mainnet session",
      "DID: " + agentDid,
      "Address: " + account,
      "Chain ID: 985",
      "Challenge: " + challengeId,
      "Nonce: " + nonce,
      "Issued At: " + issuedAt,
      "Expires At: " + new Date(expiresAt).toISOString(),
    ].join("\n");
    this.store.insertChallenge({
      challengeId,
      kind: "agent",
      subject: agentDid,
      nonceHash: sha256(nonce),
      message,
      expiresAt,
    });
    return { challengeId, message, issuedAt, expiresAt: new Date(expiresAt).toISOString() };
  }

  createAgentSession(challengeId: string, signature: string) {
    const row = this.store.consumeChallenge(challengeId, "agent");
    if (!row) throw new Error("AGENT_CHALLENGE_INVALID_OR_EXPIRED");
    const agentDid = String(row.subject);
    const expected = addressFromDid(agentDid);
    const recovered = getAddress(verifyMessage(String(row.message), signature));
    if (recovered !== expected) throw new Error("AGENT_SIGNATURE_MISMATCH");
    const expiresAt = Date.now() + 15 * 60_000;
    const token = this.store.createSession({
      kind: "agent",
      subject: agentDid,
      tenantId: this.store.agentTenant(agentDid),
      expiresAt,
    });
    return { token, tokenType: "Bearer", agentDid, expiresAt: new Date(expiresAt).toISOString() };
  }

  createWalletChallenge(accountValue: string) {
    const account = getAddress(accountValue);
    const challengeId = "wch_" + randomUUID();
    const nonce = randomBytes(32).toString("base64url");
    const expiresAt = Date.now() + 5 * 60_000;
    const message = [
      "MEMO Agent DID Console login",
      "Account: " + account,
      "Chain ID: 985",
      "Challenge: " + challengeId,
      "Nonce: " + nonce,
      "Expires At: " + new Date(expiresAt).toISOString(),
    ].join("\n");
    this.store.insertChallenge({
      challengeId,
      kind: "wallet",
      subject: account,
      nonceHash: sha256(nonce),
      message,
      expiresAt,
    });
    return { challengeId, message, expiresAt: new Date(expiresAt).toISOString() };
  }

  createWalletSession(challengeId: string, signature: string) {
    const row = this.store.consumeChallenge(challengeId, "wallet");
    if (!row) throw new Error("WALLET_CHALLENGE_INVALID_OR_EXPIRED");
    const account = getAddress(String(row.subject));
    if (getAddress(verifyMessage(String(row.message), signature)) !== account) throw new Error("WALLET_SIGNATURE_MISMATCH");
    const expiresAt = Date.now() + 8 * 60 * 60_000;
    const tenantId = "wallet:" + account.toLowerCase();
    const token = this.store.createSession({ kind: "wallet", subject: account, tenantId, expiresAt });
    return { token, tokenType: "Bearer", account, caip10Account: "eip155:985:" + account, expiresAt: new Date(expiresAt).toISOString() };
  }

  require(token: string | undefined, kind?: "agent" | "wallet"): Principal {
    if (!token) throw new Error("SESSION_REQUIRED");
    const row = this.store.session(token, kind);
    if (!row) throw new Error("SESSION_INVALID_OR_EXPIRED");
    return { kind: String(row.kind) as Principal["kind"], subject: String(row.subject), tenantId: String(row.tenant_id) };
  }

  bearer(header: string | undefined): string | undefined {
    const match = /^Bearer ([A-Za-z0-9_-]{20,})$/.exec(header || "");
    return match?.[1];
  }

  revoke(token: string): void {
    this.store.revokeSession(token);
  }

  assertDidMatchesPublicKey(agentDid: string, publicAddress: string): void {
    if (didForAddress(publicAddress) !== agentDid.toLowerCase()) throw new Error("DID_KEY_MISMATCH");
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}
