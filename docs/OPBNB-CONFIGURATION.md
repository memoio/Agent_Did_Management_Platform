# opBNB 配置与基础调用

更新于 2026-11-08。本轮交付聚焦平台的测试链配置和基础调用。配置入口为 `packages/chain-adapter/src/config.ts`，API 和命令行共用。Leader 后续对接平台业务。

## 已填入的网络信息

| 参数 | 值 |
| --- | --- |
| 网络 | opBNB Testnet，5611 |
| 主 RPC | https://opbnb-testnet-rpc.bnbchain.org |
| 备 RPC | https://opbnb-testnet-rpc.publicnode.com |
| 浏览器 | https://opbnb-testnet.bscscan.com |
| Gas 币 | tBNB，18 位小数 |
| 测试 Gas / 默认部署账户 | 0xd511f5C8A3e0A12f6119aCA7463d6f619CEf14B0，用户于 2026-11-08 指定的独立钱包 |
| genesis | 0x51fa57729dfb1c27542c21b06cb72a0459c57440ceb43a465dae1307cd04fe80 |

## 还需填写的实际环境信息

| 环境变量 | 来源与用途 |
| --- | --- |
| MEMO_CHAIN_MANIFEST_PATH | 目标 Agent 合约的真实部署清单绝对路径，含地址、签名域和链上部署证据 |
| MEMO_CHAIN_MANIFEST_SHA256 | 部署清单的 SHA-256，使用 `0x` 前缀，与清单文件独立核对 |
| MEMO_RELAYER_ADDRESS | 已填写用户指定的测试 Gas 账户，需有 tBNB |
| MEMO_RELAYER_PRIVATE_KEY | 服务端安全注入的测试 Gas 账户密钥，也可改用 MEMO_SIGNER_MODULE_PATH 外部 signer |
| MEMO_SUBMISSION_DIRECTORY | 仓库外绝对路径，持久保存交易记录供恢复和查询使用 |
| MEMO_MINIMUM_BALANCE_WEI | 交易后至少保留的资金阈值，正整数 wei |
| MEMO_GAS_PRICE_CAP_WEI / MEMO_GAS_LIMIT_CAP | 每笔价格与 Gas 上限，按实际估算和预算确定 |
| MEMO_CHAIN_WRITES_ENABLED | 默认 false。填写上述信息并完成核验后显式设 true |

当前 Agent 合约尚未部署。测试 Gas 账户公开地址已填写，私钥由用户后续在运行环境中配置，注册链路的远程验证待实际部署后进行。现有 Memo DID 或 EAS 合约使用不同 ABI，应按其实际业务选用，Agent 清单需要与本项目 ABI 一致。

用户已为 Agent 平台更换独立钱包，现有 EAS 任务继续使用原账户。MEMO_DEPLOYER_ADDRESS 默认使用新的 Gas 地址，如另用部署账户，须同时配置与之匹配的签名方式。

用户目前持有助记词。请在自己受信任的钱包中选择上述地址对应的账户，使用钱包提供的账户私钥导出功能，再将该账户私钥配置到本机受控环境文件的 MEMO_RELAYER_PRIVATE_KEY。助记词可派生多个地址，必须核对选中的公开地址与上表一致。当前环境变量接收单账户私钥，助记词保留在钱包中。助记词和导出的私钥均不得发送到聊天、上传网页或提交仓库。若钱包不支持导出，可后续使用外部 signer 接入。

若使用本仓库部署脚本，`npm run chain:deploy` 默认预览。实际部署还需部署 ID、仓库外记录目录和最终性策略，详见 [部署说明](OPBNB-TESTNET-INTEGRATION.md)。部署可使用上述测试 Gas 私钥或外部 signer，部署地址由 MEMO_DEPLOYER_ADDRESS 校验。

## 加载配置并检查

复制 `.env.example` 为本机受控环境文件，例如 `.env.local`，填写真实值。该文件受 Git 忽略，禁止分享密钥。项目所有命令从仓库根目录执行。

```powershell
npm ci
npm run build
node --env-file=.env.local scripts/chain/preflight.mjs
node --env-file=.env.local dist/apps/api/src/main.js
```

API 的 `/api/v1/integration/status` 显示真实配置状态。部署清单与网络通过核验后 `/api/v1/chain/config` 返回公开信息。写配置和资金检查通过后 `/api/v1/ready` 返回成功。公开响应只含网络、地址与状态，私钥、私有 RPC、签名原文保留在服务端。

## 注册、Gas 和查询入口

`scripts/chain/call.mjs` 读取同一环境文件。参数中的 JSON 文件由调用方保存在受控目录，命令输出已脱敏。命令如下。

```powershell
# 部署配置、写入就绪检查
node --env-file=.env.local scripts/chain/call.mjs config
node --env-file=.env.local scripts/chain/call.mjs ready
# 身份查询，文件内容为 {"address":"实际 Agent 公开地址"}
node --env-file=.env.local scripts/chain/call.mjs identity identity-input.json
# 创建注册意图，调用方保存返回的 data 对象
node --env-file=.env.local scripts/chain/call.mjs intent registration-input.json
# 完整动作由 Agent 签名后，文件提供 {intent,signatures,requestId}
node --env-file=.env.local scripts/chain/call.mjs estimate signed-action.json
# 显式发送真实测试链交易，消耗测试 Gas 账户 tBNB
node --env-file=.env.local scripts/chain/call.mjs submit signed-action.json --execute
# 使用提交返回的 submissionId 查询，文件内容为 {"submissionId":"返回值"}
node --env-file=.env.local scripts/chain/call.mjs submission submission-input.json
```

注册输入为 `{actionType:"RegisterAgent",payload:{identityAccount,identityPublicKeyHash,documentHash,profileHash}}`。文件必须是合法 JSON，四个字段填真实公开地址及哈希。公钥哈希使用 Agent 公钥坐标的 keccak256，文档和 Profile 使用 `hashJson`。revision、nonce、deadline 由链读取得到。`intentId` 和 `ttlSeconds` 可选。

签名项为 `{role:"agent",address,signature}`。Agent 使用返回的 domain/types/message 签 EIP-712 数据，业务密钥由 Agent 持有人管理。Gas 账户负责签发交易，提交者与 Agent 可以是不同地址。requestId 使用 UUID 并保存，同一业务提交重试沿用原值。

`estimate` 校验动作、计算 Gas，返回 gasEstimate、gasLimit、gasPriceWei、maximumExecutionFeeWei 和 broadcast=false。L1 附加费尚未确定时 l1FeeWei 为 null，账户需额外预留测试币。`submit` 沿用这些预算约束，广播前保存原交易，未知结果按原 requestId 对账。签名文件与交易记录不得上传 Git。

调用方也可直接导入 `configuredChain`，取得 adapter 后调用同名方法，并在结束时 close。后续平台路由、会话和业务流程由 Leader 接入这些入口。

## 验证口径

本地测试覆盖配置缺失停写、RPC 地址校验、错误密钥脱敏、API 配置状态，以及估算 Gas 后链状态和账户 nonce 不变，再发送同一签名完成注册。远程网络可用性通过 `chain:preflight` 实测。实际注册、Gas 支付和回执仍需真实部署及测试账户后验收。
