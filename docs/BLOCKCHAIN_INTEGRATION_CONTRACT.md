# 区块链工程输入、交付物与平台对接契约 v1

> 适用范围：Agent DID 管理平台接入**一条独立的远程 EVM 测试链**。这是跨团队的接口基线，当前仓库尚未实现这些接口；本文件不是部署结果。目标链尚未确定，所有地址、chain ID、genesis hash、RPC 与确认数必须经实测填入。若选非 EVM 链，先提交新的协议版本和迁移方案，不得把 EVM 字段改名后继续沿用 v1。

本文件与[业务需求](BLOCKCHAIN_REQUIREMENTS.md)、[网络资料表](../deploy/testnet/NETWORK_INPUTS.md)、[交付验收单](../deploy/testnet/DELIVERY_CHECKLIST.md)、[动作字段机器表](../specs/chain-integration-v1/action-types.json)、[部署清单 JSON Schema](../specs/chain-integration-v1/deployment-manifest.schema.json)、[意图 JSON Schema](../specs/chain-integration-v1/action-intent.schema.json)和[规范化事件 JSON Schema](../specs/chain-integration-v1/normalized-event.schema.json)组成交接包。**“已约定”指字段和行为；“待填”只指链的真实参数与部署证据。**任何改变签名字段、状态语义或客户端可见 JSON 的决定都要先更新本文件和版本号，再改代码。

## 1. 双方各自交什么

### 1.1 平台团队在链工程开工前提供的输入

| 编号 | 输入文件/信息 | 平台保证的内容 | 链工程师据此完成 |
| --- | --- | --- | --- |
| P-01 | 本文件、业务需求与测试链资料表 | DID 注册、解析、生命周期、管理关系、实例撤销的功能边界和验收用例 | 合约/链模块设计、缺口清单 |
| P-02 | API 外壳和响应包装 | NestJS API、`memo.agent-api-result/1` 包装、`/health`、`/ready`、`/chain/config` 停写入口 | 适配器接口与公共配置字段，不直接改前端或 API 路由 |
| P-03 | 用户与密钥责任 | Agent Identity Key 在 Agent 客户端；钱包签管理动作；服务密钥只支付/转发交易 | 签名校验、权限矩阵和交易提交方式 |
| P-04 | 链下数据边界 | Profile/DID Document 原文、Pairing Invitation/Offer、租户与会话属于平台；链上只保存必要的 hash/状态 | 合约存储最小化、事件字段和索引方案 |
| P-05 | 对接目标 | TypeScript/Node 22、HTTP JSON、远程测试链；业务服务不直接操作私有 RPC | `packages/chain-adapter` 的接口、错误映射和发布方式 |
| P-06 | Git 基线与目录所有权 | 本仓库 `main` 为待接入外壳；旧实现位于 Git 历史 `37da76a`，只供参考 | 分 PR 提交，不覆盖平台文件或恢复旧 chain 985 常量 |

平台团队还需在集成 PR 前提供测试 Agent 与钱包的**公开地址**、一次性测试 Profile/Document、允许的管理 scope 列表、测试 HTTPS origin、数据库/对象存储接入接口。测试私钥由各自持有人管理，不作为交接输入。

### 1.2 链工程师完成后必须交回的输出

| 编号 | 交付物 | 固定格式/最低内容 | 谁验收 |
| --- | --- | --- | --- |
| C-01 | 网络决策与只读预检 | 填完 `deploy/testnet/NETWORK_INPUTS.md`；主备 RPC 的 chain ID/genesis/同高度 hash、能力与时间戳；不含 token | 平台 + 运维 |
| C-02 | 协议说明与测试向量 | DID 生成、所有 EIP-712 domain/type/message、hash 算法、nonce/revision、角色权限、成功/失败签名向量；JSON 文件或文档，双方可独立重算 digest | 平台 + Agent 客户端 |
| C-03 | 合约源码与 ABI | `packages/contracts/**`；编译器锁定版本、ABI、部署字节码/运行时 hash、事件 schema、单元与安全测试、管理员/升级策略 | 平台 + 安全评审 |
| C-04 | 链适配器 | `packages/chain-adapter/**`；实现第 4 节接口及错误映射，私有 RPC/交易服务配置仅在服务侧；不依赖 API/Console 内部文件 | 平台 |
| C-05 | 部署清单 | 一份符合 JSON Schema 的 `memo.agent-chain-deployment/1` JSON；附文件 SHA-256、合约部署 tx/block 证据和双 RPC 在线校验报告 | 平台 + 运维 |
| C-06 | 交易通道 | 普通 Relayer 或 ERC-4337 的可部署配置、资金地址、私有签名/KMS 集成、费率/重试策略、监控指标；凭据通过密钥管理器交付 | 运维 + 平台 |
| C-07 | 事件与恢复方案 | 从部署块索引、游标/去重、日志失败重试、重组回放、链重置作废的可执行说明和自动化测试 | 平台 |
| C-08 | 远程测试链证据 | 脱敏报告：DID、operationId、action digest、tx hash、block hash、确认数、解析结果、失败/恢复用例与 UTC 时间 | 三方 |

**交付完成的判定**：上述文件可从仓库或受控发布工件取得；`C-05` 与真实测试链一致；平台能只依赖 `C-04` 完成读/写/事件集成；C-02 的 digest 与客户端独立实现逐字节一致；所有验收用例有证据。仅交一组 RPC/合约地址或一笔成功交易不算完成。

## 2. 第一版协议固定约定

### 2.1 网络、DID 与内容 hash

- 网络标识为 `eip155:<chainId>`，`chainId` 为十进制正整数，且**不能是旧主网 985**。部署指纹为 `(chainId, genesisHash, deploymentId, DID Registry 地址, Management Registry 地址)`；启动和每次写入前核对链 ID、genesis、合约运行时 hash。CAIP-2 格式见[原规范](https://standards.chainagnostic.org/CAIPs/caip-2)。
- DID 字符串定为 `did:memo:agent:<chainId>:<lowercase-0x40位地址>`。这是本项目 v1 DID 方法约定；链工程师需交 DID 方法解析规则，平台和 Agent 客户端用同一套校验。DID Document 的公开字段遵循[W3C DID Core](https://www.w3.org/TR/did-core/)；服务地址是否公开由用户选择。
- Agent 身份密钥为 secp256k1 EOA。`identityAccount` 是其以太坊地址；`identityPublicKeyHash` 定为 `keccak256(X || Y)`，其中 `X || Y` 是 64 字节未压缩公钥坐标，且该 hash 的末 20 字节必须等于身份地址。若选择合约身份账户，须升级协议版本并说明签名恢复方法。
- Profile 与 DID Document 先按 [RFC 8785 JCS](https://www.rfc-editor.org/rfc/rfc8785.html) 规范化为 UTF-8 字节，再取 `SHA-256`，保存 32 字节 hash；原文留在受访问控制的平台对象存储。scope 列表先去重、按 Unicode 码点升序排序，再对其 JSON 数组执行同样的 JCS+SHA-256。链工程师交至少一个多语言测试向量。**旧实现的自定义 JSON 排序算法不得被默认为 v1 规则。**
- `relationshipIdHash`、`reasonHash`、`successorDidHash` 和 `credentialIdHash` 是 `keccak256(UTF-8 原始标识符)`；`0x00…00` 不能作为有效 hash。若上述 hash 算法需变更，必须同步修改 C-02、客户端和 schema 版本。

### 2.2 签名域、签署人和 nonce

EIP-712 domain 必含 `name`、`version`、`chainId`、`verifyingContract`；`chainId` 和合约地址来自已验证清单，不能从远端 intent 原样信任。身份动作域名固定 `MEMO Agent DID Registry`，管理动作域名固定 `MEMO Agent DID Management`，两者版本均为 `1`。客户端本地重建 typed data/digest，逐字段比对后签名；平台和合约各自验证。[EIP-712](https://eips.ethereum.org/EIPS/eip-712)提供域分离和结构化签名规范。

下表与[动作字段机器表](../specs/chain-integration-v1/action-types.json)共同固定字段名、类型和顺序。机器表是客户端、平台及合约测试的输入；若文字和机器表不一致，在 G1 阶段停工修正并三方签字，不能任选一方实现。

| 动作 | 签署人 | 必须进入签名消息的字段 | 链上结果/事件 |
| --- | --- | --- | --- |
| `RegisterAgent` | Agent | `identityAccount, identityPublicKeyHash, documentHash, profileHash, expectedRevision=0, nonce, deadline` | Active、revision=1；`AgentRegistered` |
| `UpdateProfile` / `UpdateDocument` | Agent | `identityAccount, profileHash` 或 `documentHash`，以及 `expectedRevision, nonce, deadline` | revision+1；对应更新事件 |
| `SuspendAgent` / `ResumeAgent` / `RevokeAgent` | Agent | `identityAccount, expectedRevision, nonce, deadline` | 状态与 revision 更新；`AgentStatusChanged` |
| `RevokeInstanceCredential` | Agent | `identityAccount, credentialIdHash, expectedRevision, nonce, deadline` | 凭证不可再有效；`InstanceCredentialRevoked` |
| `ActivateRelationship` | Agent + 新 Manager | `agent, manager, relationshipIdHash, scopesHash, issuedAt, expiresAt, discoverable, expectedRevision, nonce, deadline` | Active；`RelationshipActivated` |
| `RenewRelationship` | Agent + 当前 Manager | `agent, manager, relationshipIdHash, scopesHash, expiresAt, discoverable, expectedRevision, nonce, deadline` | revision+1；`RelationshipRenewed` |
| `EndRelationship` | Agent **或**当前 Manager | `agent, manager, relationshipIdHash, actor, reasonHash, expectedRevision, nonce, deadline` | Ended；`RelationshipEnded` |
| `TransferRelationship` | Agent + 原 Manager + 新 Manager | `agent, oldManager, newManager, oldRelationshipIdHash, newRelationshipIdHash, scopesHash, expiresAt, discoverable, expectedRevision, nonce, deadline` | 新关系；`RelationshipTransferred` |

签名消息里的 `uint64/uint256`（nonce、revision、deadline、期限）在 API JSON 中使用**无前导零的十进制字符串**，链上按 ABI 类型编码；网络 chain ID、区块高度、确认数等安全整数用 JSON number。时间为 UTC Unix 秒。字段类型固定：地址为 `address`，所有 `*Hash` 为 `bytes32`，`expectedRevision/issuedAt/expiresAt/deadline` 为 `uint64`，`nonce` 为 `uint256`，`discoverable` 为 `bool`；字段**顺序**按上表排列。意图的 `types` 只能有与 `actionType` 同名的一项，`message` 只能含表中字段，`digest` 必须能从 domain/types/message 独立重算；见[意图 Schema](../specs/chain-integration-v1/action-intent.schema.json)。`expectedRevision` 为当前链上 revision；身份与管理 Registry 各自维护按 Agent 划分的 nonce，初值 0，成功动作加 1。每个 action 都有正的 `deadline`，平台使用链头时间构建短期 intent；过期、未知字段、字段缺失、重放 nonce、错误 revision、错误 domain 均拒绝。管理动作的 Manager 可以是 EOA 或支持 [ERC-1271](https://eips.ethereum.org/EIPS/eip-1271) 的合约钱包；C-02 必须给两种签名的成功/失败向量。高风险动作（永久撤销、继任者）还需平台侧独立审批；继任者作为 v1.1 增量，不阻塞 v1 注册验收。

`relationshipId`、实例凭证 ID 为 1–128 字符的 ASCII 标识，字符限 `[A-Za-z0-9._:-]`；`scopes` 是 1–64 个唯一的 ASCII scope，每项 1–128 字符，字符限 `[A-Za-z0-9._:-]`。scope 的业务含义由平台维护版本化词汇表，链只验证签名中的 `scopesHash`，不据此授予 Gateway 资源权限。`reasonHash` 仅对公开的固定原因代码 `AGENT_ENDED`、`MANAGER_ENDED`、`SECURITY_REVOCATION` 取 hash，不对用户输入的自由文本直接哈希上链。C-02 为这些值和至少两组 scope 提供测试向量。

身份状态仅允许 `NONE → ACTIVE → SUSPENDED → ACTIVE`，`ACTIVE/SUSPENDED → REVOKED`；`REVOKED` 不可恢复。管理关系只在 Agent 为 `ACTIVE` 时建立/续期；到期即不再有效，结束动作可由任一有权参与者单方发起，转移需要三方签名。C-03 必须给每个动作的合约函数、事件、错误与状态转移表；事件要包含身份/Manager 索引、revision、nonce 和 action digest，供 Indexer 去重与审计，并映射为[规范化事件](../specs/chain-integration-v1/normalized-event.schema.json)。

**v1 数据基数与版本规则**：一个 Agent 在管理 Registry 中最多只有一条当前关系；历史关系通过事件查询。身份 Registry 与管理 Registry 各自为每个 Agent 保存一个全局 `revision` 和“下一个可用” `nonce`。注册成功后的身份 `revision=1`、`nonce=1`；其他成功动作各使对应 Registry 的两者加 1，失败交易均不改变。管理 Registry 的首次动作使用 `expectedRevision=0, nonce=0`；关系到期或结束后可创建新关系，但必须携带当时的管理 revision/nonce。`Renew/End/Transfer` 只能针对当前关系 ID；`Transfer` 原子结束旧关系并建立新关系，仅消耗一次管理 nonce、增加一次管理 revision。链事件中的 `revision` 是**执行后**值，`nonce` 是**本次消耗的**值；reader 返回的 `nonce` 是下一次可用值。原关系到期不自动消耗 nonce 或增加 revision，`live=false` 由链头时间与 `expiresAt` 计算。

`reasonHash` 的原因代码、scopes 词汇表及链下原文只由平台持久化并关联到 intent；合约只见 hash。身份 `SUSPENDED` 或 `REVOKED` 后，管理关系不得作为有效授权展示；恢复后仍需检查关系本身未结束且未到期。实例撤销按 `(Agent, credentialIdHash)` 存储，重复撤销必须拒绝或返回明确的幂等结果，不能追加第二个成功事件。

### 2.3 Pairing 不属于链团队写入范围

Invitation 与 Offer 是链下的一次性文件交换，由平台团队实现。链工程师只需提供管理关系的签名/读写接口，并让平台在链上关系 `CONFIRMED` 后查询其真实状态。`PAIRED` 不能被解释成 `MANAGEMENT_ACTIVE`；配对 handle、会话 bearer、Profile 原文不写链或事件。

## 3. 链适配器的输入和输出

链工程师在 `packages/chain-adapter` 实现以下**逻辑接口**；TypeScript 方法名可在联合 PR 中调整，但参数、返回语义及错误分类不能无版本变更。适配器是被 API/Worker 调用的内部库，不暴露新公共 HTTP 服务。

| 方法 | 平台传入 | 适配器返回 | 必须遵守 |
| --- | --- | --- | --- |
| `verifyDeployment(manifest)` | 只读清单、私有主/备 RPC 句柄 | `verified: true`、两端 chain ID/genesis/head、代码 hash、部署区块 hash、检查时间 | 任一不符抛 `DEPLOYMENT_MISMATCH`；不广播 |
| `readIdentity(identityAccount, blockTag)` | 身份地址、`latest` 或 `finalized`/高度 | 状态、revision、nonce、publicKeyHash、documentHash、profileHash、来源 block number/hash | 不读取 Profile 原文；明确来源区块 |
| `readRelationship(agent, blockTag)` | Agent 地址、块标签 | Manager、关系 ID/hash、scope hash、期限、状态、revision、nonce、来源块 | `live` 由状态与链头时间共同计算 |
| `buildIntent(actionType, payload, chainSnapshot)` | 精确业务字段、已验证部署指纹、当前链快照 | EIP-712 domain、types、message、digest、所需签署人、deadline | 无未知/缺失字段；digest 可被客户端独立重算 |
| `verifySignedAction(intent, signatures)` | 已存 intent、Agent/Manager 签名 | signer 集合与验证结果 | EOA 与 ERC-1271 校验；不接受错误网络或过期 intent |
| `submitSignedAction(intent, signatures, requestId)` | 完整签名动作、平台持久化的 requestId | `submissionId`、可选 txHash/userOpHash、`acceptedAt`、状态 `SUBMITTED` 或明确不确定 | 先做链读/模拟；不得代 Agent 签名；重试不能创建第二个业务动作 |
| `getSubmission(submissionId)` | 先前提交标识 | `PENDING/INCLUDED/REVERTED/DROPPED/UNKNOWN`、receipt、block/tx hash、费用 | `UNKNOWN` 不等于失败；保留原标识用于对账 |
| `readEvents(from, to)` | 包含端点的区块范围、已验证部署 ID | 按 `(blockNumber, txIndex, logIndex)` 排序的规范化事件数组、范围头 hash 与 `complete: true` | 所有分片读取成功后才可标记 complete；失败不能返回空数组表示成功 |
| `readBlock(heightOrTag)` | 高度或标签 | number、hash、parentHash、timestamp、finality 来源 | 用于规范链检查与重组回放 |

异常必须归入 `NETWORK_MISMATCH`、`DEPLOYMENT_MISMATCH`、`CHAIN_UNAVAILABLE`、`CHAIN_STATE_UNCERTAIN`、`INVALID_ACTION`、`INVALID_SIGNATURE`、`NONCE_CONFLICT`、`ACTION_EXPIRED`、`CONTRACT_REVERT`、`SUBMISSION_UNKNOWN`、`INSUFFICIENT_FUNDS`。每类错误注明是否可重试及是否可能已广播。适配器不得把原始 RPC 错误、带 token 的 URL 或签名原文写入日志。平台把这些内部错误映射为第 5 节 HTTP/operation 状态。

接口的共同参数 `deploymentId` 必须和已验证清单一致；`requestId` 为平台生成并持久化的 UUID，同一个业务动作重试时不变。返回的 `submissionId` 是适配器稳定生成的内部标识，允许在广播响应丢失时由 `requestId` 查询。`UNKNOWN` 表示状态暂时无法确定，禁止改用新 requestId 补发。`getSubmission` 返回 `INCLUDED` 时必须带 receipt `status=success`、`txHash`、`blockNumber`、`blockHash`、`gasUsed` 和匹配 `actionDigest` 的事件；回退 receipt 必须带可归类的 revert 原因。`readEvents` 的范围头必须包含 `fromBlockHash` 与 `toBlockHash`，空结果也要给出 `complete: true` 和两端 hash；超出节点最大日志范围时内部拆分并验证每段完整后合并。

| 适配器错误 | 是否可自动重试 | HTTP（广播前）/operation（入队后） |
| --- | --- | --- |
| `NETWORK_MISMATCH`, `DEPLOYMENT_MISMATCH` | 否，停写 | 503 / 保持待处理并报警 |
| `CHAIN_UNAVAILABLE`, `CHAIN_STATE_UNCERTAIN` | 是，保留 requestId | 503 / 状态不确定，继续对账 |
| `INVALID_ACTION`, `INVALID_SIGNATURE`, `ACTION_EXPIRED` | 否 | 400/401/410 / `FAILED` |
| `NONCE_CONFLICT` | 否，需新 intent | 409 / `FAILED` |
| `CONTRACT_REVERT` | 否，保存收据 | 422 / `FAILED` |
| `SUBMISSION_UNKNOWN` | 只对账原提交 | 503 / 保持 `SIGNED` 或 `SUBMITTED` |
| `INSUFFICIENT_FUNDS` | 补资金后同 requestId 重试 | 503 / 暂停提交并报警 |

以上 HTTP 是平台对错误的最低映射；平台必须保留无泄密的公开 `error.code`，内部另记受控审计原因。已广播后不能仅因客户端超时返回新的 operation；先以 idempotency key 返回原 operationId。

如果选 ERC-4337，`submissionId` 关联 `userOpHash`，C-06 还需交 EntryPoint 版本、地址、代码 hash、Bundler 实测和 UserOperation receipt 解析；如果选普通交易，`submissionId` 关联 tx hash，保持同一平台接口。两种传输都不得改变 Agent 业务签名。ERC-4337 的 UserOperation 与 Bundler RPC 是独立的交易层，见[ERC-4337](https://eips.ethereum.org/EIPS/eip-4337)与[ERC-7769](https://eips.ethereum.org/EIPS/eip-7769)。

## 4. 部署清单：链团队到平台的机器接口

`C-05` 使用[部署清单 schema](../specs/chain-integration-v1/deployment-manifest.schema.json)，文件名建议 `<chainId>-<deploymentId>.json`。它是**公开元数据加部署证据**，不含主备私有 RPC、Bundler 凭据、deployer 私钥或 KMS token；真实文件作为不可变发布工件交付，附独立的 SHA-256，不直接提交到源码 PR。平台通过配置给出该工件的只读路径。

| 清单区块 | 必填字段 | 平台如何用 |
| --- | --- | --- |
| `network` | `name, caip2, chainId, genesisHash, publicRpcUrl, explorerUrl, nativeCurrency`；WSS 可选 | API 公共链配置、钱包网络、链身份校验 |
| `contracts.didRegistry` / `managementRegistry` | 地址、接口版本、runtime hash、ABI SHA-256、部署 tx/block number/hash、签名 domain | 客户端域校验、API 读写、Indexer 起点、错误部署拒绝 |
| `finality` | `mode, fallbackConfirmations, maxReorgDepth` | Worker 确认/回滚策略；数值由链团队实测并经平台批准 |
| `transport` | `direct-relayer` 或 `erc4337`；后者另带 EntryPoint 地址/版本/hash | Worker 选择内部提交实现；不暴露私有 Bundler |
| `deploymentId` / `sourceCommit` / `createdAt` | 唯一版本、源码提交、UTC 时间 | 发布追踪和链重置后的清单作废 |

`finality.mode=finalized-tag` 时以两个 RPC 对同一 finalized 块的 hash 一致为准；若该标签暂时不可用，只有运维在 G0 批准的 `fallbackConfirmations` 才能作为降级标准，并在 operation 的 `finalitySource` 中写 `confirmations`。`mode=confirmations` 时，成功收据所在块之后至少出现清单指定数量的规范链确认，且两端 RPC 对该块 hash 一致。确认数按 `headNumber - includedBlockNumber + 1` 计算；节点头落后或分叉时不得增加确认数。`maxReorgDepth` 是自动回滚上限，不是“超过该深度即可忽略重组”的保证。

**跨字段硬校验**：`network.caip2 === "eip155:" + chainId`；两个 domain 的 `chainId` 必须等于网络 `chainId`，`verifyingContract` 必须等于对应地址；地址与 hash 非零；部署区块在主备 RPC 上均有相同 canonical block hash；链上 `eth_getCode` hash 与清单一致。`deploymentId` 不能被重新用于不同地址/代码。ABI hash 算法为 `SHA-256(UTF-8 ABI JSON 文件原始字节)`，文件交付时不得重排；运行时代码 hash 为 `keccak256(链上 runtime bytecode)`。清单只在这些检查通过后才进入 API 公共配置。

私有配置由平台/运维维护：`MEMO_CHAIN_MANIFEST_PATH`（清单只读路径）、`MEMO_PRIMARY_RPC_URL`、`MEMO_SECONDARY_RPC_URL`、`MEMO_TRANSACTION_SERVICE_URL`（只在交易服务独立时使用）、`MEMO_RELAYER_SIGNER_URL` / `MEMO_RELAYER_SIGNER_KEY_ID` / `MEMO_RELAYER_SIGNER_TOKEN`（若服务侧签交易）、`MEMO_DATA_ROOT` 与 `MEMO_PLATFORM_ORIGINS`。带鉴权的值经密钥管理器注入，不写入 `.env.example` 的真实值。适配器启动顺序固定为：读取并校验 schema → 建立主备 RPC → 复核网络与部署锚点 → 检查交易服务和资金 → 只在全部通过后令 `/ready` 可用。合约部署需链工程师执行受控流程，平台不在 API 启动时自动部署或替换代码。测试链重置/合约更换时，先停写、作废旧清单和索引，再发布新 `deploymentId`；旧 DID 不自动迁移。

## 5. 平台 HTTP API 如何对接

平台团队负责 HTTP、鉴权、持久化、Pairing、UI 和 Agent Skill；链工程师负责第 3 节适配器与第 4 节清单。平台 API **只调用适配器**，客户端 **只调用平台 API**（钱包添加网络可使用公开 RPC）。下表是 v1 请求/响应最低合同，所有成功/失败仍使用 `memo.agent-api-result/1` 外壳。

| 路由 | 请求核心字段 | 响应 `data` 核心字段 | 链适配器调用 |
| --- | --- | --- | --- |
| `GET /api/v1/chain/config` | 无 | `deploymentId, network, contracts` 的公开子集、`finality, transport.kind, capabilities` | 启动时已完成 `verifyDeployment`；未验证返回 503 |
| `POST /api/v1/registration-intents` | Agent bearer；`identityAccount, identityPublicKeyHash, profile, document` | 符合意图 Schema 的完整对象 | `readIdentity`、`buildIntent`；完整 Profile/Document 存平台对象存储 |
| `POST /api/v1/agent-dids` | Agent bearer；`intentId, signature`；`Idempotency-Key` header | `operationId, state, actionDigest` | `verifySignedAction`；持久化后异步 `submitSignedAction` |
| `POST /api/v1/registry-action-intents` / `registry-actions` | Agent bearer；动作与相关字段；提交时签名及幂等键 | 同上 | `readIdentity`、`buildIntent`、`submitSignedAction` |
| `POST /api/v1/management-intents` / `management-actions` | 发起者的钱包或 Agent 会话；Agent、Manager、scope、期限；提交时按动作要求的签名 | `intentId` 或 `operationId`、状态 | `readRelationship`、按签署人矩阵校验、提交 |
| `GET /api/v1/operations/:id` | 所属 Agent/租户 bearer | `operationId, state, actionDigest, submissionId, txHash, blockHash, confirmations, finalitySource, errorCode` | Worker 持续 `getSubmission` / `readBlock`，HTTP 只读存储 |
| `GET /api/v1/agent-dids/:did` | DID | `did, status, revision, profileHash, documentHash, document, proof, finality` | `readIdentity` 与 Indexer 投影对账；原文 hash 必须匹配 |

**HTTP 字段约定**：`registration-intents` 请求的 `profile`、`document` 是 JSON 对象；平台按 JCS 规范化并在受控对象存储保存原文，链只收 `profileHash`、`documentHash`。平台须复核 Agent 会话、`identityAccount`、公钥和 `identityPublicKeyHash` 相互一致。响应 `data` 是完整的[意图 Schema](../specs/chain-integration-v1/action-intent.schema.json)对象；过期时间取 `message.deadline`。`registry-action-intents` 请求为 `{actionType, payload}`，`payload` 只含该动作所需的业务原文或标识；`management-intents` 同形，`payload` 为 Agent/Manager 地址、`relationshipId`、`scopes`、期限、`discoverable` 和适用的原因代码。平台计算所有 hash、revision 和 nonce，调用者不得自报这些链状态值。`registry-actions` 请求为 `{intentId,signature}`；注册提交也使用 `{intentId,signature}`。`signature` 是 `0x` 前缀的十六进制 ECDSA 签名字节或 ERC-1271 钱包约定的合约签名字节，不在日志中输出。每个签名必须与 intent 中 `requiredSigners` 的角色和地址逐项对应，不接受额外签名。

多方签名采集采用**同一不可变 intent**：创建者调用 `management-intents` 得到 `intentId/digest`，参与者从受鉴权的 `GET /api/v1/management-intents/:id` 读取完整意图并分别签名，使用 `POST /api/v1/management-intents/:id/signatures` 逐个提交 `{role,address,signature}`；平台验签并只返回已收集角色，不回显签名。收齐后任一授权参与者以 `POST /api/v1/management-actions` 的 `{intentId}` 和 `Idempotency-Key` 将对应 operation 转为 `SIGNED`；若超过 `deadline`、链状态变化或清单作废，整份意图失效，所有签名必须重取。单方 `EndRelationship` 只需要 `actor` 对应一份签名；不得把它误判为双方都必须同意。

每次创建 intent 时，平台在同一数据库事务中创建一个 `CREATED` operation，并以 `intentId` 唯一绑定；intent 接口返回 `intentId`，提交动作接口返回同一 `operationId`。签名收集不允许创建第二个 operation。intent 到期而未提交时，平台记录 `FAILED/ACTION_EXPIRED`，保留审计；重新签名必须创建新 intent 和新 operation。

所有写接口用 `Content-Type: application/json`、HTTPS、主体会话和请求体大小/速率限制；`Idempotency-Key` 是 8–128 字符 ASCII `[A-Za-z0-9._:-]`。平台以 `主体 ID + actionType + idempotency key` 作唯一索引，并保存请求体规范 hash；同键同体返回相同 `operationId`，同键异体返回 409 `IDEMPOTENCY_CONFLICT`。`GET /operations/:id` 的 `submissionId/txHash/blockHash/errorCode` 在尚未产生时为 `null`，`confirmations` 为非负整数，`finalitySource` 为 `finalized-tag/confirmations/null`；响应必须带 `deploymentId, networkId, updatedAt`。`GET /agent-dids/:did` 的 `proof` 至少包含 `deploymentId, txHash, blockNumber, blockHash, actionDigest`，未注册 DID 返回 404 `DID_NOT_FOUND`，而非链下草稿。

注册一次完整流程：Agent 先从 `/chain/config` 核对本地固定的 chain ID/genesis/Registry/API origin → Agent 登录挑战 → API 读链 nonce/revision，生成并持久化不可变 intent/`CREATED` operation → Agent 本地重算 digest 并签名 → API 验证与幂等入队，返回 operationId → Worker 通过适配器提交并按收据/区块推进状态 → `CONFIRMED` 后 Resolver 返回链上证明。管理关系由钱包发起草稿与管理 intent，Agent 通过受鉴权的待办接口核对同一 digest 并批准；收齐签名后将 operation 转为 `SIGNED`。Agent 单方结束关系时可用 Agent 会话发起，Manager 单方结束时用钱包会话。签名和提交之间若 nonce、revision、deadline 或部署指纹变化，拒绝旧 intent 并要求重新获取，不得改写已签消息。

业务写接口入队成功推荐 HTTP 202；仅因为队列接受而不能返回“注册成功”。`Idempotency-Key` 按主体+动作限定命名空间；同键同内容返回原 operationId，同键不同内容返回 HTTP 409。`SUBMISSION_UNKNOWN` 时保留原 operation，先对账同一 digest/nonce/submissionId，禁止生成第二个业务签名。未经授权的操作查询返回 404 或 403，但不能泄露其他租户的 operation 存在性。

## 6. Operation、Indexer 和恢复的逐步约定

| 平台状态 | 写入条件 | 对外含义 |
| --- | --- | --- |
| `CREATED` | intent 已持久化，尚无签名 | 未提交 |
| `SIGNED` | 所需签名全部验证且提交任务已持久化 | 可提交，不代表链已接受 |
| `SUBMITTED` | 交易服务返回可对账标识 | 已接受但可能未上链 |
| `INCLUDED` | 规范链中找到成功收据及匹配事件 | 已包含，尚未满足 finality |
| `CONFIRMED` | 达到清单指定 finality 且重新核对 canonical block hash | 才能显示“链上已确认” |
| `REORGED` | 以区块 hash/父块证据证实原包含块离开规范链 | 冻结受影响的业务投影，回放/对账 |
| `FAILED` | 明确的合约回退、过期或不可恢复错误；保存证据 | 失败终态；不靠超时猜测 |

允许前进转移 `CREATED→SIGNED→SUBMITTED→INCLUDED→CONFIRMED`；`CREATED` 可在 intent 过期时转 `FAILED`；`SIGNED/SUBMITTED/INCLUDED` 可按明确证据转 `FAILED`，`SUBMITTED/INCLUDED/CONFIRMED` 可在**证实重组**后转 `REORGED`，`REORGED` 可在原签名仍有效且 nonce 未消耗时对账/重交，否则 `FAILED`。收到较旧、较少确认数或无块 hash 的更新时，已 `CONFIRMED` 的 operation 保持原状态和证据；不能仅凭“未确认更新”降级。任何变更都追加审计事件，不覆盖原 tx/block 证据。

Indexer 从清单最早部署区块开始；游标持久化 `(blockNumber, blockHash)`。`readEvents` 失败、部分返回、超时或主备 RPC 分叉时**不推进游标**，按退避和抖动重试，恢复后重读安全窗口；同一规范日志按 `(chainId, deploymentId, blockHash, txHash, logIndex)` 去重。适配器返回的每条事件必须符合[事件 Schema](../specs/chain-integration-v1/normalized-event.schema.json)，包含 `eventType`、`agentDid`、`actionDigest`、`revision`、`nonce`、tx/block hash、交易与日志索引、区块时间和动作专属 `payload`。`payload` 的最低字段如下表，其他字段须升级 schema 后添加。检测到已记录 block hash 不匹配时，从共同祖先回滚投影并重放，链下 Pairing/审计原始记录不删除。链深度超过 `maxReorgDepth` 或测试链重置时停写并人工确认新清单。

| `eventType` | `payload` 最低字段 |
| --- | --- |
| `AgentRegistered` | `identityAccount, identityPublicKeyHash, documentHash, profileHash` |
| `ProfileUpdated` / `DocumentUpdated` | 分别为 `profileHash` / `documentHash` |
| `AgentStatusChanged` | `status`（`ACTIVE/SUSPENDED/REVOKED`） |
| `InstanceCredentialRevoked` | `credentialIdHash` |
| `RelationshipActivated` / `RelationshipRenewed` | `manager, relationshipIdHash, scopesHash, expiresAt, discoverable` |
| `RelationshipEnded` | `manager, relationshipIdHash, actor, reasonHash` |
| `RelationshipTransferred` | `oldManager, newManager, oldRelationshipIdHash, newRelationshipIdHash, scopesHash, expiresAt, discoverable` |

必须交自动化回归用例：`readEvents` 第一次失败、第二次成功且不丢事件；重复日志不重复投影；已确认状态遇到未确认更新保持确认；真实 block hash 变化才允许 `REORGED`；进程重启后从原游标继续；提交响应丢失时同一动作只处理一次。测试必须区分模拟故障与真实测试链证据。

## 7. 分 PR 合入和验收门槛

| 阶段 | 链工程师输出 | 平台对接动作 | 合入/放行证据 |
| --- | --- | --- | --- |
| G0 网络决策 | C-01、风险和费用说明 | 审核网络与 DID 唯一性，填写第 8 节决策 | 主备链指纹、签名/交易能力实测；无链参数占位值用于写入 |
| G1 协议冻结 | C-02、C-03 的接口/事件/错误草案 | 同步 Agent 客户端 typed data、API schema、数据库模型 | 正反签名向量逐字节一致；权限矩阵评审通过 |
| G2 链模块 PR | C-03、C-04、离线测试 | 只通过接口调用；检查无链私钥进业务模块 | 合约测试、安全审查、适配器错误/重试测试通过 |
| G3 部署发布 | C-05、C-06、在线校验 | 只读挂载清单，注入私有配置，启动 guard 和 Worker | 双 RPC 校验、代码/ABI hash、资金、签名桥和 ready 检查通过 |
| G4 业务联调 | C-07、C-08 | 接入 API/Skill/Console、Pairing 与审计 | 远程测试链注册/解析/管理/恢复全流程证据，隐私与越权测试通过 |

链工程师可独立改 `packages/contracts/**`、`packages/chain-adapter/**`、链模块测试及 `deploy/testnet/**` 的**模板/脚本**；平台团队改 `apps/api/**`、未来 `apps/chain-worker/**`、数据库/对象存储；Agent/前端团队改 `apps/console/**` 和独立 Skill 仓库。共享的 schema、动作字段、DID 方法与本文件由三方联合 PR 修改。实际部署 JSON、凭据、签名材料和日志不提交 Git。

G4 最低证据：网络 chain ID/genesis、清单 SHA-256、Agent DID、注册/管理 action digest、operationId、tx/userOp hash、block hash、确认数/最终性来源、Resolver 结果、测试时间、测试人；异常用例至少覆盖错误链、错误 domain、重放 nonce、过期 intent、Manager 合约钱包签名、RPC 分叉、日志失败重试、已确认状态不降级和真实重组或经标注的故障注入。没有真实重组条件时，报告写“真实重组未验证”，不能把模拟结果写成真实链证据。

## 8. 仍需链方实测填写的唯一变量

下表是**执行前的签字门**，并非允许实现自行猜测的默认值。P-01 到 C-08 的字段/行为约定保持不变；任何一行不同意，就在 G0/G1 提出变更并更新版本。

| 变量/决策 | 链工程师填写 | 平台确认 | 未确认时 |
| --- | --- | --- | --- |
| 测试链名称、chain ID、genesis、是否会重置 | 待填 | 待签 | 不创建测试身份、不部署 |
| 主/备/公开 RPC 与可选 WSS、日志能力 | 待填 | 待签 | 不启动链适配器 |
| 交易传输：direct-relayer 或 ERC-4337、资金/KMS | 待填 | 待签 | 不广播 |
| DID/Management 合约地址、ABI、代码 hash、domain | 部署后填 | 待签 | `/chain/config` 和 `/ready` 保持 503 |
| finality 模式、确认数、最大重组深度 | 待填 | 待签 | 不标记 `CONFIRMED` |
| Profile/Document 存储与数据公开策略 | 联合填写 | 待签 | 不接收真实资料 |
| 部署清单位置/SHA-256、运维负责人 | 部署后填 | 待签 | 不放行 G3/G4 |

当前 API 外壳仍返回 `BLOCKCHAIN_NOT_IMPLEMENTED`。只有 G0–G3 的真实网络与部署校验通过，平台团队才能将其改为按验证结果返回配置/就绪；不得为联调临时把 503 改成固定成功。
