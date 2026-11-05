# 远程测试链网络资料交接表（待链工程师填写）

> 只填写**可公开或团队内部可共享的非秘密信息**。不要在本文件中放私钥、助记词、签名桥 token、带鉴权参数的 RPC URL。受限地址用“密钥管理器条目名 + 联系人”交接。状态可写：待提供 / 已提供 / 已验证 / 不支持。

| 文档元数据 | 填写值 |
| --- | --- |
| 测试链候选/正式名称 | 待提供 |
| 链工程负责人、联系方式 | 待提供 |
| RPC/Bundler 运维负责人 | 待提供 |
| 资料版本、更新时间、验证人 | 待提供 |
| 平台与链团队共同确认日期 | 待提供 |

## A. 编码前必须确认

| 编号 | 必填资料 | 填写值 / 证据链接 | 状态 |
| --- | --- | --- | --- |
| A1 | 链名称、测试网/主网属性、chain ID（十进制和十六进制） | 待提供 | 待提供 |
| A2 | genesis block hash（32 字节），链重置/快照政策、预计保留期 | 待提供 | 待提供 |
| A3 | 区块浏览器 URL、公开只读 HTTPS RPC、公开 `wss://` | 待提供 | 待提供 |
| A4 | 私有主 RPC、独立备 RPC 的密钥管理器条目名、网络白名单、配额、限流与故障切换说明 | 待提供 | 待提供 |
| A5 | 主备 RPC 的 `eth_chainId`、genesis、同一高度 block hash 实测结果与时间 | 待提供 | 待提供 |
| A6 | `eth_getCode`、`eth_getLogs`、`eth_getTransactionReceipt`、fee data、`debug_traceCall`、`finalized` 标签能力 | 待提供 | 待提供 |
| A7 | 日志/交易历史保留期、建议批量 `eth_getLogs` 区块跨度、正常重组深度 | 待提供 | 待提供 |
| A8 | 出块时间、推荐确认数、finality 依据（`finalized` 或确认数） | 待提供 | 待提供 |
| A9 | 原生币名称、符号、精度、测试币水龙头/充值方式、资金预算 | 待提供 | 待提供 |
| A10 | 规范 ERC-4337 v0.7 EntryPoint 地址、runtime code hash、部署 tx/block；SenderCreator 状态 | 待提供 | 待提供 |
| A11 | HTTPS Bundler 是否已提供、`eth_supportedEntryPoints` 结果、运营负责人；若没有，谁部署 Alto | 待提供 | 待提供 |
| A12 | 该链是否允许 Solidity 合约部署、Factory/Registry 部署权限与 Gas 限制 | 待提供 | 待提供 |
| A13 | EVM 硬分叉/字节码兼容性、Gas 计价方式；是否支持本项目 Solidity 0.8.37 + Paris EVM 构建结果 | 待提供 | 待提供 |

EntryPoint 预期地址：`0x0000000071727De22E5E9d8BAf0edAc6f37da032`。项目当前期望的 v0.7 runtime code hash：`0x8db5ff695839d655407cc8490bb7a5d82337a86a6b39c3f0258aa6c3b582fc58`。链方请提供**实际代码及 hash**供比对；若不同，不要直接修改期望值绕过校验。

## B. 部署前补齐

| 编号 | 资料 | 填写值 / 证据链接 | 状态 |
| --- | --- | --- | --- |
| B1 | Deployer 地址、充值方法、余额、持有人及密钥管理器条目名 | 待提供 | 待提供 |
| B2 | Relayer owner 地址、KMS/HSM provider、签名桥 endpoint 的内部服务名/密钥条目名 | 待提供 | 待提供 |
| B3 | 签名桥 EIP-191 签名测试向量、恢复出的 owner 地址、鉴权与轮换负责人 | 待提供 | 待提供 |
| B4 | Alto 版本/源码提交/镜像 digest、safe mode、executor/utility 地址与资金 | 待提供 | 待提供 |
| B5 | EntryPoint deposit 最低值、Relayer Smart Account 余额下限、补款及告警方式 | 待提供 | 待提供 |
| B6 | API/Console 可信 HTTPS origin、证书、CORS/钱包允许域名、内部网络路径 | 待提供 | 待提供 |
| B7 | 部署窗口、回滚/作废流程、链重置通知渠道 | 待提供 | 待提供 |

## C. 部署后交付的机器可验证资料

| 合约/服务 | 地址或 endpoint（仅非秘密） | 部署 tx hash | block number/hash | runtime code hash / ABI hash | 在线双 RPC 验证 |
| --- | --- | --- | --- | --- | --- |
| EntryPoint v0.7 | 待提供 | 待提供 | 待提供 | 待提供 | 待验证 |
| AgentDIDRegistryV1 | 待部署 | 待部署 | 待部署 | 待部署 | 待验证 |
| AgentManagementRegistryV1 | 待部署 | 待部署 | 待部署 | 待部署 | 待验证 |
| SimpleAccountFactory | 待部署 | 待部署 | 待部署 | 待部署 | 待验证 |
| Relayer Smart Account | 待部署 | 待部署 | 待部署 | 待部署 | 待验证 |
| Alto Bundler v0.7 | 待提供 | 不适用 | 不适用 | 版本/镜像 digest 待提供 | 待验证 |

| 发布工件 | 填写值 |
| --- | --- |
| 测试链部署清单存储位置（只读发布工件） | 待提供 |
| 部署清单 SHA-256 | 待提供 |
| 在线预检和部署校验报告位置 | 待提供 |
| 链团队验收人 / 平台验收人 / 验收日期 | 待提供 |

## D. 共同决策，不能由单方默认

1. 测试链 chain ID 是否唯一且不等于 985？DID 是否采用 `did:memo:agent:<chainId>:<address>`？
2. 平台阶段是否继续叫 `preprod`？测试链身份状态目录、密钥服务命名空间和 API origin 如何与主网/本地旧身份隔离？
3. 对测试链使用哪个 finality 策略；遇到 RPC 分叉、日志回退、链重置时如何暂停写入与恢复索引？
4. 规范 EntryPoint v0.7 若不存在或 code hash 不匹配，由谁负责部署/选链？
5. 谁批准首次部署及测试交易，谁持有 deployer/Relayer/Alto 资金和凭据？

完整改造与文件所有权见[测试链交接方案](../../docs/TEST_CHAIN_BLOCKCHAIN_HANDOFF.md)。
