# Agent DID 管理平台：区块链接入基线

本仓库包含 opBNB Testnet（5611）的 Agent DID/管理关系合约、TypeScript 链适配器和受控部署入口。HTTP API 与静态页面仍是待接入外壳，尚不能通过平台注册 DID。新合约尚未远程部署，平台接入与远程业务验收待完成。

链模块交接见 [opBNB 测试链接入说明](docs/OPBNB-TESTNET-INTEGRATION.md)，协议与权限见 [链模块协议](packages/contracts/PROTOCOL.md)。旧 chain 985 实现仅保留在历史中，不恢复旧参数，不使用本地链作为远程验收证据。

交接依据：

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
packages/contracts/          Agent DID/管理关系合约、ABI、编译脚本
packages/chain-adapter/src/   内部链读写、验签、收据与恢复辅助库
scripts/chain/               远程只读预检、默认预览/显式部署入口
docs/BLOCKCHAIN_REQUIREMENTS.md   新实现需求与验收
docs/BLOCKCHAIN_INTEGRATION_CONTRACT.md  跨团队输入/输出与对接契约
specs/chain-integration-v1/    动作字段表及部署清单、意图、事件的 JSON Schema
deploy/testnet/NETWORK_INPUTS.md  测试链资料模板
deploy/testnet/DELIVERY_CHECKLIST.md  跨团队交付验收模板
```

`npm run chain:preflight` 只读核验远程网络；`npm run chain:deploy` 默认预览，只有加 `-- --execute` 并提供完整设置和外部 signer 后才发送部署交易。实际清单与签名交易检查点保存在仓库外，不提交 Git。平台 API/Worker、鉴权、Pairing、存储、Console 和 Agent 客户端由平台团队继续对接。
