# Agent DID 管理平台（opBNB Testnet）

Leader 在 Mac 本机运行时，先执行 `npm run local:configure` 生成本机配置，具体步骤见 [Mac 本机配置](docs/MAC-LOCAL-SETUP.md)。

本分支提供 chain 5611 的 Agent DID 注册、Invitation/Offer 双向配对、多 Agent Console、身份生命周期及用户管理关系。Agent 用独立测试链 Skill 保存密钥并签署 EIP-712 意图，用户用 Console 浏览器钱包签署管理意图，API 将双方签名和配对状态记录在 PostgreSQL，Worker 通过单 Relayer 提交交易并等待最终性。达到 `CONFIRMED` 后，DID 和管理关系可由只读 API 查询。

## 当前状态

| 环节 | 状态 |
| --- | --- |
| Solidity 合约、双 RPC 链适配器、部署与只读预检 | 已实现；离线编译和测试通过 |
| API、PostgreSQL、Worker、Console、独立测试链 Skill | 完整交互代码已接入；离线测试通过；Offer、Invitation、Profile 更新、暂停/恢复和实例撤销已在真实测试链完成隔离验收 |
| opBNB Testnet 双 RPC 网络预检 | 已通过，链 ID 和 genesis 匹配 |
| Agent 专用 Registry 部署及真实 Agent/Manager 交易 | **已通过隔离测试验收**：两份合约已部署，Agent DID 注册与 Manager 双签关系均为 `CONFIRMED`；见[公开证据](deploy/testnet/ACCEPTANCE-2026-11-09.md) |

`MEMO_EAS_ADDRESS` 和 Schema UID 是既有 Memo EAS 配置，不是本系统的 Agent 专用 Registry 部署地址。
真实部署 manifest 与 signer 保存在受控本机运行目录，不提交到 Git；其他环境不能仅靠拉取分支就获得链写入能力。

## 文档与目录

- [本机快速上手](docs/QUICK-START-LOCAL-OPBNB.md)：每条关键命令、预期结果、系统地址及 Agent 注册和钱包绑定全流程。
- [完整交互手册](docs/FULL-INTERACTION-OPBNB.md)：Invitation/Offer、Dashboard、生命周期、实例、告警与审计。
- [完整交互测试链证据](deploy/testnet/FULL-INTERACTION-ACCEPTANCE-2026-11-09.md)：两个隔离 Agent 的交易、区块和最终性记录。
- [本机运行、完整测试与测试数据](docs/LOCAL-RUN-AND-TEST-DATA.md)：当前 Mac 的可复制命令、已有链上数据查询、新隔离 Agent 流程和专用测试数据库。
- [测试链部署与验收手册](docs/OPBNB-TESTNET-RUNBOOK.md)：配置、部署、API/Worker、Console/Skill 操作与证据格式。
- [链交互协议](packages/contracts/PROTOCOL.md)：合约动作、EIP-712 字段和事件。
- [跨团队接口契约](docs/BLOCKCHAIN_INTEGRATION_CONTRACT.md)：输入输出及错误语义。
- `packages/contracts`：Solidity 合约和编译产物。
- `packages/chain-adapter`：双 RPC 校验、部署清单、提交 Journal、最终性与事件读取。
- `apps/api`：会话、意图、签名、查询 API 与 PostgreSQL 存储。
- `apps/chain-worker`：提交、收据对账和事件索引。
- `apps/console`：浏览器钱包登录、双向文件配对、多 Agent 管理和审计界面。
- 相邻仓库 `memo-agent-did-mainnet-skill/skills/memo-agent-did-opbnb-testnet`：独立测试链 Skill。它使用独立状态目录和钥匙串命名空间，不迁移 chain 985 身份。

## 离线验证

要求 Node.js `>=22.5.0`：

```sh
npm ci
npm run build
npm test
```

`npm test` 默认跳过 PostgreSQL 集成用例。完整测试需专用**测试数据库**；用例会清空其业务表，不能指向业务数据库：

```sh
TEST_DATABASE_URL='postgresql://user:password@127.0.0.1:5432/agent_did_test' npm test
```

只读测试链预检无需私钥或部署清单：

```sh
npm run chain:preflight
```

完整运行需受控环境提供 `DATABASE_URL`、部署清单与 SHA-256、双 RPC、Relayer signer、持久 Journal 和预算上限，参见部署手册。未设置这些值时，`GET /api/v1/health` 只表示进程存活；`GET /api/v1/ready` 会拒绝服务。
