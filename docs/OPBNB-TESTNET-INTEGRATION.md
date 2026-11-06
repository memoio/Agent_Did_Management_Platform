# opBNB 测试链模块交接说明

日期：2026-11-06。范围：链合约、内部 TypeScript 适配器、受控部署和链方测试。依据为 [需求](BLOCKCHAIN_REQUIREMENTS.md)、[对接契约](BLOCKCHAIN_INTEGRATION_CONTRACT.md)及既有机器规格。

本日后续按用户要求收敛交付，当前先完成项目内测试链配置和基础调用入口，操作步骤见 [opBNB 配置说明](OPBNB-CONFIGURATION.md)。已接入 API 的公开配置/就绪检查，提供 CLI 注册、Gas 估算和交易查询。下文的完整业务接入与联合验收属于后续协作范围，部署账户及合约地址仍待补齐。

## 当前交付状态

| 事实层级 | 状态 |
| --- | --- |
| 用户确认 | 目标网络为 opBNB Testnet，chain ID 5611；服务器和部署签名入口后续确定 |
| 已实现、本地验证 | 两类注册合约、ABI/字节码、全部 v1 动作的 EIP-712 签名、链读取/提交/收据/事件与恢复辅助库；API 外壳及链模块回归通过 |
| 远程只读验证 | 两个公开 RPC 的链 ID/genesis/同高度区块一致，支持本次 finalized 标签和单块日志查询；证据见下节 |
| 待部署 | 两个新合约地址、部署回执、实际 runtime hash、部署清单；本轮没有链上写入 |
| 待平台接入 | API、鉴权、持久化 operation/Indexer、Profile/Document 存储、Pairing、Console、Agent 客户端 |
| 待联合验收 | G0/G1 签认、安全复核、G3 部署放行和 G4 远程业务 E2E；真实重组未验证 |

本模块不是已有 Memo DID/EAS 迁移的部署结果。不要使用现有 AccountDid/EAS 地址替代新 Agent Registry 地址。本轮未新增 EAS Schema 或证明写入，也不修改现有迁移 Worker/Bundler。`publicConfig().capabilities.eas=false`。

## 测试链资料与本次只读证据

| 项目 | 值 |
| --- | --- |
| 网络 / CAIP-2 | opBNB Testnet / `eip155:5611` |
| chain ID | `5611` |
| genesis hash | `0x51fa57729dfb1c27542c21b06cb72a0459c57440ceb43a465dae1307cd04fe80` |
| 公开主 RPC | `https://opbnb-testnet-rpc.bnbchain.org` |
| 本次公开备用 RPC | `https://opbnb-testnet-rpc.publicnode.com` |
| 浏览器 | `https://opbnb-testnet.bscscan.com` |
| 原生币 | tBNB，18 decimals |
| 部署交易通道 | 本实现使用普通签名交易 `direct-relayer`，type 0 + RPC gasPrice；不配置 EntryPoint/Bundler |
| 测试币/资金账户/签名服务/服务器 | 待部署负责人提供；不得借用主网密钥 |
| 最终性策略与重组深度 | 标签能力已观察到；正式 mode、fallbackConfirmations、maxReorgDepth 仍需平台/运维确定，不自动填默认值 |

只读检查时间 `2026-11-05T07:43:41.494Z`（北京时间 15:43:41）。两个节点 chain ID/genesis 相同。较低共同高度 `220221170` 的 block hash 为 `0xcfd075ab83500a4a7fd1b5a03114861a02a1387924c92fb2c2e193985d74dba6`；当次 finalized 高度均为 `220221125`，hash 均为 `0x939fb6eab83352fd19e2a6ffd065766c723e6dd5785445a1d5ec273caef859b1`。两端单块 `eth_getLogs` 查询成功。

这只是当时的网络观测，不代表长期 RPC SLA、历史归档保留期、组织级故障独立性、链重置政策、L1 最终性或合约已部署。公开节点可限流，正式服务需运维提供独立端点和配额。网络背景参见 [BNB 官方节点说明](https://docs.bnbchain.org/bnb-opbnb/advanced/local-node/)；准确性以启动时链上复核为准。

2026-11-06T03:18:55.646Z 再次只读预检通过链 ID/genesis、同高度哈希和日志查询。共同高度 `220503236`，hash 为 `0xec6a4546ed8d8651061ffc4eccabc0d6510e913e1f7eadd7c11a83db66f947e7`。本次两个节点 finalized 标签分别停留在 `220503185` 与 `220503197`，反映了节点进度差异。适配器遇到 finalized 块未对齐时返回 `CHAIN_STATE_UNCERTAIN`，等待后续一致后推进。不得依据本次预检声称 finalized 视图完全一致。

## 代码入口

| 路径 | 内容 |
| --- | --- |
| `packages/contracts/src/` | 不可升级的 AgentDIDRegistry、AgentManagementRegistry |
| `packages/contracts/artifacts/` | 精确 ABI、编译字节码和编译设置 |
| `packages/contracts/PROTOCOL.md` | 函数、签名角色、状态、nonce/revision、错误、安全边界 |
| `packages/chain-adapter/src/index.ts` | 平台内部导入入口；build 后为 `dist/packages/chain-adapter/src/index.js` |
| `packages/chain-adapter/src/recovery.ts` | 有界索引窗口与 operation 转移辅助函数 |
| `scripts/chain/preflight.mjs` | 双 RPC 网络检查；配置清单后同时检查部署 |
| `scripts/chain/deploy.mjs` | 默认预览，显式执行；写前日志保存，支持原交易恢复 |
| `tests/chain/` | 离线回归和纯合成协议向量 |

无需另做 Python SDK 或独立公共链 HTTP 服务。平台 API/Worker 直接调用内部库，Agent/Console 继续通过平台 API，客户端不接触服务签名凭据。

## 本地验证与只读预检

在仓库根目录，Node >=22.5：

```powershell
npm ci
npm run check
$env:MEMO_PRIMARY_RPC_URL = 'https://opbnb-testnet-rpc.bnbchain.org'
$env:MEMO_SECONDARY_RPC_URL = 'https://opbnb-testnet-rpc.publicnode.com'
npm run chain:preflight
```

`check` 编译 Solidity、TypeScript 并运行测试。Ganache 只由测试在本机临时启动、结束后关闭，不是集成目标，也不进入 API 运行路径。回归覆盖所有身份/管理动作、签名/重放/过期、永久撤销、EOA/ERC-1271、日志失败、广播响应丢失、游标续跑、确认状态不降级和模拟重组。纯合成向量的签名不对应真实部署/用户，私钥不保存。没有通过这些测试宣称远程部署或业务 E2E 成功。

可用 `node --env-file=<仓库外受控环境文件路径> scripts/chain/preflight.mjs` 注入服务配置；脚本不自动加载 `.env`。带 token 的 RPC 仅在服务环境中注入，预检报告不输出端点或原始 RPC 错误。

## 部署流程：服务器确定后执行

部署是两笔新合约创建交易，会消耗测试账户 tBNB，新增一套独立 Agent DID/管理状态，不修改原 DID/EAS 合约或数据库。正常输出为地址、交易/区块 hash、清单路径及 SHA-256；未知结果保留检查点，只恢复原交易。

先在受控环境提供以下输入，再运行默认预览；没有完整输入不会创建身份、签名或广播：

| 环境变量 | 输入要求 |
| --- | --- |
| `MEMO_PRIMARY_RPC_URL` / `MEMO_SECONDARY_RPC_URL` | 不同 HTTPS 端点；运维确认独立性 |
| `MEMO_DEPLOYMENT_ID` | 新部署唯一 ID，8–128 字符；不得复用为不同源码/地址 |
| `MEMO_DEPLOYER_ADDRESS` | 有 tBNB 的公开测试资金地址；部署期间独占此账户 nonce |
| `MEMO_DEPLOYMENT_DIR` | 仓库外绝对路径、私有持久化卷；含可广播的签名交易，不能发布该整个目录 |
| `MEMO_FINALITY_MODE` | `finalized-tag` 或 `confirmations`，由平台/运维确认 |
| `MEMO_FALLBACK_CONFIRMATIONS` / `MEMO_MAX_REORG_DEPTH` | 经批准的正整数；标签不可用时库默认不降级 |
| `MEMO_GAS_PRICE_CAP_WEI` / `MEMO_GAS_LIMIT_CAP` | 正整数预算；价格/估算越界则停止，不自动抬价 |
| `MEMO_SIGNER_MODULE_PATH` | 执行时必需的外部绝对模块路径；导出 `createSigner({provider,keyId})`，返回支持 `getAddress/signTransaction` 的 ethers Signer |
| `MEMO_RELAYER_SIGNER_KEY_ID` | 外部签名模块解释的 KMS 条目名；认证 token/私钥仍由外部模块安全注入 |

```powershell
# 仅预览：不调用 signer、不保存检查点、不发交易。
npm run chain:deploy
# 在已核对预览/预算、完成 G0/G1/G2 复核后部署两笔新合约。
npm run chain:deploy -- --execute
```

先提交并固定源码，执行模式拒绝脏工作树。第一笔 DID 的 L2 Gas 可在预览估算；管理合约构造函数依赖 DID 已存在，待第一笔确认后现场估算第二笔。预览不把第二笔或 L1 费用填成 0；测试账户保留额外 tBNB，实际费用分别记录 executionFee/l1Fee。

外部目录中的 `<id>.checkpoint.json` 在每次广播前 fsync 保存签名交易和预计算 txHash；重跑同一命令/同一源码/同一 ID 恢复原交易，不盲目再部署。进程强杀会留下 `<id>.lock`：运维先确认没有存活进程、复核链和检查点，再移除该特定锁后恢复，不能删除检查点或换 ID 重发。禁止部署与其他程序共用资金账户 nonce。

成功后生成 `<id>.manifest.json` 和 `<id>.verification.json`。文件名中的 ID 使用 URL 编码，兼容含冒号的部署 ID。清单只含公开元数据，可作为不可变发布工件，SHA-256 输出给平台独立复核。检查点绑定源码、网络、资金地址与最终性配置，恢复时逐笔检查签名交易的链 ID、nonce、创建字节码和预测地址。实际 JSON 在受控环境交付。

## 平台最小接入顺序

1. 加载受控清单并独立核对文件 SHA-256，创建两个 HTTPS JsonRpcProvider（禁用缓存，设置有限超时）。`new OpbnbChainAdapter({manifest,primary,secondary})` 后 `await verifyDeployment()`；失败继续返回 503。
2. 读配置用 `await publicConfig()`。它重新核对部署，只返回公开 network/contracts/domain/finality/capabilities。写就绪需配置 signer、`signerHealth`、journal、minimumBalance、gasPriceCap、gasLimitCap，并调用 `await readiness()`。平台不能因为进程存活就报告 ready。
3. Profile/Document 原文在平台做 `hashJson` 并保存。调用 `buildIntent(actionType,payload,intentId,ttlSeconds)`；payload 是精确链字段，**不含 nonce/expectedRevision/deadline**，这些值由库固定块读取生成。ttl 默认 300 秒，允许 1–900 秒；平台事务绑定不可变 intent 与 CREATED operation。
4. 客户端独立核对域、字段和 digest 后签名。平台收集 `{role,address,signature}`，调用 `verifySignedAction`；身份 EOA、管理钱包 EOA/ERC-1271 均检查，缺签名或多签名拒绝。
5. API 鉴权和幂等持久化后返回 operationId；Worker 调用 `submitSignedAction(intent,signatures,requestId)`。requestId 是持久化 UUID，同一动作重试不变；`submissionId` 不能代替平台 operationId。
6. Worker 用 `getSubmission` 跟踪。`INCLUDED + confirmed=false` 不能显示已确认；只有 `confirmed=true` 后推进 CONFIRMED，保存 finalitySource、block/tx hash 和费用。UNKNOWN/SUBMISSION_UNKNOWN 只对账原请求，禁止新建业务签名重发。
7. Indexer 从最早部署块前一块开始保存 cursor。`readNextWindow` 返回事件及新 cursor，平台在同一数据库事务内按 `(chainId,deploymentId,blockHash,txHash,logIndex)` 唯一键写事件/投影并更新 cursor。读取失败不提交事务，不推进游标。平台完成多租户鉴权、对象 hash 校验、Pairing、审计和页面。

链模块方法签名见源码导出的 TypeScript 类型；`readEvents` 每次最多 2000 块，默认每片 200 块，主备结果不一致或任一失败即整体失败，不能返回成功空数组。读状态包含 source block number/hash。`readCredentialRevocation` 提供实例撤销查询。

## 并发、恢复与停写

- `FileSubmissionJournal` 是单 Relayer/单私有持久卷的实现，独占文件锁跨进程串行；一个未取得两端规范收据的原交易会阻止新请求。支持原始签名已保存、尚未广播/响应丢失/重启后的原 txHash 恢复。不得用临时容器盘，不得两个服务各自用不同 journal 共用一个钱包。
- journal 含可广播签名交易，只能服务侧访问。强杀残留 `relayer.lock` 的处理与部署锁相同；任何原交易未查清前不得移除交易记录。多节点生产部署由平台实现事务性 SubmissionJournal，并维持账户 nonce 独占，不能直接扩容此文件实现。
- `advanceOperation` 防止已确认状态被旧更新降级；进入 REORGED 必须由双 RPC 对原块的 canonical hash 变化证实。它是转移辅助函数，不替代平台的收据/digest 验证和审计。恢复重提交前重新验证原 intent/nonce，不能仅改状态。
- 游标 hash 变化时停止推进，平台找共同祖先并在 maxReorgDepth 内回滚投影/回放；库不删除数据库记录或审计。超出深度、链重置或部署变化时停写、人工处理并发布新清单，旧身份不自动迁移。
- finalized 标签不可用默认停住；只有平台批准后显式设置 `allowFinalityFallback=true`，才允许 CHAIN_UNAVAILABLE 时按清单确认数降级；双 RPC 分叉不降级。
- 返回的 executionFee 与可用 l1Fee 分列；l1Fee 不可得时为 null，不能报为 0 或声称总费用完整。监控资金余额、Gas、RPC 错误/落后、pending 时长、日志游标、锁和重组报警由平台/运维接入。

## 依赖与构建验证

2026-11-06 已升级 Ajv 至 8.20.0，锁定兼容 Paris 编译目标的 OpenZeppelin 5.1.0，并将 Solidity 编译工具的 tmp 依赖固定到 0.2.5。针对生产依赖执行官方 npm registry 的 `npm audit --omit=dev`，未报告已知漏洞。完整开发依赖审计仍有告警，主要来自 Ganache 的测试依赖树，开发依赖仅用于受控本地构建和合成测试。Docker 运行阶段使用 `npm ci --omit=dev`。

本机 Docker 服务未启动，尚未完成镜像构建验证。Dockerfile 已补齐合约、适配器和规格文件的构建输入，镜像构建仍需在具备 Docker 服务的环境执行。

## 剩余交接项

用户已明确服务器/签名入口稍后确定，所以本轮不执行部署。部署前仍需确定资金账户、签名模块、运维联系人、确认/重组策略，以及 G1 的签名向量、权限边界和安全复核。平台独立接入后，按 [验收单](../deploy/testnet/DELIVERY_CHECKLIST.md) 完成真实注册/解析/更新/管理/恢复证据，记录 operationId、digest、tx/block hash、确认数和测试时间。不能把本地用例、网络预检或单纯 Git 推送写成 G3/G4 完成。
