---
name: memo-agent-did-mainnet
description: Create, register, inspect, update, suspend, resume, revoke, pair, and manage an isolated MEMO Mainnet chain-985 AgentDID through the local mainnet Skill and ERC-4337 platform. Use for the new production stack only; do not use for the Anvil-31337 Skill, DataDID lookup, private-key export, or Gateway resource authorization.
metadata:
  short-description: Operate an isolated chain-985 AgentDID
---

# MEMO Mainnet Agent DID

Use the deterministic `memo-agent-mainnet` CLI in this package. It creates an offline installation identity first, then performs explicit chain-985 operations through the configured HTTPS platform. The local Identity Key signs only registered EIP-712 actions and fixed Agent-session challenges. Alto, EntryPoint v0.7, and the Relayer Smart Account are transport and Gas layers; they never replace Agent authorization.

## Working directory

Run commands from this Skill package or use `packages/skill/bin/memo-agent-mainnet` from the `agent-did-memo-mainnet` project root. Build the package before first use. The default state root is `~/.memo-agent-mainnet/agents/{installationId}` and is deliberately different from the old `~/.memo-agent` state.

In a writable workspace sandbox, set `MEMO_AGENT_MAINNET_HOME` to a mainnet-only workspace directory. Never point it at an old Skill state directory. For preprod or production, configure an explicit HTTPS origin allowlist as described in [references/mainnet-operations.md](references/mainnet-operations.md).

## Before acting

1. Run `bin/memo-agent-mainnet doctor --json`.
2. Run `bin/memo-agent-mainnet identity ensure --json`, then `bin/memo-agent-mainnet identity status --json`. These are offline R1 steps and must return the same DID and public key on every start.
3. Explain any chain write and its risk before invoking it. Registration, updates, pairing, instance actions, and management approval are R2 and require an explicit trusted service grant.
4. Treat permanent revoke and successor declaration as R4. The packaged test grant works only against loopback chain-985 emulation; it is never valid in preprod or production.
5. Pass secrets through the OS keyring or protected Pairing package files only. Never place a private key, wrapping key, session token, Pairing handle, or package secret in argv, chat, source files, or logs.

## Route the request

- Identity setup, registration, status, resolution, lifecycle, or reorg reconciliation: read the Identity and chain-operation sections of [references/mainnet-operations.md](references/mainnet-operations.md).
- Instance creation/revocation or challenge signing: read the Instance section.
- Pairing, wallet-management requests, or Agent long-poll approval: read the Pairing and management section.
- Deployment mismatch, keyring failure, or recovery behavior: read the Security and recovery section.

## Invariants

1. Reuse the existing chain-985 identity for this installation; never generate a replacement after a network or registration failure.
2. Never read, print, transmit, request, or export private keys or wrapping keys. `identity status` may return only the DID, public key, public address, opaque key handle, provider, and state.
3. Never sign arbitrary bytes or a caller-supplied digest. Reconstruct the complete EIP-712 domain, type, message, and digest locally.
4. Require chain ID `985`, the locked deployment environment, non-zero Registry addresses, and the exact configured platform origin.
5. Reject zero addresses, unknown signed fields, expired deadlines, wrong revisions, wrong nonces, wrong Registry domains, and a digest that differs from the locally reconstructed digest.
6. Use the Identity Key for Agent DID actions, Pairing, and management consent. Use Instance Keys only for routine Agent challenges.
7. A `memo-agent-pairing/2` Invitation or Offer only associates an Agent with one wallet tenant. It does not establish a Management Relationship and does not authorize Gateway resources.
8. Before approving management, show the manager address, action, scopes hash, term, visibility, revision, deadline, and any transfer participants.
9. If an operation is uncertain or reorged, reconcile the same operation and reuse the original action digest and signature. Do not create a second identity or payload.
10. Never copy state or keys from `memo-agent-did`, Anvil-31337, preprod, or another installation. Any chain, Registry, API origin, public-key, or environment mismatch moves state to `QUARANTINED`.
11. `identity ensure` never registers, pairs, creates an Owner/Manager relationship, publishes an attestation, or contacts the network.
12. DataDID is non-authoritative and Gateway authorization remains separate.

## Output handling

Parse exactly one `memo.agent-cli-result/2` JSON envelope from stdout. Treat `ok: false` as failure and branch on `error.code`. Do not infer success from prose. Do not expose the local state path, encrypted key store, session bearer, or Pairing handle in model-visible output. Invitation and Offer files are bearer material: pass their paths to the CLI, but never print their contents.
