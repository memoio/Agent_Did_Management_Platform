# Memo 与 Agent Schema 差异及 opBNB 调用配置

更新于 2026-11-09。交付目标为给 Leader 提供可用于注册、查询、Gas 估算与交易提交的链配置和字段约定。平台业务接入由 Leader 完成。

## 核对范围与状态

| 对照对象 | 结论 | 依据 |
| --- | --- | --- |
| Leader 的 Agent 签名动作与本分支动作表 | 字段定义一致 | `specs/chain-integration-v1/action-types.json`，本轮已对照 main 与功能分支 |
| 本分支合约 ABI 与动作表 | 11 个动作的业务字段名称、类型和顺序一致 | `packages/contracts/artifacts/*.abi.json` 与动作表逐项对照 |
| 现有 Memo EAS 与 Agent 身份、管理关系 | 存在字段和业务语义差异，见下表 | Memo 五类 Schema 已从 opBNB Registry 回读 |
| 真实交易能力 | 待核对实际调用合约及交易证据 | 用户反馈充值、部署完成；本轮尚未取得对应 Agent 部署地址/交易哈希 |

这里的 Agent 动作表定义待签名消息，EAS Schema 定义证明 payload。复用 EAS UID 时必须遵循对应的编码定义。签名动作中的 nonce、deadline 等字段有各自的合约验证职责。

## 现有 Memo EAS Schema

网络为 opBNB Testnet，chain ID `5611`。EAS 为 `0xAFE40017A7C46fA57D00aD5910890D425050916a`，Schema Registry 为 `0x4B4911001746Ca88F282d97332eDc6a33F65b82e`。以下五项的 resolver 均为零地址，已通过 `getSchema(uid)` 回读匹配。

| 名称 | 精确 payload，字段顺序固定 | 可撤销 |
| --- | --- | --- |
| Registration | `bytes32 methodId` | false |
| AccountKey | `string id,string methodType,string controller,uint256 chainId,address account` | true |
| PublicKey | `string id,string methodType,string controller,bytes publicKey` | true |
| KeyPurpose | `string verificationMethodId,uint8 relationshipType` | true |
| Service | `string id,string serviceType,string serviceEndpoint` | true |

| 名称 | opBNB Schema UID |
| --- | --- |
| Registration | `0xe9c1f221fb7daea4447cdcc12ca69a9a1d7cb547e9ce428438e27522ee033179` |
| AccountKey | `0xa3ca4e31c05581e7d21d305fb09fe517a0b26c162c08f7e08849b392e4ffffd7` |
| PublicKey | `0x488650cdd8f4137a09fd96a1e06121c4ee737a401d98e028f2c61c0bd07118ee` |
| KeyPurpose | `0x8e5acb8716c8433ee551ebcea378e5cab1203368353c17b783819d7983f743d6` |
| Service | `0xef402073ca44dcc56dd1b5d7beb8f9da32a4ded363367d1a4734099c7a0c6a20` |

opBNB AccountKey 的字段为 `controller`，以上 UID 对应该精确文本。历史 Sepolia 的 `controller1` 对应另一个 UID。字段、类型、顺序、resolver 或可撤销标志改变后，需核对相应 UID。

EAS 还有 recipient、attester、time、expirationTime、revocationTime、refUID 等外层字段。这些字段由 EAS 接口和证明记录提供，调用方需与自定义 payload 分开编码、读取。

## 字段与调用差异表

| Leader 需要的信息/操作 | Memo EAS 可用字段 | 对齐要求与缺口 |
| --- | --- | --- |
| Agent 地址 identityAccount | 外层 recipient；AccountKey.account | 可以表达地址，但需明确身份主体与 Key 的关系，不能仅凭 recipient 认定 Agent 已授权 |
| identityPublicKeyHash | PublicKey.publicKey 保存原始字节 | 可以按明确算法从完整公钥派生哈希，原始字节与 bytes32 哈希需要分别编码 |
| documentHash、profileHash | 五类 payload 均无直接对应字段 | 需要扩展证明 Schema 或保留在 Agent 合约，具体方案待 Leader 确认 |
| Agent 状态 ACTIVE/SUSPENDED/REVOKED | EAS 外层存在撤销时间 | EAS 撤销表示单条证明失效，暂停/恢复/永久撤销的状态规则需由身份逻辑承接 |
| revision / 版本号 | 五类 payload 均无 revision | 需要身份合约或新的证明版本规则，EAS time 是时间值 |
| nonce、deadline | 五类 payload 均无对应字段 | Agent 动作签名和目标合约负责防重放、期限验证 |
| DID 标识 | Registration.methodId | 现有 Memo 标识与 `did:memo:agent:5611:<address>` 规则不同，需要明确映射，不能直接把地址补零当 methodId |
| Manager 地址、relationshipIdHash | controller 为字符串，KeyPurpose 表达 Key 用途 | 管理关系需独立语义，不能把 Key controller/用途直接解释为 Manager 授权 |
| 管理关系 scopesHash | KeyPurpose.relationshipType 为 uint8 | 不能按相同字段编码，需另行定义管理权限范围 |
| issuedAt / expiresAt | EAS 外层 time / expirationTime | 时间可供参考，双方签名的管理期限和 EAS 签发期限需分别约定 |
| discoverable、结束、转移 | 五类 payload 均无对应字段 | 属于管理关系模型，需补充定义或使用管理合约 |
| 签发与授权 | EAS attester 为证明签发者 | 原生 EAS 接口不自动验证 Leader 项目的 Agent/Manager EIP-712 动作，需由调用层/合约落实 |

可复用的 Schema 应按上表的精确 UID 和字段编码。扩展字段需先确认定义和签发/撤销责任，本表未注册新的 Schema。

## Leader 实际调用需要的配置

| 项目 | 配置内容 | 使用位置 |
| --- | --- | --- |
| 网络 | chain ID 5611；主 RPC `https://opbnb-testnet-rpc.bnbchain.org`；备 RPC `https://opbnb-testnet-rpc.publicnode.com` | provider、钱包网络与签名域 |
| Gas 账户 | `0xd511f5C8A3e0A12f6119aCA7463d6f619CEf14B0` | 测试交易付款，余额及 nonce 在执行前回读 |
| Memo EAS 证明注册/查询 | 上述 EAS、Registry、Schema UID、精确 payload、对应 EAS ABI | Registry.getSchema、EAS.attest/getAttestation；attest 返回的 UID 来自事件/回执 |
| Agent 注册/查询 | 实际 Agent DID/Management 合约地址、匹配 ABI、EIP-712 域、部署起始块 | 本分支 buildIntent、estimateSignedAction、submitSignedAction、readIdentity、readRelationship |
| 本分支配置文件 | MEMO_CHAIN_MANIFEST_PATH 和 SHA256、Gas signer、交易记录目录和费用上限 | configuredChain 和 scripts/chain/call.mjs |

EAS Schema UID 用于选择证明结构；Agent Registry 地址用于执行身份动作。Leader 若要求基础 DID 也完全使用 Memo 模型，需要先明确原 Memo DID 调用 ABI 与标识映射，再由平台调整字段。当前动作表要求的专用 Agent 合约路线仍保留在功能分支。

## “能调用注册”的最小交付验收

1. 目标地址在 5611 链上有代码，实际 ABI、签名域和配置相匹配，Gas 账户余额足够。
2. 明确注册对象是 Agent 身份还是 EAS 证明，输入按对应定义编码。
3. 调用 Gas 估算成功，显式发送一笔测试交易，取得成功回执及匹配事件。
4. 按实际 DID/地址或证明 UID 回读，关键字段与输入一致，保存交易 hash、block hash 和费用。
5. 交付脱敏配置、ABI、Schema UID 和调用样例，Leader 接入业务项目。

本轮对照完成了字段、UID 和调用路径整理，完整远程验收结果需补充实际交易证据。基础调用命令与环境文件加载方式见 [opBNB 配置操作说明](OPBNB-CONFIGURATION.md)。
