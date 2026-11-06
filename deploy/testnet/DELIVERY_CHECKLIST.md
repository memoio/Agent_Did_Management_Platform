# 远程测试链交付与平台接入验收单

> 使用方式：链工程师逐项填入**工件路径、提交 SHA 或脱敏证据链接**；平台工程师独立复核并填写结果。不得以“已口头提供”代替证据。字段与行为以[集成契约 v1](../../docs/BLOCKCHAIN_INTEGRATION_CONTRACT.md)为准；本单不包含密钥、token、带鉴权参数的 RPC URL 或私有签名。状态取 `待交付 / 待复核 / 通过 / 退回 / 不适用`，不适用需说明原因。

| 项目信息 | 填写值 |
| --- | --- |
| 目标网络 / CAIP-2 / chain ID | opBNB Testnet / eip155:5611 / 5611；用户已确认 |
| genesis hash / 是否可能重置 | 待填写 |
| `deploymentId` / 清单 SHA-256 | 待填写 |
| 链工程负责人 / 平台负责人 / 运维负责人 | 待填写 |
| 协议版本 / 评审日期 | `v1` / 待填写 |

## 1. 平台交给链工程师的输入

| ID | 输入 | 交付位置或值 | 链方确认 |
| --- | --- | --- | --- |
| P-01 | [业务需求](../../docs/BLOCKCHAIN_REQUIREMENTS.md)、[集成契约](../../docs/BLOCKCHAIN_INTEGRATION_CONTRACT.md)、[网络资料表](NETWORK_INPUTS.md) | 仓库当前提交 SHA：待填写 | 待确认 |
| P-02 | API 外壳、`memo.agent-api-result/1`、健康/就绪接口 | `apps/api/src/**`；API 提交 SHA：待填写 | 待确认 |
| P-03 | Agent/钱包/Relayer 的密钥和签名责任、审批策略 | 评审记录：待填写 | 待确认 |
| P-04 | Profile/Document、Pairing、审计的链下边界 | 平台数据字典/存储接口：待填写 | 待确认 |
| P-05 | Node 22、内部适配器接口、远程测试链约束 | 适配器接口评审记录：待填写 | 待确认 |
| P-06 | 测试 Agent/钱包**公开地址**、scope 词汇表、一次性脱敏样本 | 受控测试资料位置：待填写 | 待确认 |

## 2. 链工程师必须交回的产物

| ID | 产物与文件归属 | 最低可复核证据 | 状态 / 证据位置 |
| --- | --- | --- | --- |
| C-01 | `NETWORK_INPUTS.md` 网络决策 | 主备 RPC 独立性、chain ID/genesis/同高度 hash、RPC 能力、重置政策 | 待复核；网络预检见接入说明；正式独立性/SLA/重置政策待补 |
| C-02 | `tests/chain/protocol-vectors.json` 协议向量 | 每个动作 domain/types/message/digest、hash、多签、ERC-1271、错误链/nonce/过期反例；平台与客户端独立重算结果 | 待复核；EOA 静态向量及 ERC-1271 本地回归已交，客户端独立验算/评审待完成 |
| C-03 | `packages/contracts/**` 合约、ABI、测试、审计 | 锁定编译器、函数/事件/错误、权限与状态表、部署字节码、运行时/ABI hash、管理员/升级策略 | 待复核；源码/ABI/编译产物/PROTOCOL.md/离线回归已交，安全审查及实际 runtime hash 待完成 |
| C-04 | `packages/chain-adapter/**` 适配器和测试 | 契约第 3 节全部方法、错误分类、主备 RPC、收据和事件完整性测试；不改 API/Console | 待复核；源码/离线测试已交，平台 API/Worker 尚未接入 |
| C-05 | 受控发布工件中的清单 JSON | 符合[Schema](../../specs/chain-integration-v1/deployment-manifest.schema.json)、独立 SHA-256、部署交易与区块证据、双 RPC 代码 hash 复核 | 待交付 |
| C-06 | 交易通道和运维说明 | direct-relayer 或 ERC-4337 选择、签名服务/KMS 条目名、资金阈值、费用/超时/监控、无私钥入库 | 待交付；direct-relayer 和恢复/预算入口已实现，服务器/签名服务/资金账户由用户后续确定 |
| C-07 | 索引与恢复手册及自动化测试 | 日志读取失败重试、游标不推进、重组回放、提交未知对账、链重置作废 | 待复核；接入说明/recovery.ts/离线故障测试已交；平台持久化回滚和真实重组未验证 |
| C-08 | 远程测试链脱敏验收报告 | DID、digest、operationId、tx/userOp/block hash、确认与解析、UTC 时间，明确区分模拟用例 | 待交付 |

## 3. 平台团队接入步骤与输出

| 顺序 | 平台动作 | 应产生的输出/判定 | 状态 / 证据位置 |
| --- | --- | --- | --- |
| I-01 | 验证清单 schema、SHA-256、双 RPC、domain、ABI/代码 hash | 验证报告；不符时 `/ready` 与 `/chain/config` 仍为 503 | 待接入 |
| I-02 | 将 `apps/api` 的注册/动作/解析路由接到适配器 | 意图持久化、独立 digest 复算、鉴权、幂等和错误映射测试 | 待接入 |
| I-03 | 增加持久化 operation Worker | `SIGNED→SUBMITTED→INCLUDED→CONFIRMED` 与未知提交对账；有证据才 `REORGED` | 待接入 |
| I-04 | 增加事件索引及链下对象存储 | 从部署块重放，失败重试不推进游标；原文 hash 校验；多租户隔离 | 待接入 |
| I-05 | Agent Skill/Console 使用公开 `/chain/config` 和平台 API | Agent 不交私钥，钱包/Agent 核对同一意图，多方签名齐全才提交 | 待接入 |
| I-06 | 完成远程测试链 E2E 与故障演练 | 注册、解析、更新、暂停/恢复、管理关系、结束/转移、撤销实例与失败恢复证据 | 待接入 |

## 4. 放行记录

| Gate | 放行条件 | 链方签名/日期 | 平台签名/日期 | 运维签名/日期 |
| --- | --- | --- | --- | --- |
| G0 网络决策 | C-01，网络参数无占位值 | 待签 | 待签 | 待签 |
| G1 协议冻结 | C-02 正反向量、C-03 设计评审 | 待签 | 待签 | 不适用 |
| G2 模块合入 | 合约与适配器测试、安全评审 | 待签 | 待签 | 不适用 |
| G3 部署发布 | C-05/C-06、双 RPC 和资金检查 | 待签 | 待签 | 待签 |
| G4 业务联调 | C-07/C-08、I-01 到 I-06 全部通过 | 待签 | 待签 | 待签 |

任何 Gate 退回时记录问题、责任人、修复 PR 和复验日期。目标链未选定前，本表属于模板，不能用于声称已经完成链上注册。
