import { createHash } from "node:crypto";
import { canonicalize } from "json-canonicalize";
import {
  getAddress,
  isHexString,
  keccak256,
  toUtf8Bytes,
  TypedDataEncoder,
} from "ethers";
import spec from "../../../specs/chain-integration-v1/action-types.json" with { type: "json" };
import { requireChain } from "./errors.js";

export const actionSpec = spec;
export type ActionType = keyof typeof spec.actions;
export type Message = Record<string, string | boolean>;
export interface Domain {
  name: string;
  version: string;
  chainId: number;
  verifyingContract: string;
}
export interface Snapshot {
  blockNumber: number;
  blockHash: string;
  timestamp: number;
}
export interface Intent {
  schema: "memo.agent-chain-intent/1";
  intentId: string;
  deploymentId: string;
  networkId: string;
  actionType: ActionType;
  domain: Domain;
  types: Record<string, { name: string; type: string }[]>;
  message: Message;
  digest: string;
  requiredSigners: { role: string; address: string }[];
  chainSnapshot: Snapshot;
  createdAt: string;
}
export interface ActionSignature {
  role: string;
  address: string;
  signature: string;
}
export function hashJson(value: unknown): string {
  // Validate before canonicalization: JCS rejects non-finite numbers and lone surrogates.
  const visit = (v: unknown): void => {
    requireChain(
      v !== undefined &&
        typeof v !== "bigint" &&
        typeof v !== "function" &&
        typeof v !== "symbol",
    );
    if (typeof v === "number") requireChain(Number.isFinite(v));
    if (typeof v === "string")
      requireChain(
        !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/u.test(
          v,
        ),
      );
    if (v && typeof v === "object") {
      requireChain(
        Array.isArray(v) ||
          Object.getPrototypeOf(v) === Object.prototype ||
          Object.getPrototypeOf(v) === null,
      );
      for (const [k, x] of Object.entries(v)) {
        visit(k);
        visit(x);
      }
    }
  };
  visit(value);
  return sha256(Buffer.from(canonicalize(value), "utf8"));
}
export function sha256(bytes: Uint8Array | string): string {
  return `0x${createHash("sha256").update(bytes).digest("hex")}`;
}
export function hashScopes(scopes: string[]): string {
  requireChain(
    Array.isArray(scopes) &&
      scopes.length >= 1 &&
      scopes.length <= 64 &&
      scopes.every(
        (s) => typeof s === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(s),
      ),
  );
  return hashJson([...new Set(scopes)].sort());
}
export function hashIdentifier(value: string): string {
  requireChain(
    typeof value === "string" && /^[A-Za-z0-9._:-]{1,128}$/.test(value),
  );
  return keccak256(toUtf8Bytes(value));
}
export function toDid(chainId: number, address: string): string {
  requireChain(Number.isSafeInteger(chainId) && chainId > 0 && chainId !== 985);
  return `did:memo:agent:${chainId}:${getAddress(address).toLowerCase()}`;
}
export function actionDefinition(action: ActionType) {
  requireChain(Object.hasOwn(spec.actions, action));
  return spec.actions[action];
}
export function checkedMessage(action: ActionType, input: Message): Message {
  const fields = actionDefinition(action).fields;
  requireChain(
    input &&
      typeof input === "object" &&
      Object.keys(input).length === fields.length,
  );
  const message: Message = {};
  for (const [name, type] of fields) {
    const value = input[name];
    requireChain(Object.hasOwn(input, name));
    if (type === "bool") requireChain(typeof value === "boolean");
    else {
      requireChain(typeof value === "string");
      if (type === "address") {
        requireChain(/^0x[0-9a-fA-F]{40}$/.test(value) && BigInt(value) !== 0n);
        getAddress(value);
      } else if (type === "bytes32")
        requireChain(isHexString(value, 32) && BigInt(value) !== 0n);
      else
        requireChain(
          /^(0|[1-9][0-9]*)$/.test(value) &&
            BigInt(value) < 1n << BigInt(type === "uint64" ? 64 : 256),
        );
    }
    message[name] = value;
  }
  requireChain(BigInt(message.deadline as string) > 0n);
  return message;
}
export function makeIntent(input: {
  intentId: string;
  deploymentId: string;
  actionType: ActionType;
  domain: Domain;
  message: Message;
  chainSnapshot: Snapshot;
}): Intent {
  requireChain(/^[A-Za-z0-9._:-]{8,128}$/.test(input.intentId));
  const definition = actionDefinition(input.actionType);
  const expectedDomain =
    spec.domains[definition.domain as keyof typeof spec.domains];
  requireChain(
    input.domain.name === expectedDomain.name &&
      input.domain.version === expectedDomain.version,
  );
  const message = checkedMessage(input.actionType, input.message);
  const types = {
    [input.actionType]: definition.fields.map(([name, type]) => ({
      name,
      type,
    })),
  };
  return {
    schema: "memo.agent-chain-intent/1",
    ...input,
    message,
    types,
    domain: { ...input.domain },
    chainSnapshot: { ...input.chainSnapshot },
    networkId: `eip155:${input.domain.chainId}`,
    digest: TypedDataEncoder.hash(input.domain, types, message),
    requiredSigners: definition.signers.map((role) => ({
      role,
      address: getAddress(
        message[
          role === "agent"
            ? "identityAccount" in message
              ? "identityAccount"
              : "agent"
            : role
        ] as string,
      ),
    })),
    createdAt: new Date().toISOString(),
  };
}
