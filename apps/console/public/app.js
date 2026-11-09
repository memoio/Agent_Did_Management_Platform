const title = document.getElementById("status-title");
const detail = document.getElementById("status-detail");

try {
  const response = await fetch("/api/v1/integration/status", { cache: "no-store" });
  const result = await response.json();
  if (!response.ok || !result.ok || result.data?.state !== "AWAITING_BLOCKCHAIN_IMPLEMENTATION") {
    throw new Error("平台状态与当前页面预期不一致");
  }
  title.textContent = "等待区块链实现与测试链验收";
  detail.textContent = "链连接：未配置 · 链上写入：已禁用";
} catch {
  title.textContent = "平台状态暂时不可用";
  detail.textContent = "请检查 API 服务；此页面不会尝试连接区块链。";
}
