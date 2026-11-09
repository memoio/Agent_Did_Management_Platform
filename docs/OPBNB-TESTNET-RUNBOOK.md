# opBNB Testnet 部署、联调与验收

更新于 2026-11-09。本手册只针对远程 opBNB Testnet（chain ID 5611），不使用本地模拟链，也不复用 MEMO chain 985 的 Agent 身份。

## 1. 输入和职责

| 输入 | 来源 | 用途 |
| --- | --- | --- |
| 主、备 HTTPS RPC；chain ID 5611；genesis hash | `.env.example`，上线时独立复核 | 双节点一致性和最终性判断 |
| Relayer 地址 `0xd511f5C8A3e0A12f6119aCA7463d6f619CEf14B0` 与 tBNB | 测试 Gas 账户负责人 | 部署与后续交易 Gas；该账户须独占 nonce |
| `MEMO_SIGNER_MODULE_PATH` + 可选 key ID，或受控进程环境的 `MEMO_RELAYER_PRIVATE_KEY` | 运维安全注入 | 仅服务端签署部署/交易；私钥不进入 Git、日志或聊天 |
| PostgreSQL `DATABASE_URL` | 运维 | 持久化挑战、会话、意图、签名、operation、审计和索引游标 |
| 独立持久目录 `MEMO_DEPLOYMENT_DIR`、`MEMO_SUBMISSION_DIRECTORY` | 运维 | 部署 checkpoint/manifest；提交 Journal 防重复广播 |
| Agent 专用合约部署清单和 SHA-256 | `chain:deploy --execute` 输出 | API/Worker/Skill 绑定真实合约 |
| Agent 的测试链身份、Manager 浏览器钱包 | 联调人员 | 双签交易；均与已有 chain 985 身份隔离 |

当前 Git 分支的 `.env.example` 仅包含公开地址和**空签名占位**，不代表 signer 已注入；EAS 地址不能代替 Agent 专用 Registry。不要在含私钥的终端会话中使用 `env`、`set -x` 或复制环境文件内容到报告。

## 2. 构建、预检、部署

从仓库根目录运行：

```sh
npm ci
npm run build
npm test
npm run chain:preflight
```

运维在受控进程环境设置以下变量（值示例见 `.env.example`）：`MEMO_PRIMARY_RPC_URL`、`MEMO_SECONDARY_RPC_URL`、`MEMO_DEPLOYMENT_ID`、`MEMO_DEPLOYMENT_DIR`、`MEMO_DEPLOYER_ADDRESS`、`MEMO_FINALITY_MODE=finalized-tag`、`MEMO_FALLBACK_CONFIRMATIONS=12`、`MEMO_MAX_REORG_DEPTH=128`、`MEMO_GAS_PRICE_CAP_WEI`、`MEMO_GAS_LIMIT_CAP`。部署 ID 固定到一次交付；目录必须在 Git 仓库外且受控可写。先停用同 Gas 账户的其他 EAS 任务，再执行只读预览：

```sh
npm run chain:deploy
```

检查预测地址、nonce、Gas 上限和余额；确认源码已提交且工作区干净。签名入口由受控环境注入后执行：

```sh
npm run chain:deploy -- --execute
```

部署脚本按顺序部署两份合约，写入 checkpoint，核实双 RPC 收据、runtime code hash 和 EIP-712 域，输出 `<MEMO_DEPLOYMENT_DIR>/<MEMO_DEPLOYMENT_ID>.manifest.json` 与 `manifestSha256`。出现提交结果未知或超时，应从原 checkpoint 恢复，不得换部署 ID 盲目重发。将 manifest 路径和输出 SHA-256 配为 `MEMO_CHAIN_MANIFEST_PATH`、`MEMO_CHAIN_MANIFEST_SHA256`；保留部署清单原件及访问控制。

## 3. API 与 Worker

另设 `DATABASE_URL`、`MEMO_PLATFORM_ORIGIN`、`MEMO_SUBMISSION_DIRECTORY`、`MEMO_MINIMUM_BALANCE_WEI`、`MEMO_GAS_PRICE_CAP_WEI`、`MEMO_GAS_LIMIT_CAP`、`MEMO_CHAIN_WRITES_ENABLED=true`、`MEMO_ALLOW_FINALITY_FALLBACK=false`，并复用上述 manifest、RPC 和 signer。Journal 目录必须在仓库外的持久卷，只运行**一个** Worker 和 Relayer 实例。Worker/Indexer 与 API 使用同一 PostgreSQL 数据库，数据库迁移在首次启动时自动创建表。

```sh
npm run build
npm start
```

在另一个受控进程中运行：

```sh
npm run worker
```

检查 `GET http://127.0.0.1:4273/api/v1/ready` 返回 `ok=true`、`writesEnabled=true`、`databaseReady=true`。`/health` 只表示进程存活。若对外提供服务，须在可信 HTTPS 反向代理后绑定 `0.0.0.0` 并设置 `MEMO_BEHIND_TRUSTED_PROXY=true`；Console 和 API 保持同源。

## 4. Agent 注册与用户管理

在独立 Skill 目录执行 `npm ci --omit=dev`。将 `MEMO_AGENT_OPBNB_API_URL` 指向可信平台地址；从已核对的 manifest 将两个 Agent Registry 地址分别设为 `MEMO_AGENT_OPBNB_DID_REGISTRY`、`MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY`。Skill 使用 `~/.memo-agent-opbnb-testnet` 和独立 OS 钥匙串命名空间。

```sh
node bin/memo-agent-opbnb-testnet identity ensure
node bin/memo-agent-opbnb-testnet register /absolute/path/profile.json /absolute/path/document.json
```

`profile.json` 和 `document.json` 为 JSON 对象。注册命令创建 Agent 会话、本地复算 EIP-712 digest、提交签名并轮询 operation。保存返回的 DID、digest、operationId、txHash、blockHash、finalitySource。只有 `CONFIRMED` 才表示链上注册完成。

Manager 在 `http://127.0.0.1:4273` 打开 Console，连接 chain 5611 钱包，填入 Agent DID、权限范围、期限和公开可发现选项，创建并签署管理意图。把意图 ID 发给 Agent。Agent 先查看完整字段，再按明确的管理授权请求签署：

```sh
node bin/memo-agent-opbnb-testnet management pending
node bin/memo-agent-opbnb-testnet management inspect <intentId>
node bin/memo-agent-opbnb-testnet management approve <intentId>
```

Manager 在 Console 点击“Agent 签名后提交”。API 仅在 Manager 与 Agent 的签名均有效时入队。Worker 使用稳定 `requestId` 提交；若结果未知，继续查询同一 operation。Console 的 `CONFIRMED` 和 `GET /api/v1/management/:did` 的 `live=true` 共同证明关系有效。

## 5. 验收记录

每次真实验收至少记录：source commit、manifest SHA-256、两个合约地址与部署区块、Agent DID、Manager **公开地址**、两个 action digest、两个 operationId、两个 txHash、blockNumber/blockHash、finalitySource、DID 解析结果、关系 `live`/scope hash/到期时间。重启 API 和 Worker 后再次读取 operation、DID 和关系。记录不得含私钥、助记词、bearer token、签名原文或原始 Journal。离线测试与只读预检不能替代真实链交易验收。
