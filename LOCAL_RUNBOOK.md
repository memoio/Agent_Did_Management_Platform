# Agent DID 项目本地运行手册

克隆仓库后，在项目根目录执行命令：

```sh
git clone git@github.com:memoio/Agent_Did_Management_Platform.git
cd Agent_Did_Management_Platform
```

> **环境边界**：下文的 `local` 使用 Anvil 模拟链。它的 chain ID 也是 `985`，但不是 MEMO 真实主网。这里注册的 DID 和合约记录只存在于本地链中。不要把本地测试密钥、助记词或部署清单用于真实链。

## 1. 环境准备

- Node.js `>=22.5.0`、npm。
- Docker Engine 与 Docker Compose v2。推荐用 Docker 启动完整链路；首次构建需要拉取镜像和 Alto 源码。
- 如需运行 Console 的 Playwright 测试，本机还需安装 Chrome。

检查版本并安装项目依赖：

```sh
node --version
npm --version
docker --version
docker compose version
npm ci
```

`npm ci` 用于宿主机上的构建、Skill 命令和测试。Docker 构建也会在镜像内安装依赖。

## 2. 推荐：Docker 一键启动完整本地栈

先检查 Compose 配置，再以前台模式启动：

```sh
docker compose config --quiet
npm run dev:all
```

`dev:all` 实际执行 `docker compose up --build`。保持此终端运行；需要另一个终端执行后续检查。也可以直接后台启动：

```sh
docker compose up --build -d
docker compose ps
docker compose logs -f api chain-worker
```

启动顺序是 Anvil → 部署本地合约和 Relayer Smart Account → Alto Bundler → API/Console → Chain Worker。服务地址：

| 服务 | 本机地址 | 作用 |
| --- | --- | --- |
| API 与 Console | `http://127.0.0.1:4273` | HTTP 接口和浏览器管理界面 |
| Anvil RPC | `http://127.0.0.1:9545` | 本地模拟链，chain ID `985` |
| Alto RPC | `http://127.0.0.1:4337` | ERC-4337 v0.7 Bundler |

检查 API、链配置与链 ID：

```sh
curl -fsS http://127.0.0.1:4273/api/v1/health
curl -fsS http://127.0.0.1:4273/api/v1/chain/config
curl -fsS http://127.0.0.1:9545 \
  -H 'content-type: application/json' \
  --data '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'
```

`eth_chainId` 应返回 `0x3d9`（十进制 `985`）。`/api/v1/health` 应返回 `ok: true` 的 API envelope，且其中 `data.status` 为 `ok`。

查看容器状态或停止服务：

```sh
docker compose ps
docker compose logs --tail=100 api chain-worker alto deploy
docker compose stop
```

`docker compose stop` 保留现有容器，可用 `docker compose start` 再启动，并再次检查健康状态。**Anvil 没有配置持久化卷**：`docker compose down` 会移除 Anvil 容器及其链状态，但仍保留部署清单和 API 数据命名卷，造成新链与旧数据不一致。因此不要用 `down` 当作日常暂停命令。如果明确要丢弃整套 Docker 本地测试状态，执行 `docker compose down --volumes`；之后重新启动、创建测试身份并注册。

## 3. 构建并使用本地 Agent Skill

Docker 中的 API/Worker 已自行构建；在宿主机运行 Skill CLI 前还需构建宿主机代码：

```sh
npm run build
```

在运行 Skill 命令的终端设置独立的本地测试 installation。保持 `MEMO_AGENT_MAINNET_INSTALLATION_ID` 不变，以便以后复用同一个 DID：

```sh
export MEMO_AGENT_MAINNET_ENVIRONMENT=local
export MEMO_AGENT_MAINNET_API_URL=http://127.0.0.1:4273
export MEMO_AGENT_MAINNET_HOME="$PWD/.data/mainnet-skill"
export MEMO_AGENT_MAINNET_INSTALLATION_ID=local-demo-01
export MEMO_AGENT_MAINNET_KEY_PROVIDER=auto

packages/skill/bin/memo-agent-mainnet doctor --json
packages/skill/bin/memo-agent-mainnet identity ensure --json
packages/skill/bin/memo-agent-mainnet identity status --json
```

`identity ensure` 只在本地生成或复用身份密钥，**不会注册上链**。如果 `doctor` 报 `SECURE_STORAGE_UNAVAILABLE`，请先配置可用的 OS Keyring；本地受信任测试也可按 README 使用至少 32 字符的 `MEMO_AGENT_MAINNET_MASTER_KEY`。不要将该密钥写入仓库、命令参数或日志。

先预览注册输入（不会提交链上操作）：

```sh
packages/skill/bin/memo-agent-mainnet identity register \
  --profile tests/fixtures/e2e-profile.json --dry-run --json
```

确认本地完整栈运行正常后，显式允许本地普通链写操作，并注册示例 Agent：

```sh
export MEMO_AGENT_MAINNET_ALLOW_R2=1
packages/skill/bin/memo-agent-mainnet identity register \
  --profile tests/fixtures/e2e-profile.json --json
```

注册命令会签署 Registry 操作，经 API、Worker 和 Alto 提交 UserOperation，并等待确认。保留输出中的 DID 与 `operationId`。将下方的 DID 或操作 ID 替换为实际返回值，再查询：

```sh
packages/skill/bin/memo-agent-mainnet identity resolve \
  'did:memo:agent:985:0x实际地址' --verify --json

packages/skill/bin/memo-agent-mainnet operation reconcile op_实际ID --json
```

`CONFIRMED` 表示达到了本地配置的确认数。完整 Profile/Document 保存在本地对象存储，链上保存相应哈希；这一步只注册身份，不会自动建立 Manager 关系。

## 4. 可选：运行测试

不依赖正在运行的 Docker 栈的常用检查：

```sh
npm run build
npm test
npm run isolation:verify
npm run entrypoint:verify
```

完整本地栈启动后，运行真实 Anvil + Alto 链路验收：

```sh
npm run test:e2e:local
```

其他针对性测试：

```sh
npm run test:chain
npm run test:reorg
npm run test:console:e2e
npm run contracts:test
```

`test:console:e2e` 需要本机 Chrome。`contracts:test` 与 `npm run check` 需要 npm Foundry 包的本机 `forge` 可执行文件；若报 `@foundry-rs/dist/forge ENOENT`，这是当前宿主机缺少可执行文件，不能把它当作合约测试通过。Docker 镜像中的合约产物由 `npm run contracts:artifacts` 使用固定版本 `solc` 编译。

## 5. 可选：不使用 Docker 时分步启动

此路径要求本机能运行 Anvil，并有兼容 EntryPoint v0.7 的 Alto 实例。项目没有提供一个可在宿主机直接启动 Alto 的 npm 脚本；准备好该实例后再继续。各长驻命令需要不同终端。

```sh
# 终端 A：本地链
npm run chain:start
```

```sh
# 终端 B：编译并部署到本地链
npm run contracts:artifacts
npm run contracts:deploy:local
npm run deploy:validate -- deploy/local/985.json
```

先启动 Alto，再为 API 和 Worker 配置本地环境变量。可参照 `.env.example`，但脚本不会自动读取该文件；至少要为两个进程提供 `MEMO_ENVIRONMENT=local`、RPC/Bundler URL、部署清单、数据目录、长度不少于 32 字符的 `MEMO_SESSION_SIGNING_KEY` 和本地测试 `MEMO_LOCAL_MNEMONIC`。然后分别运行：

```sh
# 终端 C：API 与 Console
npm run dev:api
```

```sh
# 终端 D：Chain Worker
npm run dev:worker
```

本机 Foundry 可执行文件缺失时，`chain:start` 无法工作；此时优先使用第 2 节的 Docker 路径。`npm run dev:reset` 只会把宿主机 `.data` 移到带时间戳的备份目录，**不会重置 Docker 命名卷**。

## 6. 常见问题

| 现象 | 先检查 |
| --- | --- |
| `127.0.0.1:4273` 无响应 | `docker compose ps`、`docker compose logs --tail=100 api deploy alto` |
| API 报链健康检查失败 | Anvil、Alto 是否健康；`/api/v1/chain/config` 中地址是否来自本次本地部署 |
| Skill 报 `SECURE_STORAGE_UNAVAILABLE` | OS Keyring 是否可用；测试用 master key 是否按 README 通过安全渠道提供 |
| Skill 报链或 Registry 不匹配 | 是否复用了另一套环境的 installation；核对 API URL、环境和既有本地状态，勿通过新建密钥掩盖问题 |
| 操作一直未确认 | 用 `operation reconcile` 查看状态，并检查 Worker、Bundler、Anvil 日志 |
| Foundry 命令报 `ENOENT` | 宿主机的 npm Foundry 可执行文件不可用；使用 Docker 完整栈，或修复本机依赖后再运行该命令 |

更多协议背景与环境边界见项目 [README](README.md)，Agent CLI 命令见 [mainnet-operations.md](packages/skill/references/mainnet-operations.md)。
