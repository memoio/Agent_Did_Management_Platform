# 5 分钟看懂：本机启动、Agent 注册和钱包绑定

本指南针对**当前这台 Mac**和远程 opBNB Testnet（chain ID 5611）。合约已经部署，现有测试 Agent 和管理关系也已上链；平时启动项目**不用重新部署合约**。详细命令和测试数据管理见 [本机运行手册](LOCAL-RUN-AND-TEST-DATA.md)。

## 系统在哪里

| 用途 | 地址或路径 | 什么时候可用 |
| --- | --- | --- |
| 管理页面 Console | <http://127.0.0.1:4273> | API 启动后 |
| API 就绪检查 | <http://127.0.0.1:4273/api/v1/ready> | API、数据库、链配置可用后 |
| opBNB 测试链浏览器 | <https://opbnb-testnet.bscscan.com> | 随时 |
| DID Registry | `0x456Df7c0C189BF0187a8c0A70c713F8Da609c9d7` | 已部署 |
| Management Registry | `0x9e589B142543ea9E15eE25C53823354319dB3929` | 已部署 |
| 本机平台目录 | `/Users/memo/Agent_DID/agent-did-memo-mainnet` | 本机 |

Console 是**本机地址**，只有这台 Mac 的 API 启动后才能打开。Manager 在浏览器钱包里签管理意图；Agent 在独立 Skill 里签自己的意图；平台 Worker 用测试 Gas 账户把双签结果发到链上。Manager 钱包只签消息，注册和绑定交易的 Gas 由平台 Relayer 支付。

## 第一步：准备项目（首次安装或拉取更新后）

在“终端”执行：

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
npm ci
npm run build
npm run local:configure
```

**看到什么**：构建出现 `Compiled Agent DID and Management registries`；配置工具显示 `manifestImported: true`、`signerConfigured: true`、`databaseConfigured: true`。这一步只整理本机文件，**不发链上交易**。以后未更新代码时，可跳过 `npm ci` 和 `npm run build`。

## 第二步：启动三个本机进程

以下三段分别在三个终端运行。启动**单个** Worker 前，先协调测试 Gas 账户的使用窗口，暂停其他项目使用同一账户发交易；本项目没有跨项目 nonce 分配器。

**终端 A：启动 PostgreSQL**

```sh
R="$HOME/Library/Application Support/MemoAgentOpbnb"
pg_ctl -D "$R/postgres" -o "-k '$R/run' -p 55435 -c listen_addresses=''" -l "$R/postgres.log" start
```

**看到什么**：`server started`。若显示已经运行，直接继续下一步。

**终端 B：启动 API 和管理页面**

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
MEMO_CHAIN_WRITES_ENABLED=true node --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" dist/apps/api/src/main.js
```

**看到什么**：`Nest application successfully started`。保持这个终端打开；管理页面此时可访问。

**终端 C：启动单个 Worker**

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
MEMO_CHAIN_WRITES_ENABLED=true node --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" dist/apps/chain-worker/src/main.js
```

**看到什么**：正常运行时可能**没有输出**，终端保持占用。Worker 负责发送交易、等回执和记录链事件。不要重复启动第二个 Worker。

在第四个终端检查：

```sh
curl -sS http://127.0.0.1:4273/api/v1/ready
```

**看到什么**：JSON 中有 `"ok":true`、`"writesEnabled":true`、`"databaseReady":true`。如果只有 `/health` 成功，仍不代表可以写链。

## 第三步：先看看已经成功的示例

本机已有 Agent DID：

```text
did:memo:agent:5611:0x5e504c67713b03c9743d93bb72ef93f0094d2b89
```

API 启动后执行：

```sh
DID='did:memo:agent:5611:0x5e504c67713b03c9743d93bb72ef93f0094d2b89'
curl -sS "http://127.0.0.1:4273/api/v1/agent-dids/$DID"
curl -sS "http://127.0.0.1:4273/api/v1/management/$DID"
```

**看到什么**：第一条结果的 `status` 为 `ACTIVE`；第二条的 `manager` 为 `0x0FC646329a20f7508dB9bB4E2B894d24b9829be6` 且 `live` 为 `true`。这是**查询**，不会产生新交易。不要对这个 DID 再运行注册命令。

## 第四步：创建一个新的 Agent 并注册 DID

要重跑注册流程，必须创建**新的隔离 Agent**。在第四个终端执行以下准备命令；它们只在本机创建身份和测试 JSON 文件：

```sh
cd /Users/memo/Agent_DID/agent-did-memo-mainnet
SKILL=/Users/memo/Agent_DID/.data/opbnb-skill-publish-20261109/skills/memo-agent-did-opbnb-testnet
AGENT_HOME="/Users/memo/Agent_DID/.data/opbnb-agent-$(date +%Y%m%d-%H%M%S)"
umask 077
mkdir -p "$AGENT_HOME"
export MEMO_AGENT_OPBNB_HOME="$AGENT_HOME"
export MEMO_AGENT_OPBNB_API_URL=http://127.0.0.1:4273
export MEMO_AGENT_OPBNB_DID_REGISTRY=0x456Df7c0C189BF0187a8c0A70c713F8Da609c9d7
export MEMO_AGENT_OPBNB_MANAGEMENT_REGISTRY=0x9e589B142543ea9E15eE25C53823354319dB3929
node "$SKILL/bin/memo-agent-opbnb-testnet" identity ensure > "$AGENT_HOME/identity-result.json"
node scripts/make-test-agent-data.mjs "$AGENT_HOME/identity-result.json"
```

**看到什么**：最后一条命令打印新 DID、`profile.json` 和 `document.json` 路径。身份私钥只在独立 macOS 钥匙串命名空间中；这些 JSON 文件只含公开测试数据。此时 DID **还没有注册上链**。

继续注册：

```sh
node "$SKILL/bin/memo-agent-opbnb-testnet" register "$AGENT_HOME/profile.json" "$AGENT_HOME/document.json"
```

**看到什么**：CLI 返回 `ok:true`、新 DID、`operationId`、`txHash`；最终 `state:CONFIRMED`、`finalitySource:finalized-tag` 才表示注册成功。命令可能等待几分钟。若状态暂时是 `PENDING`，用 `node "$SKILL/bin/memo-agent-opbnb-testnet" operation <operationId>` 查询，**不要再次注册同一个 DID**。

## 第五步：用钱包建立 Agent 管理关系

“绑定钱包”在本系统中指**建立链上管理关系**，需要 Manager 钱包和 Agent 对**同一个意图**分别签名，不是把钱包私钥交给 Skill。

1. 在有钱包扩展的浏览器中打开 <http://127.0.0.1:4273>。点“连接并登录”，在钱包中允许站点连接并签署登录消息。**看到**钱包地址和 `eip155:5611`。
2. 在页面第 02 栏填入**刚注册的新 DID**，权限填 `agent.read`，期限填 `30` 天，“公开可发现”保持不勾选。点“创建并签名”，在钱包中核对并签署管理意图。**看到** `intentId` 和 digest。
3. 在 Agent 的第四个终端，把页面显示的真实 ID 代入下列命令（不要照抄尖括号）：

```sh
INTENT_ID='把页面显示的 intentId 填在这里'
node "$SKILL/bin/memo-agent-opbnb-testnet" management inspect "$INTENT_ID"
node "$SKILL/bin/memo-agent-opbnb-testnet" management approve "$INTENT_ID"
```

**看到什么**：`inspect` 显示 Manager 地址、`agent.read`、期限和 digest；`approve` 返回 `receivedRoles` 同时包含 `manager`、`agent`。请先核对内容，再执行 approve。意图约 **300 秒**后到期，准备好双方再点“创建并签名”。

4. 回到 Console 第 03 栏，确认还是**同一个 intentId**，点“Agent 签名后提交”。**看到** operation 从 `SIGNED` → `SUBMITTED` → `CONFIRMED`；不要反复创建新意图。
5. 查询新 DID 的管理关系：

```sh
DID='把新 DID 填在这里'
curl -sS "http://127.0.0.1:4273/api/v1/management/$DID"
```

**看到什么**：`manager` 等于刚才的钱包地址、`live:true`、scope hash 和期限与意图一致，才算钱包管理关系绑定完成。

## 测试与停止

只跑离线测试：在平台仓库执行 `npm test`；PostgreSQL 集成用例会跳过。要跑**全部**测试，按[详细手册第 5 节](LOCAL-RUN-AND-TEST-DATA.md#5-离线测试与数据边界)设置独立的 `agent_did_opbnb_test` 数据库；2026-11-09 本机实测 **25 项全部通过**。不要把 `TEST_DATABASE_URL` 指向业务库。

停止时先在 Worker、API 两个终端分别按 `Ctrl-C`，再执行：

```sh
pg_ctl -D "$HOME/Library/Application Support/MemoAgentOpbnb/postgres" stop
```

**看到什么**：`server stopped`。链上已注册的 DID 与管理关系不会因本机进程停止而消失。停止 Worker 后，其他项目才可恢复使用同一 Gas 账户；下次发交易前重新协调使用窗口。
