# opBNB 测试链配置交付

更新于 2026-11-09。按 Leader 的配置交付范围整理，公开参数保存在根目录 `.env.example`，业务调用由平台接入。

## 已提供的信息

- opBNB Testnet，chain ID 5611，Gas 币 tBNB，18 位精度。
- 主 RPC `https://opbnb-testnet-rpc.bnbchain.org`，备 RPC `https://opbnb-testnet-rpc.publicnode.com`。
- 浏览器 `https://opbnb-testnet.bscscan.com`。
- 测试 Gas 账户 `0xd511f5C8A3e0A12f6119aCA7463d6f619CEf14B0`。
- 已有 Memo EAS 和 Schema Registry 地址，以及五类已注册 Schema UID。opBNB AccountKey 使用 `controller` 字段，字段顺序与类型可通过 Registry 的 `getSchema(uid)` 查询。

上述 Memo EAS 地址和 Schema 定义已做过链上只读回读。交易前重新确认链 ID、目标地址代码、账户余额和 nonce。签名交易使用 RPC 返回的 gasPrice，先估算 Gas，再发送并查询成功回执及事件。opBNB 费用还包含 L1 附加部分，应保留足够测试币。

## 配置使用和待补项

本分支提供环境参数模板，API 仍为原仓库外壳。平台需将对应环境变量接到实际 provider、签名者和合约调用位置，加载 `.env.example` 本身不会启用交易。

用户反馈已完成充值和部署，但目前取得的记录只有既有 Memo EAS 地址。Agent 专用 DID Registry、Management Registry 的实际地址及匹配 ABI 仍需从对应部署回执确认，模板中保留空值。EAS 地址按 EAS ABI 调用，Agent 注册动作按实际身份合约 ABI 调用。Schema UID 选择须与 payload 字段、类型和顺序一致。

Leader 最小调用验证为一次注册或证明写入取得成功交易回执，再按身份地址或证明 UID 回读输入字段，并记录交易 hash、区块 hash 和 Gas 费用。当前尚未取得这项远程注册验收证据。

本次将早期新增的合约、链适配器、API/页面改动、部署工具、助记词工具和配套测试从功能分支当前树中撤回。原实现保留在 Git 历史和本地备份分支 `backup/agent-chain-before-scope-reduction-20261109`。
