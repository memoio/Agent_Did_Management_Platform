# opBNB Testnet 公开配置

更新于 2026-11-09。完整配置、部署与验收步骤见 [测试链运行手册](OPBNB-TESTNET-RUNBOOK.md)。

- 网络：opBNB Testnet，chain ID 5611，Gas 币 tBNB。
- 双 RPC：`https://opbnb-testnet-rpc.bnbchain.org`、`https://opbnb-testnet-rpc.publicnode.com`。
- 浏览器：`https://opbnb-testnet.bscscan.com`。
- 默认测试 Gas 账户：`0xd511f5C8A3e0A12f6119aCA7463d6f619CEf14B0`。
- 固定 genesis hash、既有 Memo EAS/Schema 地址和 Schema UID 见根目录 `.env.example`。

公开参数已通过远程双 RPC 只读预检。EAS/Schema 是既有服务，与本系统 Agent 专用 DID Registry 和 Management Registry 分开。本仓库当前没有两份 Agent 专用 Registry 的真实部署清单或链上写入证据；`.env.example` 中对应地址、manifest 和 signer 仍为空占位。只有实际部署后产生的 manifest 与 SHA-256 才能用于启动写入服务。
