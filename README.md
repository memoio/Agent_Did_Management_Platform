# Agent DID 管理平台：区块链接入基线

本仓库当前是**待接入版本**。旧的 MEMO chain 985 合约、Bundler/Relayer、Worker、链上 API、嵌入式 Skill 和本地 Anvil 编排已从当前分支移除。平台只保留可构建的 HTTP API 与静态页面外壳，**没有连接任何区块链，也不能注册 DID 或发起链上操作**。

交接依据：

- [opBNB 测试链配置交付](docs/OPBNB-CONFIGURATION.md)：公开网络、Gas 账户及既有 Memo EAS/Schema 参数在 `.env.example`，供平台接入使用。

- [区块链实现需求](docs/BLOCKCHAIN_REQUIREMENTS.md)：业务能力、API/适配器边界、状态机、安全要求与验收标准。
- [输入、输出与对接契约](docs/BLOCKCHAIN_INTEGRATION_CONTRACT.md)：链工程师收到什么、必须交回什么、字段级接口、合入和联调门槛。
- [测试链资料表](deploy/testnet/NETWORK_INPUTS.md)：由区块链工程师填写目标链、RPC、部署和运维信息。
- [交付与接入验收单](deploy/testnet/DELIVERY_CHECKLIST.md)：逐项记录双方输入、链方输出、平台接入与 G0–G4 放行证据。
- [机器可读规格](specs/chain-integration-v1/action-types.json)：动作字段表及部署清单、签名意图、规范化事件的 v1 JSON Schema 位于同一目录。
- 旧实现保存在 Git 历史的初始提交 `37da76aa4a725cf9b53c70c0b965fa4ffb1d1fb7`，可供理解原流程；**不得把旧代码或 chain 985 参数直接当作新实现**。

## 本地启动外壳

依赖 Node.js `>=22.5.0`：

```sh
npm ci
npm run check
npm run dev
```

默认访问 `http://127.0.0.1:4273`。`GET /api/v1/health` 表示 API 进程可用且链功能待实现；`GET /api/v1/ready` 与 `GET /api/v1/chain/config` 返回 HTTP 503 和 `BLOCKCHAIN_NOT_IMPLEMENTED`。此前注册、解析、配对等 API 路由已撤下，不会误报成功。

若在服务器上绑定 `0.0.0.0`，须置于可信反向代理后并设置 `MEMO_BEHIND_TRUSTED_PROXY=true`。这个外壳没有生产身份功能；完成需求文档中的安全、存储和远程测试链验收前，不应把它作为业务服务发布。

## 当前目录

```text
apps/api/src                 HTTP 外壳与未接入状态
apps/console/public          集成准备页面
docs/BLOCKCHAIN_REQUIREMENTS.md   新实现需求与验收
docs/BLOCKCHAIN_INTEGRATION_CONTRACT.md  跨团队输入/输出与对接契约
specs/chain-integration-v1/    动作字段表及部署清单、意图、事件的 JSON Schema
deploy/testnet/NETWORK_INPUTS.md  测试链资料模板
deploy/testnet/DELIVERY_CHECKLIST.md  跨团队交付验收模板
```

新的区块链实现应在明确网络、签名模型与接口契约之后，通过独立 PR 增加合约/链适配器、后端任务处理、客户端能力及测试。当前分支不包含任何可执行的链上写入命令。
