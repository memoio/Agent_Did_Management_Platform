# Agent DID 链模块协议与权限

状态：2026-11-05，v1 实现，待平台/Agent 团队评审与远程部署。任务发起人已确定 opBNB Testnet（5611）；本轮交易层实现为 `direct-relayer`，不依赖 ERC-4337/Bundler。Agent/Manager 签业务动作，Relayer 只付 Gas。

## 来源与部署边界

字段、类型、顺序和签署人来自 [action-types.json](../../specs/chain-integration-v1/action-types.json)。实现为 [AgentDIDRegistry.sol](src/AgentDIDRegistry.sol)、[AgentManagementRegistry.sol](src/AgentManagementRegistry.sol)。部署时使用这两份合约的实际地址。

编译锁定 Solidity 0.8.28、OpenZeppelin 5.1.0、optimizer 200、viaIR、EVM `paris`。`npm run chain:compile` 生成 `artifacts/`。ABI 文件使用 UTF-8、两空格缩进、末尾 LF，SHA-256 针对原始字节，仓库属性固定这些文件的 LF 换行。运行时代码 hash 取链上实际 bytecode 的 keccak256。EIP-712 缓存、immutable 地址会影响实际运行时代码。

两个合约不可升级，无管理员、代注册后门或改写权限。部署者不能替 Agent 签名。故障时平台停写；新版本使用新地址、部署 ID、清单及另行评审的迁移流程。身份暂停由 Agent 签名，没有全局暂停管理员。

## DID、签名与哈希

- DID：`did:memo:agent:5611:<lowercase-address>`；Agent 为 secp256k1 EOA，合约 Agent 不属于 v1。
- 公钥 hash：未压缩公钥去掉 `04` 后的 64 字节坐标取 keccak256，末 20 字节等于 Agent 地址。合约校验 hash/地址绑定及 Agent 签名。
- Profile/Document：RFC 8785 JCS 后 UTF-8 字节 SHA-256；原文由平台存储。`hashJson` 拒绝非有限数、未配对代理字符和非 JSON 对象。
- scopes：1–64 项合法 ASCII scope，去重排序后 JCS+SHA-256。其他标识符/原因码按契约取 keccak256；`hashIdentifier` 验证 1–128 字符 ASCII ID。
- EIP-712 域分别为 `MEMO Agent DID Registry`、`MEMO Agent DID Management`，version `1`；chainId/verifyingContract 取已验证清单。nonce、revision、期限等使用十进制字符串。
- 完整字段签入 digest；未知/缺失字段拒绝，错误 domain/signature、过期、重放 nonce 或错误 revision 拒绝，失败不改变状态。

## 身份动作

| 函数 / 动作 | 签署人 | 条件与结果 |
| --- | --- | --- |
| registerAgent / RegisterAgent | Agent | NONE→ACTIVE；revision/nonce 从 0/0 到 1/1；公开 hash 非零 |
| updateProfile / UpdateProfile | Agent | ACTIVE/SUSPENDED；更新 profileHash |
| updateDocument / UpdateDocument | Agent | ACTIVE/SUSPENDED；更新 documentHash |
| suspendAgent / SuspendAgent | Agent | ACTIVE→SUSPENDED |
| resumeAgent / ResumeAgent | Agent | SUSPENDED→ACTIVE |
| revokeAgent / RevokeAgent | Agent | ACTIVE/SUSPENDED→REVOKED；不可恢复或重新注册覆盖 |
| revokeInstanceCredential / RevokeInstanceCredential | Agent | ACTIVE/SUSPENDED；按 Agent+credentialIdHash 撤销，重复拒绝 |

每次成功使身份 revision、nonce 各加 1。永久撤销的独立审批由平台落实；链合约验证 Agent 完整签名。继任者属于 v1.1，未在本轮加入。

## 管理动作

| 函数 / 动作 | 同一 digest 的签署人 | 条件与结果 |
| --- | --- | --- |
| activateRelationship / ActivateRelationship | Agent + Manager | Agent ACTIVE，无未结束且未过期当前关系，建立新 ID，未来到期时间 |
| renewRelationship / RenewRelationship | Agent + 当前 Manager | Agent ACTIVE、关系未结束；有效期晚于链头，可改 scope/可发现性 |
| endRelationship / EndRelationship | actor：Agent 或当前 Manager | 当前关系未结束；可在身份暂停/撤销或关系过期后清理，无需双方同意 |
| transferRelationship / TransferRelationship | Agent + 原 Manager + 新 Manager | Agent ACTIVE、关系未结束且未过期；不同新 Manager、新关系 ID，原子替换 |

Manager 支持 EOA/ERC-1271。管理 nonce/revision 独立于身份合约，初值 0，每次成功各加 1，转移只增加一次。关系结束或到期后，建立下一条关系使用当前全局 revision/nonce，历史通过事件区分。双方签名按角色分别提供，地址相同时仍需满足完整角色集合。

原因码仅允许 `AGENT_ENDED`、`MANAGER_ENDED`、`SECURITY_REVOCATION`，前两者与 actor 角色一致。scope hash 不授予 Gateway/Vault 等链下权限。`live` 由 ACTIVE 身份、未结束关系和链头早于 expiresAt 共同决定；到期不自动增加 nonce/revision。Pairing、登录、Invitation/Offer 属于平台链下流程。

## 读取、事件与错误

`identities(address)`、`relationships(address)`、`revokedCredentials(address,bytes32)` 是读取入口，字段顺序见 ABI。事件包含执行后 revision、本次消耗 nonce、actionDigest 和动作专属字段。适配器映射到既有 normalized-event Schema；AgentRegistered 的 identityAccount 从索引 agent 补入。

合约错误 `InvalidAction`、`InvalidSignature`、`NonceConflict`、`ActionExpired` 映射为同义大写错误，其余回退为 `CONTRACT_REVERT`。RPC 原始错误不透传。`SUBMISSION_UNKNOWN` 可能已广播，只对账原 requestId/txHash，不能换请求重发。

## 风险与验证

本地回归覆盖全部动作、重放、错误域、过期、永久撤销、EOA/ERC-1271、日志失败、提交响应丢失、确认状态不降级和模拟重组。仍需独立安全审查；本地模拟不证明远程部署或真实重组恢复。

Relayer 被盗不能伪造 Agent/Manager 签名，但能提交持有且未过期的签名；签名交易检查点按秘密材料保护。平台独立控制会话、intent 访问、幂等键、永久撤销审批和原文 hash 对账。

离线合成 EOA 测试向量见 [protocol-vectors.json](../../tests/chain/protocol-vectors.json)，不含真实用户/部署签名。ERC-1271 正反向量由 [registry.test.ts](../../tests/chain/registry.test.ts) 的离线钱包生成执行，远程验证待部署后补齐。
