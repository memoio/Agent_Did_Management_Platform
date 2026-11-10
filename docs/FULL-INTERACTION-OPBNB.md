# opBNB 测试链完整交互手册

本手册对应 `feat/opbnb-testnet-chain` 的多 Agent Console、PostgreSQL API/Worker，以及独立 `memo-agent-did-opbnb-testnet` Skill。网络固定为 opBNB Testnet `eip155:5611`。现有两份合约继续使用，不重新部署。`runtime.env`、Agent 身份密钥、Invitation/Offer 文件和签名均不得提交到 Git。

## 启动与地址

项目目录：`/Users/memo/Agent_DID/agent-did-memo-mainnet`。运行前在项目目录执行 `npm ci && npm run build`。本机 PostgreSQL、API 和**一个** Worker 分别启动；完整命令见 [快速启动](QUICK-START-LOCAL-OPBNB.md)。API 与 Console 默认地址是 <http://127.0.0.1:4273>，就绪接口为 `/api/v1/ready`。区块浏览器是 <https://opbnb-testnet.bscscan.com>。

`GET /api/v1/health` 只说明进程在运行。`GET /api/v1/ready` 中 `writesEnabled=true`、`databaseReady=true`、`verified=true` 才能进行写入。已有测试 DID 和关系的只读查询保留在 `/api/v1/agent-dids/{did}` 与 `/api/v1/management/{did}`。

## 钱包登录

在装有钱包扩展的浏览器中打开 Console，点击“检测并连接钱包”。页面通过 EIP-6963 和兼容入口查找 MetaMask、OKX Wallet、Rabby：只找到一个时直接请求连接；找到多个时列出钱包供用户选择。选中后，钱包会要求授权账户、必要时切换到 opBNB Testnet 5611，并签署登录消息。切换账户或网络后需要重新登录。

## 钱包与 Agent 的两种配对

### A. 平台 Invitation

1. 钱包在 Console 登录，进入“登记 / 创建”，填写 scope、最长期限和邀请有效期，下载 `.memo-invitation.json`。
2. Agent 在本机测试链 Skill 中运行：

   ```sh
   node "$SKILL/bin/memo-agent-opbnb-testnet" identity ensure
   node "$SKILL/bin/memo-agent-opbnb-testnet" pair invitation accept invitation.json profile.json document.json
   ```

   Skill 检查平台来源、chain ID、两份合约地址、有效期和平台的权威记录；尚未注册的 Agent 先注册并等待 `CONFIRMED`，之后完成链下配对。
3. 钱包刷新“我的 Agent”，打开对应 Agent 的管理草稿，点击“钱包签署草稿”。Agent 再运行：

   ```sh
   node "$SKILL/bin/memo-agent-opbnb-testnet" agent-request next
   node "$SKILL/bin/memo-agent-opbnb-testnet" agent-request inspect <草稿ID>
   node "$SKILL/bin/memo-agent-opbnb-testnet" agent-request approve <草稿ID>
   ```

   Agent 审核 Manager、scope、期限、可发现性与 digest 后才批准。API 接收双方签名，Worker 发送交易；Console 最终显示 `CONFIRMED`。

### B. Agent Offer

1. Agent 已注册且身份为 `ACTIVE`，本机创建 Offer：

   ```sh
   node "$SKILL/bin/memo-agent-opbnb-testnet" pair offer create ./agent.memo-offer.json agent.read,profile.update 30 900
   ```

   最后两个参数分别是期限上限（天）与文件有效期（秒）。文件只在首次创建时写入，权限为 `0600`。
2. 钱包在 Console“登记 / 创建”导入文件，核对 Agent DID、权限与期限，在上限内选择条款并兑换。
3. 钱包签管理草稿，Agent 按上面的 `agent-request` 命令检查并批准；Worker 上链确认。

Invitation 和 Offer 含一次性凭据，按临时密码传递。平台只保存凭据 SHA-256；过期、取消、重复使用、scope 或期限越界会被拒绝。配对只建立平台关联和管理草稿，链上管理权以双方签名的 `ActivateRelationship` 交易达到最终性为准。对于已经直接上链管理的历史 Agent，Dashboard 标记 `confirmed-chain-management`，不补造配对记录。

## 直接管理与后续操作

原有的“输入 DID → 钱包创建并签署意图 → Agent `management inspect/approve` → Console 提交”入口仍在“登记 / 创建”页。对于续期或转移，在 Agent 详情的“管理关系操作”创建意图；Agent 用 `management pending`、`management inspect <intentId>`、`management approve <intentId>` 签署。转移还需要新 Manager 钱包登录并签署同一意图。结束关系由当前 Manager 在 Console 签署，或由 Agent 在本地执行 `management end`。所有签名齐全后提交，观察 operation 至 `CONFIRMED`。

Agent 独自签署的身份动作：

```sh
node "$SKILL/bin/memo-agent-opbnb-testnet" identity update-profile profile.json
node "$SKILL/bin/memo-agent-opbnb-testnet" identity update-document document.json
node "$SKILL/bin/memo-agent-opbnb-testnet" identity suspend
node "$SKILL/bin/memo-agent-opbnb-testnet" identity resume
node "$SKILL/bin/memo-agent-opbnb-testnet" identity revoke
```

Profile 与文档原文按版本存储；API 只返回链上确认且 hash 与当前合约状态一致的版本。永久吊销不能恢复。运行实例在 Agent 本机创建，Identity Key 签名公开凭证，Instance Key 留在本机钥匙串：

```sh
node "$SKILL/bin/memo-agent-opbnb-testnet" instance create worker-01 1
node "$SKILL/bin/memo-agent-opbnb-testnet" instance list
node "$SKILL/bin/memo-agent-opbnb-testnet" identity self-test
node "$SKILL/bin/memo-agent-opbnb-testnet" instance revoke <instanceId>
```

`auth sign <challenge.json>` 使用本地 Instance Key 签一次性 Challenge，同一 issuer + nonce 再次使用会拒绝。实例撤销需等待链上 `RevokeInstanceCredential` 确认。

## Console 页面与运行数据

- “我的 Agent”支持全部、待处理、管理中、未管理筛选；详情包括概览、实例、生命周期、Profile/文档和操作记录。
- “安全告警”根据真实身份状态、待签草稿与实例到期时间计算；“审计日志”可导出 JSON/CSV，不导出密钥、文件凭据或签名原文。
- “区块链学习”显示实际网络、合约、区块与 finality 策略。当前交易层为 `direct-relayer`，不展示旧 ERC-4337 UserOperation 数据。
- 数据库采用增量表结构，保留已有 DID、operation、文档和管理关系。配对依赖的注册若被核实为重组，草稿冻结；钱包可在链状态恢复后点击“核实并重试草稿”。

## 验证状态

平台构建、Ganache 合约测试、API/PostgreSQL 配对及动作测试已通过（8 个测试文件，26 个用例）。两个新的隔离 Agent 分别完成 Offer 和 Invitation 旅程：注册、双签管理关系均在 opBNB Testnet 达到 `CONFIRMED`。第一个 Agent 的 Profile 更新、暂停、恢复和实例凭证撤销也已确认，双 RPC 解析与平台投影一致。完整的 operation、交易和区块哈希见[隔离验收证据](../deploy/testnet/FULL-INTERACTION-ACCEPTANCE-2026-11-09.md)。

本次 Manager 使用隔离测试钱包脚本签名，未自动操作浏览器扩展；Console 新配对页面做了界面检查，浏览器钱包逐屏端到端自动化仍需补做。旧 DID 与原管理关系只读核对，没有吊销或转移。
