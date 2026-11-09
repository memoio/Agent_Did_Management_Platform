# 本机实际运行命令、测试流程与测试数据

更新于 2026-11-09。以下命令针对本机 macOS、opBNB Testnet（chain ID 5611）和已部署的 `opbnb-agentdid-20261109-a`。本机 API、Worker 和 PostgreSQL 在上次验收后已停止；部署清单、数据库、Agent 身份和链上数据均已保留。公开验收证据见 [ACCEPTANCE-2026-11-09.md](../deploy/testnet/ACCEPTANCE-2026-11-09.md)。

> **先区分两种操作**：只读查询不需要独占 Gas 账户；启动 Worker 或创建新的链上操作前，须确认测试 Gas 账户 `0xd511f5C8A3e0A12f6119aCA7463d6f619CEf14B0` 暂时不被其他项目使用。本项目首版没有跨项目 nonce 分配器。不要重新执行合约部署命令来“启动项目”。

## 1. 路径与已有数据

| 项目 | 本机值 |
| --- | --- |
| 平台仓库 | `/Users/memo/Agent_DID/agent-did-memo-mainnet` |
| 受控环境文件 | `/Users/memo/Library/Application Support/MemoAgentOpbnb/runtime.env` |
| PostgreSQL 数据目录与 socket | `/Users/memo/Library/Application Support/MemoAgentOpbnb/postgres`、`.../run` |
| 业务数据库 | `agent_did_opbnb`，端口 `55435`，只监听私有 Unix socket |
| 专用测试数据库 | `agent_did_opbnb_test`，测试会清空该库的平台表 |
| 当前已验证的 Skill 目录 | `/Users/memo/Agent_DID/.data/opbnb-skill-publish-20261109/skills/memo-agent-did-opbnb-testnet` |
| 现有隔离 Agent 状态目录 | `/Users/memo/Agent_DID/.data/opbnb-test-agent-20261109` |
| 现有 Agent DID | `did:memo:agent:5611:0x5e504c67713b03c9743d93bb72ef93f0094d2b89` |
| DID Registry | `0x456Df7c0C189BF0187a8c0A70c713F8Da609c9d7` |
| Management Registry | `0x9e589B142543ea9E15eE25C53823354319dB3929` |

本机 `runtime.env` 含受控签名配置，权限为 `600`。不要 `cat`、`source`、复制到仓库或把内容发到聊天。它由 API、Worker 和链工具通过 Node 的 `--env-file` 读取。Skill **不加载这个文件**；它只需要平台 URL、公开合约地址和自己的独立钥匙串身份。当前业务库名是 `agent_did_opbnb`，与配置工具在全新机器上的默认库名 `memo_agent_opbnb` 不同；工具保留了本机已有值。

上表 Skill 路径是本机实际使用的独立 Git 工作树；新机器应从 [Skill 仓库的 `feat/opbnb-testnet-skill` 分支](https://github.com/memoio/agent_did_skill/tree/feat/opbnb-testnet-skill)安装，并在 Skill 目录执行 `npm ci --omit=dev`。不要复用 chain 985 Skill 的身份目录。

## 2. 构建与启动

在仓库根目录执行：

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
git switch feat/opbnb-testnet-chain
git pull --ff-only
npm ci
npm run build
npm run local:configure
```

`local:configure` 会保留已有非空配置，并从本机部署清单回填地址与 SHA-256。正常输出应包含 `manifestImported: true`、`signerConfigured: true`、`databaseConfigured: true`。它不广播交易。`npm run chain:preflight` 只检查公开网络；若要用受控文件中的双 RPC 参数，运行：

```sh
node --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" scripts/chain/preflight.mjs
```

先启动本地 PostgreSQL；它只监听属主可访问的 Unix socket：

```sh
MEMO_RUNTIME_DIR="$HOME/Library/Application Support/MemoAgentOpbnb"
if ! pg_ctl -D "$MEMO_RUNTIME_DIR/postgres" status >/dev/null 2>&1; then
  pg_ctl -D "$MEMO_RUNTIME_DIR/postgres" \
    -o "-k '$MEMO_RUNTIME_DIR/run' -p 55435 -c listen_addresses=''" \
    -l "$MEMO_RUNTIME_DIR/postgres.log" start
fi
pg_isready -h "$MEMO_RUNTIME_DIR/run" -p 55435
```

**只有在已协调 Gas 账户使用窗口时**，在两个不同终端分别运行：

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
MEMO_CHAIN_WRITES_ENABLED=true node \
  --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" \
  dist/apps/api/src/main.js
```

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
MEMO_CHAIN_WRITES_ENABLED=true node \
  --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" \
  dist/apps/chain-worker/src/main.js
```

仅运行**一个** Worker。API 与 Worker 使用同一数据库和持久 Journal。启动后检查：

```sh
curl -fsS http://127.0.0.1:4273/api/v1/health
curl -fsS http://127.0.0.1:4273/api/v1/ready
```

`/health` 只表示进程存活；`/ready` 应返回 `ok=true`、`writesEnabled=true`、`databaseReady=true`。Console 地址为 <http://127.0.0.1:4273>，Manager 钱包应在安装了钱包扩展的浏览器中打开。

## 3. 查看本次已完成的测试数据

现有 Agent 已在链上注册，**不要对同一身份再次执行 `register`**。启动 API 后可直接查询：

```sh
DID='did:memo:agent:5611:0x5e504c67713b03c9743d93bb72ef93f0094d2b89'
curl -fsS "http://127.0.0.1:4273/api/v1/agent-dids/$DID"
curl -fsS "http://127.0.0.1:4273/api/v1/management/$DID"
```

预期 DID 状态 `ACTIVE`；关系的 `manager` 为 `0x0FC646329a20f7508dB9bB4E2B894d24b9829be6`、`scopesHash` 为 `0xa0ded24fd8aeced755fe642a6fa0e3b62b0343b2533fbb8ac060ff27271abfb1`、`live=true`。两个 operation 的状态均为 `CONFIRMED`、`finalitySource=finalized-tag`：

- 注册 operation：`f52693f0-0d58-4f3d-b1a7-4a3d2472fe23`；交易 `0xeb8082fbc8ecbd685e4e2477e632d4686651967fed258877e4b162da6befbadd`。
- 管理 operation：`48d44604-62a8-4071-a230-7d52716d8f9d`；交易 `0x46dc8690890b0145e1dc11c752a25a08d6b40e5ddd8ad29753a6cfd2a404cf07`。

operation API 需要身份会话，可用独立 Skill 查询：

```sh
SKILL_DIR=/Users/memo/Agent_DID/.data/opbnb-skill-publish-20261109/skills/memo-agent-did-opbnb-testnet
export MEMO_AGENT_OPBNB_HOME=/Users/memo/Agent_DID/.data/opbnb-test-agent-20261109
export MEMO_AGENT_OPBNB_API_URL=http://127.0.0.1:4273
export MEMO_AGENT_OPBNB_DID_REGISTRY=0x456Df7c0C189BF0187a8c0A70c713F8Da609c9d7
export MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY=0x9e589B142543ea9E15eE25C53823354319dB3929
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" identity status
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" operation f52693f0-0d58-4f3d-b1a7-4a3d2472fe23
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" operation 48d44604-62a8-4071-a230-7d52716d8f9d
```

如只想核对本地持久记录，不必启动 API/Worker，可在 PostgreSQL 启动后执行**只读** SQL：

```sh
MEMO_RUNTIME_DIR="$HOME/Library/Application Support/MemoAgentOpbnb"
psql -h "$MEMO_RUNTIME_DIR/run" -p 55435 -d agent_did_opbnb \
  -c "SELECT id, action_type, state, tx_hash, block_number, finality_source FROM operations WHERE state='CONFIRMED' ORDER BY created_at;"
psql -h "$MEMO_RUNTIME_DIR/run" -p 55435 -d agent_did_opbnb \
  -c "SELECT event->>'eventType' AS event_type, tx_hash, block_number FROM chain_events ORDER BY block_number;"
```

数据库记录用于恢复和审计；最终链状态仍应由双 RPC 解析与交易收据核对。

## 4. 新建一组隔离测试数据并走完整流程

每次新测都使用**新的状态目录和 Agent 身份**，避免再次注册既有 DID，或与既有有效管理关系冲突。以下命令在同一终端执行；`identity ensure` 仅在本机钥匙串创建身份，不上链：

```sh
SKILL_DIR=/Users/memo/Agent_DID/.data/opbnb-skill-publish-20261109/skills/memo-agent-did-opbnb-testnet
TEST_AGENT_HOME="/Users/memo/Agent_DID/.data/opbnb-agent-$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$TEST_AGENT_HOME"
export MEMO_AGENT_OPBNB_HOME="$TEST_AGENT_HOME"
export MEMO_AGENT_OPBNB_API_URL=http://127.0.0.1:4273
export MEMO_AGENT_OPBNB_DID_REGISTRY=0x456Df7c0C189BF0187a8c0A70c713F8Da609c9d7
export MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY=0x9e589B142543ea9E15eE25C53823354319dB3929
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" identity ensure > "$TEST_AGENT_HOME/identity-result.json"
```

从 CLI 返回的**公开** DID 和公钥生成本轮 JSON 测试数据；不要把私钥写进文件：

```sh
TEST_AGENT_HOME="$TEST_AGENT_HOME" node <<'NODE'
const fs = require('node:fs');
const path = require('node:path');
const root = process.env.TEST_AGENT_HOME;
const output = JSON.parse(fs.readFileSync(path.join(root, 'identity-result.json'), 'utf8'));
if (!output.ok || !output.data?.did || !output.data?.publicKey) throw Error('IDENTITY_NOT_READY');
const { did, publicKey } = output.data;
const keyId = did + '#identity-key';
const profile = { name: 'opBNB Integration Test Agent', description: 'Isolated Agent DID test' };
const document = {
  '@context': ['https://www.w3.org/ns/did/v1'],
  id: did,
  verificationMethod: [{ id: keyId, type: 'EcdsaSecp256k1VerificationKey2019', controller: did, publicKeyHex: publicKey }],
  authentication: [keyId]
};
fs.writeFileSync(path.join(root, 'profile.json'), JSON.stringify(profile, null, 2) + '\n', { mode: 0o600 });
fs.writeFileSync(path.join(root, 'document.json'), JSON.stringify(document, null, 2) + '\n', { mode: 0o600 });
console.log(JSON.stringify({ did, profilePath: path.join(root, 'profile.json'), documentPath: path.join(root, 'document.json') }));
NODE
```

确认 API 和 Worker 已启动后注册，等待 CLI 返回 `CONFIRMED`，记录 DID、action digest、operationId、交易与区块 hash：

```sh
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" register \
  "$TEST_AGENT_HOME/profile.json" "$TEST_AGENT_HOME/document.json"
```

Manager 在 Console 钱包中连接 chain 5611，填入**新 DID**、权限 `agent.read`、期限 `30` 天、`discoverable=false`，点击“创建并签名”。复制页面返回的 `intentId`，再由 Agent 校验并签署同一意图：

```sh
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" management pending
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" management inspect <intentId>
node "$SKILL_DIR/bin/memo-agent-opbnb-testnet" management approve <intentId>
```

核对 inspect 输出的 Manager 地址、明文 scope、scopesHash、期限、digest 后再 approve。Manager 在 Console 第 03 栏用**同一个 intentId**点击“Agent 签名后提交”。意图默认在创建后约 300 秒截止，建议两端准备就绪后再创建；不要反复点击“创建并签名”生成多个未使用意图。等待 operation 为 `CONFIRMED`，再查询 `/agent-dids/:did` 与 `/management/:did`，要求 DID 为 `ACTIVE`、关系 `live=true` 且 Manager 和 scope hash 一致。重启 API、Worker 后复查两个 operation 与关系，留存脱敏证据。

## 5. 离线测试与数据边界

默认 `npm test` 会跳过 PostgreSQL 集成测试。**只将下面的专用测试库用于完整测试**；测试用例执行 `TRUNCATE ... CASCADE`，绝不能把 `TEST_DATABASE_URL` 指向业务库 `agent_did_opbnb`：

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
MEMO_RUNTIME_DIR="$HOME/Library/Application Support/MemoAgentOpbnb"
if ! psql -h "$MEMO_RUNTIME_DIR/run" -p 55435 -d postgres -Atqc \
  "SELECT 1 FROM pg_database WHERE datname='agent_did_opbnb_test'" | rg -q '^1$'; then
  createdb -h "$MEMO_RUNTIME_DIR/run" -p 55435 agent_did_opbnb_test
fi
TEST_DATABASE_URL='postgresql://memo@localhost:55435/agent_did_opbnb_test?host=%2FUsers%2Fmemo%2FLibrary%2FApplication%20Support%2FMemoAgentOpbnb%2Frun' npm test
```

2026-11-09 本机实测：`7` 个测试文件、`25` 项测试全部通过。测试库与业务库分离，业务库中的 `2` 条 `CONFIRMED` operation、`1` 份 Agent 文档和 `2` 条链事件未被改动。

链上 DID 与关系不能靠删除本地 JSON 或数据库行撤销。业务库中未提交、已过期的意图属于审计记录；目前没有提供清理这些记录的常规命令。不要清空业务表、删除部署 manifest 或提交 Journal，也不要复用已有 Agent 状态目录创建“新身份”。

## 6. 停止与再次启动

在 API、Worker 各自终端按 `Ctrl-C`，等待 Worker 退出后再停止数据库：

```sh
pg_ctl -D "$HOME/Library/Application Support/MemoAgentOpbnb/postgres" stop
```

数据保留在受控目录。下次只需按第 2 节启动数据库、API、单 Worker；不需重新部署合约或重新创建已有 Agent。若其他项目需要恢复使用同一 Gas 账户，先停止本项目 Worker；再次执行链上写入前重新协调账户使用窗口。
