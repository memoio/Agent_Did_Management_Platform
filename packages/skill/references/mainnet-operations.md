# MEMO Mainnet operations

## Environment

- `MEMO_AGENT_MAINNET_INSTALLATION_ID`: stable Runtime installation identifier. Required when one host runs multiple Agents.
- `MEMO_AGENT_MAINNET_HOME`: mainnet-only state root. Never reuse the old Skill root.
- `MEMO_AGENT_MAINNET_ENVIRONMENT`: `local`, `preprod`, or `production`.
- `MEMO_AGENT_MAINNET_API_URL`: loopback HTTP in `local`; HTTPS otherwise.
- `MEMO_AGENT_MAINNET_API_ORIGINS`: comma-separated exact HTTPS origins allowed in preprod/production.
- `MEMO_AGENT_MAINNET_KEY_PROVIDER`: `auto`, `os-keyring`, or `env-master-key`.
- `MEMO_AGENT_MAINNET_MASTER_KEY`: test/emergency wrapping input for `env-master-key`; at least 32 characters. Do not put it in argv or a checked-in file.
- `MEMO_AGENT_MAINNET_ALLOW_R2=1`: explicit trusted grant for reversible/normal chain actions.
- `MEMO_AGENT_MAINNET_ALLOW_R4_TEST=1`: disposable local chain-985 test grant only. It is ignored outside `local` loopback mode.

The chain ID is fixed at `985`. Supplying any other `MEMO_AGENT_MAINNET_CHAIN_ID` fails closed.

## Startup and identity

```sh
bin/memo-agent-mainnet doctor --json
bin/memo-agent-mainnet identity ensure --json
bin/memo-agent-mainnet identity status --json
```

Runtime adapters call `bootstrapMemoAgentMainnetRuntime`, which performs exactly `doctor → ensure → status`. These commands do not contact the API or chain. `identity init` is a deprecated alias. A status response exposes public material only; there is intentionally no private-key export command.

Register an existing local identity explicitly:

```sh
bin/memo-agent-mainnet identity register --profile profile.json --json
```

The Skill opens a short Agent session by signing a fixed-format EIP-191 challenge, validates `/api/v1/chain/config`, rebuilds the `RegisterAgent` EIP-712 digest locally, signs it, submits it with the digest as the idempotency key, and waits for finality. A failed registration retains the same DID and Identity Key.

Read and lifecycle commands:

```sh
bin/memo-agent-mainnet identity resolve did:memo:agent:985:0x... --verify --json
bin/memo-agent-mainnet identity update-profile --profile profile.json --json
bin/memo-agent-mainnet identity update-document --document document.json --json
bin/memo-agent-mainnet identity suspend --json
bin/memo-agent-mainnet identity resume --json
bin/memo-agent-mainnet identity revoke --json
bin/memo-agent-mainnet operation reconcile op_... --json
```

`revoke` is permanent. A canonical reorg does not create a new action: the worker replays the original signed action only while its Registry nonce remains unconsumed and its deadline remains valid.

## Instances and authentication

The default Instance Key is created only after registration reaches `CONFIRMED`. Identity and Instance keys use different handles.

```sh
bin/memo-agent-mainnet instance create --name worker-01 --ttl 24h --json
bin/memo-agent-mainnet instance list --json
bin/memo-agent-mainnet instance revoke inst_... --reason rotated --json
bin/memo-agent-mainnet identity self-test --json
```

Challenge signing accepts only the declared `AuthChallenge` schema, a short time window, and an unused issuer/nonce pair.

## Pairing and management

Pairing v2 supports two directions. A Platform Invitation is downloaded by the wallet user and accepted by the Agent:

```sh
bin/memo-agent-mainnet pair invitation accept \
  --invitation-file /path/to/platform-invitation.memo-pair.json \
  --profile /path/to/profile.json \
  --json
```

The Skill verifies the file, claims it through an Agent session, registers the existing local DID if needed, waits for Registry finality, and then completes the off-chain binding. Alternatively, the Agent creates an Offer for wallet import:

```sh
bin/memo-agent-mainnet pair offer create \
  --offer-file /path/to/agent-offer.memo-pair.json \
  --max-scopes profile.update,instance.issue \
  --max-term 30d \
  --ttl 15m \
  --profile /path/to/profile.json \
  --json
```

`--profile` is optional: an explicit file wins, then a persisted snapshot, then a minimal “Unnamed Agent” profile. Offer output uses exclusive creation and mode `0600`; Invitation input must be a current-user-owned regular file, never a symlink. Both files contain a secret handle. Never print, paste, log, or commit their contents. The JSON envelope returns only exchange ID, state, DID, operation/finality fields, and the output path.

```sh
bin/memo-agent-mainnet pair status poff_... --json
bin/memo-agent-mainnet pair resume pinv_... --json
bin/memo-agent-mainnet pair cancel poff_... --json
```

The removed `pair create` command fails with `PAIRING_V1_REMOVED`. Pairing itself is off-chain and creates a management draft; it does not grant management authority.

The Console wallet creates and signs a management intent. The Agent polls without disclosing its Identity Key:

```sh
bin/memo-agent-mainnet agent-request next --wait-seconds 20 --json
bin/memo-agent-mainnet agent-request approve --id req_... --json
# or
bin/memo-agent-mainnet agent-request reject --id req_... --reason declined --json
```

Approval revalidates the chain, Management Registry, typed fields, target Agent, digest, deadline, and manager proofs before the local Identity Key signs. Activation/renewal requires Agent + Manager signatures; transfer requires Agent + old Manager + new Manager; ending requires either Agent or current Manager.

## Security and recovery

- The OS keyring service is `com.memo.agent-did.mainnet`; its account includes installation ID and key version.
- `keys.enc.json` contains only AES-256-GCM ciphertext and is mode `0600`.
- A missing keyring secret, public-key mismatch, Registry mismatch, API-origin mismatch, or deployment-environment mismatch is a quarantine condition. Never generate a replacement key.
- Preprod and production use different Identity Keys and state roots. There is no silent migration from the old Skill or local chain.
- `identity key-migrate --to os-keyring --json` migrates only within this mainnet installation and verifies that the DID and public key are unchanged.
- Session bearer tokens are kept in process memory and platform storage contains only token hashes.
- Management does not grant Vault, Memory, Data, MCP, or Gateway access.
