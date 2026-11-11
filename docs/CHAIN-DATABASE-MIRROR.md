# opBNB 链上数据的 PostgreSQL 镜像与运维

## 保存范围

Worker 从部署清单中的合约部署块开始，使用双 RPC 读取两份合约的业务事件。每个原始事件保存在 `chain_events`，同时投影为三类当前状态：

| 表 | 内容 |
| --- | --- |
| `chain_identity_mirror` | DID 账户、状态、revision、nonce、公钥哈希、Profile 哈希、文档哈希及来源交易/区块 |
| `chain_relationship_mirror` | Manager、关系 ID 哈希、权限哈希、到期时间、公开可发现、结束标记、revision、nonce 及来源交易/区块 |
| `chain_revoked_credential_mirror` | 每个 DID 已撤销的实例凭证哈希及来源证据 |
| `chain_events` | 全部链上业务事件原文，可重放与审计 |
| `index_cursor` / `chain_projection_checkpoint` | 日志读取位置、镜像完成位置和链上 finalized 区块 |

合约只保存哈希的 Profile、文档和权限，不可能从链上反推出原文。经本平台提交的原文保存在 `agent_document_versions`、`intents`；解析时只读取哈希匹配且链上操作已确认的版本。其他系统直接写链的原文必须从其提交方另行取得。Agent 私钥、Manager 钱包私钥均不进入镜像。

## 同步与恢复规则

Worker 在同一个 PostgreSQL 事务中插入原始事件、更新镜像和推进游标。日志读取失败、事件缺口或数据库写入失败会回滚整个批次并重试。首次运行新版 Worker 时，如果已有 `chain_events` 而没有镜像检查点，会从现存事件自动重建。链重组经双 RPC 核实后会清除该部署的事件与镜像，游标退回部署前一块，再从规范链重新索引；其他部署的数据不受影响。

需要只同步镜像、不使用 Gas 签名入口时，先构建，再运行以下命令。`--once` 只处理一个最多 2000 区块的批次；去掉 `--once` 可持续追赶链头并每三秒轮询。这个模式不执行 `submitOne` 或交易对账，不发送交易。不要与另一索引 Worker 同时长期运行。

```sh
npm run build
MEMO_CHAIN_WRITES_ENABLED=false node \
  --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" \
  dist/apps/chain-worker/src/main.js --index-only --once
```

镜像可能包含尚未 finalized 的区块。详情接口的 `identityFinalized`、`relationshipFinalized` 和凭证的 `finalized` 标明相应数据是否达到当前 finalized 区块。业务上仍以合约读取和最终性判定为准。`chain-mirror/agents/:did/verify` 先核实索引区块仍在规范链，再从双 RPC 读取最新合约状态：revision 未领先时比较字段并返回 `MATCH` 或 `MISMATCH`；链上有新动作而索引尚未追上时返回 `CHAIN_AHEAD`。当前公共 RPC 不稳定支持历史区块的合约读取，因此这个接口不自动改写数据库。

## 检索 API

API 启动后，可在本机访问以下只读接口；示例使用 `http://127.0.0.1:4273`：

```sh
curl -s 'http://127.0.0.1:4273/api/v1/chain-mirror/status'
curl -s 'http://127.0.0.1:4273/api/v1/chain-mirror/agents?status=ACTIVE&limit=20'
curl -s 'http://127.0.0.1:4273/api/v1/chain-mirror/agents?manager=0x2222222222222222222222222222222222222222'
curl -s 'http://127.0.0.1:4273/api/v1/chain-mirror/agents/did:memo:agent:5611:0x1111111111111111111111111111111111111111'
curl -s 'http://127.0.0.1:4273/api/v1/chain-mirror/events?eventType=RelationshipTransferred&limit=20'
curl -s 'http://127.0.0.1:4273/api/v1/chain-mirror/agents/did:memo:agent:5611:0x1111111111111111111111111111111111111111/verify'
```

`agents` 支持 `did`、`status`、`manager`、`after` 游标与最多 100 条的 `limit`。`events` 支持 `agentDid`、`eventType`、`txHash`、`beforeBlock`、`beforeLogIndex` 和最多 100 条的 `limit`。状态和普通查询只读取 PostgreSQL，即使 RPC 暂时不可用仍可检索；`verify` 需要 RPC。

## 日常检查与数据库备份

1. 检查 `/chain-mirror/status`：`READY` 表示数据库镜像与索引游标一致；`caughtUpToFinalized` 和 `blocksBehindFinalized` 显示是否追上已最终确认区块。记录 `indexedBlockNumber`、`finalizedBlockNumber`、`updatedAt` 和数量，可与 `/api/v1/chain/blocks/latest` 比较。`NOT_INDEXED` 表示 Worker 尚未完成首批索引；`OUT_OF_SYNC` 表示游标与投影检查点不一致，应检查 Worker 日志。
2. 对重点 DID 调用 `/chain-mirror/agents/:did/verify`。`matches: false` 时保留返回的差异和区块哈希，检查日志与双 RPC；不要手工改镜像表。
3. 定期备份 **整个** PostgreSQL 数据库，因为链上只有哈希，平台原文和操作审计无法单靠链恢复。先通过受控的 `PGHOST`、`PGPORT`、`PGDATABASE`、`PGUSER`、`PGPASSFILE` 配置连接，再执行 `pg_dump --format=custom --file=/受保护目录/agent-did-YYYYMMDD.dump`；不要把含密码的数据库 URL 放在命令行参数中。备份目录与文件仅授权运维账户访问，定期在独立测试库使用 `pg_restore` 验证可恢复。
4. 若数据库丢失但合约仍在，可重新索引恢复链上字段、撤销记录和事件；平台原文、链下配对、会话与操作历史需要数据库备份恢复。

不要直接删除或修改 `chain_events`、镜像表及游标。Worker 使用同一个持久 PostgreSQL，并保持单实例索引；API 可独立重启。镜像 schema 在 API 或 Worker 调用 `PlatformDb.init()` 时增量建立，不重置已有 DID、operation 或管理关系。

代码更新后必须以新构建结果重启现有 API 和**唯一**的 Worker。若旧 Worker 仍在运行，不能再启动 `--index-only`：两个进程会竞争 `index_cursor`，只索引批次会以 `CURSOR_CONFLICT` 回滚。新版 Worker 首次运行会自动从已有 `chain_events` 回放镜像，随后继续同步新事件。确认新 Worker 已运行后再检查状态与重点 DID 的 `verify` 结果。
