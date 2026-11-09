# Leader 的 Mac 本机配置

更新于 2026-11-09。使用 `feat/opbnb-testnet-chain` 平台集成分支。部署、API 和 Worker 共用当前用户的 `~/Library/Application Support/MemoAgentOpbnb/runtime.env`。

## 首次配置

需要 Node.js 22.5 或更高版本，以及 PostgreSQL 命令行工具。从仓库根目录执行以下命令，它们创建持久目录和配置文件，不发送交易。

```sh
npm ci
npm run build
npm run local:configure
export MEMO_RUNTIME_DIR="$HOME/Library/Application Support/MemoAgentOpbnb"
open -e "$MEMO_RUNTIME_DIR/runtime.env"
```

工具已填写网络、Gas 地址、部署 ID、费用阈值及当前用户绝对路径。默认每笔 gasPrice 上限 2000000 wei、Gas limit 上限 8000000、最低保留余额 100000000000000 wei。实际交易按 RPC 报价和估算发送，超限停止，另需预留 L1 费用。最终性沿用现有手册的 finalized-tag、fallback confirmations 12、最大重组深度 128，默认关闭降级与写入开关。平台负责人可以调整测试参数，重复配置保留现有非空值。

账户持有人在编辑器中填写 MEMO_RELAYER_PRIVATE_KEY，并将 MEMO_SIGNER_MODULE_PATH 留空。目录权限为 700、文件权限为 600，本机环境文件方案无需申请 KMS/钥匙串权限。工具保留本机已有 signer 配置，两种签名入口必须只选择一种。Windows 私钥文件不会自动传至 Mac。

deployments 保存部署记录，submissions 保存交易日志。部署期间停止该账户的其他交易程序，部署结束后只启动一个 Worker。全部进程使用同一 macOS 用户及同一环境文件。

## 默认本地数据库

工具默认生成 Unix socket 的 DATABASE_URL，端口 55435、库名 memo_agent_opbnb、角色为当前 macOS 用户。socket 位于私有目录的 run 子目录，服务器不监听 TCP。已有数据库可在 runtime.env 填入实际 DATABASE_URL，跳过以下初始化，工具不会覆盖该值。

确认 initdb、pg_ctl、createdb 命令可用后执行以下命令，将创建并启动本机测试实例。

```sh
export MEMO_RUNTIME_DIR="$HOME/Library/Application Support/MemoAgentOpbnb"
if [ ! -f "$MEMO_RUNTIME_DIR/postgres/PG_VERSION" ]; then
  initdb -D "$MEMO_RUNTIME_DIR/postgres" --auth-local=trust --auth-host=scram-sha-256
fi
if ! pg_ctl -D "$MEMO_RUNTIME_DIR/postgres" status >/dev/null 2>&1; then
  pg_ctl -D "$MEMO_RUNTIME_DIR/postgres" \
    -o "-k '$MEMO_RUNTIME_DIR/run' -p 55435 -c listen_addresses=''" \
    -l "$MEMO_RUNTIME_DIR/postgres.log" start
fi
```

首次创建业务库时再运行以下命令，库已存在则跳过。API/Worker 首次连接会创建业务表。

```sh
createdb -h "$MEMO_RUNTIME_DIR/run" -p 55435 memo_agent_opbnb
```

业务库与集成测试的 TEST_DATABASE_URL 使用独立数据库。

## 预览、部署及回填

以下预检和费用预览为只读步骤。

```sh
node --env-file="$MEMO_RUNTIME_DIR/runtime.env" scripts/chain/preflight.mjs
node --env-file="$MEMO_RUNTIME_DIR/runtime.env" scripts/chain/deploy.mjs
```

核对预览和预算后执行下列部署命令，将发送两笔新合约创建交易并消耗 tBNB。完成后重跑配置工具，从同一部署 ID 的 manifest 自动回填地址及文件 SHA-256。

```sh
node --env-file="$MEMO_RUNTIME_DIR/runtime.env" scripts/chain/deploy.mjs --execute
npm run local:configure
```

如已有清单，使用 `npm run local:configure -- --manifest /absolute/path/deployment.manifest.json`。现有清单配置与文件不一致时停止，防止误切换部署。工具检查网络、地址及文件哈希，随后需再次运行 preflight 完成双 RPC 和部署核验。清单尚未生成时输出 manifestImported=false，保留相关字段待回填。

## 启动

在两个终端分别进入仓库根目录运行。以下进程将连接数据库，Worker 可处理已签名操作并发送测试交易，应先完成配置和部署核验。

```sh
MEMO_CHAIN_WRITES_ENABLED=true node \
  --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" \
  dist/apps/api/src/main.js
```

```sh
MEMO_CHAIN_WRITES_ENABLED=true node \
  --env-file="$HOME/Library/Application Support/MemoAgentOpbnb/runtime.env" \
  dist/apps/chain-worker/src/main.js
```

访问 http://127.0.0.1:4273，检查 /api/v1/ready 返回写入和数据库就绪。注册和管理操作按 [联调手册](OPBNB-TESTNET-RUNBOOK.md) 验证，保存公开地址及交易回读证据。

本配置工具已在当前 Windows 工作区做自动化测试。目标 Mac 的文件权限、PostgreSQL 启动和完整链上联调需由该机操作人实际核验。
