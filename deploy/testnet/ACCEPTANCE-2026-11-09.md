# opBNB Testnet 实链验收记录（2026-11-09）

本记录只包含公开链上证据和脱敏运行状态；不包含私钥、会话 token、签名原文或 Journal 原文。

## 部署与环境

- 源码提交：`cde9b5aecb143e5e1e8a27cfaee7e9f3ea7ac516`
- 网络：opBNB Testnet，`eip155:5611`；双 RPC 的 chain ID、genesis、共同区块已通过只读预检。
- 部署 ID：`opbnb-agentdid-20261109-a`
- Manifest SHA-256：`0xded975bef5c95c3181ddc41b43c7c9c9e6793e2183c60c54e1d5c15ab7ff9ee2`
- 最终性策略：`finalized-tag`，默认不降级；部署脚本核实双 RPC 收据、runtime code hash、EIP-712 域和 Registry 关联。

| 合约 | 地址 | 部署交易 | 区块号 | 区块 hash |
| --- | --- | --- | ---: | --- |
| AgentDIDRegistry | `0x456Df7c0C189BF0187a8c0A70c713F8Da609c9d7` | `0x31683d9f3a16cef289a9c8c87d853a98ad384c25cecd8af8279314a508c8bb8d` | 221546848 | `0xeeabdf6c7987f56b75225a1d48649333e7013d22ffa074fd25826843d7cb0151` |
| AgentManagementRegistry | `0x9e589B142543ea9E15eE25C53823354319dB3929` | `0xe9dcc4ccf9eaee0ac26618ddfcbd80aa2aed5b602875bba68d21435923de1574` | 221546928 | `0x1f0edf3d3b007fe881c5895f57cf9a228c1a2344f420041f7b32e59ef857cfbf` |

## Agent DID 注册

- 隔离测试 DID：`did:memo:agent:5611:0x5e504c67713b03c9743d93bb72ef93f0094d2b89`
- Action digest：`0x2002efd1a5e17345b66625546ab68dea18394bd5eef9bdc1f12524cf0b03a7ae`
- Operation ID：`f52693f0-0d58-4f3d-b1a7-4a3d2472fe23`
- 交易 hash：`0xeb8082fbc8ecbd685e4e2477e632d4686651967fed258877e4b162da6befbadd`
- 区块：221547998，`0x265cd67013d2d2bb82ac80b67bda6275d4cf72a3e9d748596bb8b20fe32d9057`
- Operation：`CONFIRMED`，`finalitySource=finalized-tag`。API 解析：`status=ACTIVE`、`revision=1`；profile/document hash 与链上值一致。Indexer 已保存同交易的 `AgentRegistered` 事件。

## 管理关系与重启验收

待 Manager 浏览器钱包和 Agent 对同一管理意图分别签名后补充；当前**未通过完整业务 E2E 验收**。API/Worker 重启后的 operation 与关系查询也待执行。
