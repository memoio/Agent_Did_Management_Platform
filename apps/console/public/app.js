const title = document.getElementById("status-title");
const detail = document.getElementById("status-detail");

try {
  const response = await fetch("/api/v1/integration/status", { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.ok || !result.data?.network) {
    throw new Error("平台状态与当前页面预期不一致");
  }
  const status = result.data;
  title.textContent = `${status.network.name} · ${status.chainConnected ? "合约连接已验证" : "待补齐或验证链配置"}`;
  detail.textContent = `链 ID ${status.network.chainId} · 交易提交${status.writesEnabled ? "已就绪" : "待就绪"}`;
} catch {
  title.textContent = "平台状态暂时不可用";
  detail.textContent = "请检查 API 服务；此页面不会尝试连接区块链。";
}
