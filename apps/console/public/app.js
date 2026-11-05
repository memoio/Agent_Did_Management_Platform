const $ = (selector, root = document) => root.querySelector(selector);
const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

const ui = {
  dashboard: null,
  detail: null,
  selectedDid: null,
  view: "agents",
  tab: "overview",
  filter: "all",
  busy: false,
  walletSession: JSON.parse(sessionStorage.getItem("memo-mainnet-wallet-session") || "null"),
  walletProvider: null,
  walletProviderName: null,
  discoveredProviders: [],
  providerExplicitlySelected: false,
  preferredProviderName: sessionStorage.getItem("memo-mainnet-wallet-provider"),
  providerListeners: new WeakSet(),
  offerPackage: null,
  readAlerts: new Set(JSON.parse(sessionStorage.getItem("memo-agent-read-alerts") || "[]")),
};

async function api(path, options = {}) {
  const authorization = ui.walletSession?.token ? { authorization: "Bearer " + ui.walletSession.token } : {};
  const response = await fetch(path, { credentials: "same-origin", ...options, headers: { "content-type": "application/json", ...authorization, ...(options.headers || {}) } });
  const result = await response.json();
  if (!result.ok) {
    const error = new Error(result.error?.message || "请求失败");
    error.code = result.error?.code || "REQUEST_FAILED";
    throw error;
  }
  return result.data;
}

const esc = (value) => String(value ?? "").replace(/[&<>'"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", '"': "&quot;" })[char]);
const short = (value, head = 12, tail = 8) => !value || value.length <= head + tail + 1 ? (value || "—") : value.slice(0, head) + "…" + value.slice(-tail);
const when = (value) => {
  const date = typeof value === "number" ? new Date(value * 1000) : new Date(value);
  return Number.isNaN(date.valueOf()) ? "—" : new Intl.DateTimeFormat("zh-CN", { year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hour12: false }).format(date);
};
const badge = (label, kind = "") => '<span class="status-chip ' + kind + '">' + esc(label) + "</span>";

function toast(message, kind = "") {
  const node = document.createElement("div");
  node.className = "toast " + kind;
  node.textContent = message;
  $("#toast-region").append(node);
  setTimeout(() => node.remove(), 3200);
}

function setBusy(value) {
  ui.busy = value;
  $$("button").forEach((button) => {
    if (value) {
      button.dataset.busyDisabled = String(button.disabled);
      button.disabled = true;
    } else if (Object.hasOwn(button.dataset, "busyDisabled")) {
      button.disabled = button.dataset.busyDisabled === "true";
      delete button.dataset.busyDisabled;
    }
  });
}

async function action(work, message) {
  if (ui.busy) return false;
  setBusy(true);
  try {
    await work();
    if (message) toast(message);
    await refresh(true);
    return true;
  } catch (error) {
    toast((error.code || "ERROR") + "：" + error.message, "error");
    return false;
  } finally {
    setBusy(false);
  }
}

function showApp(view = "agents") {
  if (!ui.walletSession) return showLogin();
  $("#login-screen").classList.add("hidden");
  $("#app-screen").classList.remove("hidden");
  switchView(view);
}

function showLogin() {
  ui.dashboard = null;
  ui.detail = null;
  ui.selectedDid = null;
  $("#app-screen").classList.add("hidden");
  $("#login-screen").classList.remove("hidden");
}

function switchView(view) {
  ui.view = view;
  $$(".view").forEach((node) => node.classList.toggle("active-view", node.id === "view-" + view));
  $$("[data-view]").forEach((node) => node.classList.toggle("active", node.dataset.view === view));
  if (view !== "agents") {
    $("#agent-detail-screen").classList.add("hidden");
    $("#agent-list-screen").classList.remove("hidden");
  }
  renderAll();
}

function alertsFor(data) {
  const alerts = [];
  if (!data?.identity?.exists) alerts.push({ id: "no-identity", severity: "info", title: "尚未连接 Agent DID", body: "可生成 Platform Invitation，或导入本地 Agent 生成的 Offer。", tab: "create" });
  for (const instance of data?.instances || []) {
    if (instance.state === "ACTIVE" && instance.expiresAt * 1000 - Date.now() < 3 * 86400_000) {
      alerts.push({ id: "instance-" + instance.instanceId, severity: "warn", title: "实例凭证即将到期", body: instance.name + " 的凭证将在 " + when(instance.expiresAt) + " 到期。", tab: "instances" });
    }
  }
  if (data?.identity?.exists && !data.management) alerts.push({ id: "unmanaged-" + data.identity.agentDid, severity: "info", title: "Agent 当前未管理", body: "Pairing 已完成，但仍需钱包与 Agent 分别签署管理 action。", tab: "overview" });
  const missing = ["identity.suspend", "identity.resume", "identity.revoke"].filter((cap) => !(data?.contract?.capabilities || []).includes(cap));
  if (data?.identity?.exists && missing.length) alerts.push({ id: "capability-gap-" + data.identity.agentDid, severity: "info", title: "生命周期能力尚未开放", body: "当前 Agent Skill 未声明 " + missing.join("、") + "；控制台不会伪造操作结果。", tab: "lifecycle" });
  return alerts;
}

function renderTopbar(data) {
  const account = data.walletSession?.account || ui.walletSession?.account;
  $("#wallet-account code").textContent = account ? short(account, 14, 8) : "未连接";
  $("#wallet-account i").textContent = account ? account.slice(-2).toUpperCase() : "—";
  const label = data.walletDisplayDataDid;
  $("#top-datadid").classList.toggle("hidden", !label);
  $("#top-datadid").textContent = label || "";
}

function renderAgents(data) {
  const agents = data.agents || [];
  const pendingCount = data.counts?.pending || 0;
  $("#pending-count").classList.toggle("hidden", !pendingCount);
  $("#pending-count").textContent = String(pendingCount);
  $("#list-banners").innerHTML = pendingCount ? '<div class="info-banner"><b>待处理</b><span>' + esc(pendingCount) + ' 个 Agent 的管理草稿仍需钱包或 Agent 签名。</span></div>' : "";
  const visibleAgents = agents.filter((agent) => {
    const managed = agent.management?.state === "ACTIVE";
    const pending = agent.managementDraft && !["CONFIRMED", "REJECTED", "EXPIRED"].includes(agent.managementDraft.state);
    return ui.filter === "all" || (ui.filter === "pending" && pending) || (ui.filter === "managed" && managed) || (ui.filter === "unmanaged" && !managed);
  });
  if (!visibleAgents.length) {
    $("#agents-table").innerHTML = '<tr class="empty-row"><td colspan="7">' + (agents.length ? "当前筛选没有结果" : "还没有关联的 Agent。请前往“登记 / 创建”使用 Invitation 或 Offer。") + "</td></tr>";
    return;
  }
  $("#agents-table").innerHTML = visibleAgents.map((agent) => {
    const identity = agent.identity || {};
    const state = identity.state || "REGISTRATION_PENDING";
    const managed = agent.management?.state === "ACTIVE";
    const pending = agent.managementDraft && !["CONFIRMED", "REJECTED", "EXPIRED"].includes(agent.managementDraft.state);
    return "<tr><td><div class=\"agent-name\">" + esc(agent.profile?.name || "未命名 Agent") + '</div><div class="agent-description">' + esc(agent.profile?.description || "暂无说明") + "</div></td>" +
      "<td><code>" + esc(short(identity.agentDid, 25, 8)) + '</code><br><button class="button small-copy" data-copy="' + esc(identity.agentDid) + '">复制</button></td>' +
      "<td>" + badge("● " + state, state === "ACTIVE" ? "success" : state === "SUSPENDED" ? "warning" : "danger") + "<br><code>revision " + esc(identity.identityRevision ?? "—") + "</code></td>" +
      "<td>" + (managed ? badge("● 管理中", "success") : pending ? badge("● 待签名", "warning") : badge("● 未管理", "info")) + "</td>" +
      "<td><b>" + (agent.instances || []).filter((item) => item.state === "ACTIVE").length + "</b> 个有效</td>" +
      "<td>" + when(agent.binding?.createdAt) + '</td><td><button class="button primary" data-open-agent="' + esc(identity.agentDid) + '">查看' + (managed ? " / 管理" : "") + "</button></td></tr>";
  }).join("");
}

function overviewHtml(data) {
  const m = data.management;
  const p = data.pairing;
  const draft = data.managementDraft;
  const draftAction = draft?.state === "AWAITING_WALLET_SIGNATURE"
    ? '<button class="button primary" data-sign-draft="' + esc(draft.draftId) + '">钱包签署管理草稿</button>'
    : draft ? '<p class="muted">管理草稿：' + badge(draft.state, draft.state === "CONFIRMED" ? "success" : "warning") + '</p>' : '<p class="muted">Pairing 完成后会自动创建管理草稿。</p>';
  const management = m
    ? '<div class="did-box">' + esc(m.managerAccount) + '</div><dl class="definition-list"><dt>状态</dt><dd>' + badge(m.state, "success") + "</dd><dt>关系 revision</dt><dd>" + m.relationshipRevision + "</dd><dt>管理范围</dt><dd>" + (m.managementScopes || []).map(esc).join(" · ") + "</dd><dt>Agent proof</dt><dd>" + badge("已验证", "success") + "</dd></dl>"
    : '<p class="muted">Agent 在无人管理时仍可解析、签发实例并完成认证。</p>' + draftAction;
  const pairing = p
    ? '<p class="muted small">' + esc(p.kind) + ' · ' + esc(p.state) + ' · 到期 ' + when(p.expiresAt) + '</p>'
    : '<p class="muted small">当前绑定来自已迁移记录，或尚无可见 exchange。</p>';
  return '<div class="stack"><div class="grid-2">' +
    '<article class="card"><div class="section-label">身份状态</div><h2>Agent DID</h2><div class="did-box">' + esc(data.identity.agentDid) + '</div><dl class="definition-list"><dt>Registry 状态</dt><dd>' + badge(data.identity.state || "ACTIVE", data.identity.state === "SUSPENDED" ? "warning" : data.identity.state === "REVOKED" ? "danger" : "success") + "</dd><dt>Identity Revision</dt><dd>" + data.identity.identityRevision + "</dd><dt>Profile Hash</dt><dd><code>" + esc(data.identity.profileHash || "—") + "</code></dd><dt>网络</dt><dd><code>" + esc(data.identity.network) + "</code></dd></dl></article>" +
    '<article class="card"><div class="section-label">管理关系</div><h2>' + (m ? "Primary Manager Wallet" : "当前未管理") + "</h2>" + management + "</article></div>" +
    '<div class="grid-3"><article class="card"><div class="section-label">Pairing v2</div><h3>' + (p ? esc(p.state) : "已关联") + '</h3><p class="muted small">Invitation / Offer 只建立链下平台关联，不直接激活管理关系。</p>' + pairing + "</article>" +
    '<article class="card"><div class="section-label">控制证明</div><h3>Instance Challenge</h3><p class="muted small">使用活跃 Instance Key 签署一次性 Challenge，nonce 原子消费。</p><button id="self-test" class="button" ' + (data.instances.some((item) => item.state === "ACTIVE") ? "" : 'disabled title="需要至少一个活跃实例"') + ">运行控制证明</button></article>" +
    '<article class="card"><div class="section-label">Gateway</div><h3>资源授权保持独立</h3><p class="muted small">管理关系不会授予 Vault、Memory、Data 或 MCP 权限。</p><button class="button" disabled>前往 Gateway</button></article></div></div>';
}

function instancesHtml(data) {
  const rows = data.instances.map((item) =>
    "<tr><td><b>" + esc(item.name) + "</b><br><code>" + esc(short(item.instanceId)) + "</code></td><td>" +
    (item.state === "ACTIVE" ? badge("有效", "success") : badge("已撤销", "danger")) + "</td><td>" + when(item.expiresAt) +
    "</td><td><code>" + esc(short(item.publicKey, 16, 8)) + "</code></td><td><code>" + esc(short(item.credential?.digest, 15, 8)) +
    '</code></td><td>' + (item.state === "ACTIVE" ? '<button class="button danger" data-revoke="' + esc(item.instanceId) + '">撤销</button>' : "—") + "</td></tr>"
  ).join("");
  return '<div class="stack"><div class="page-heading"><div><h2>运行实例与凭证</h2><span>Instance Key 独立于 Identity Key；凭证包含 scope、TTL 与 Identity revision。</span></div><button id="create-instance" class="button primary">＋ 签发实例</button></div>' +
    '<article class="card table-card"><div class="table-scroll"><table><thead><tr><th>实例</th><th>状态</th><th>到期时间</th><th>实例公钥</th><th>凭证摘要</th><th>操作</th></tr></thead><tbody>' +
    (rows || '<tr class="empty-row"><td colspan="6">暂无运行实例。签发一个实例后即可执行 Challenge 自测。</td></tr>') + "</tbody></table></div></article></div>";
}

function lifecycleHtml(data) {
  const matrix = [["identity.resolve.chain", "解析并验证 DID 文档"], ["instance.create", "签发 Instance Credential"], ["identity.suspend", "暂停身份"], ["identity.resume", "恢复身份"], ["identity.revoke", "永久吊销身份"]];
  const state = data.identity.state || "ACTIVE";
  return '<div class="grid-2"><article class="card"><div class="section-label">当前身份状态</div><h2>' + badge(state, state === "ACTIVE" ? "success" : state === "SUSPENDED" ? "warning" : "danger") + '</h2><dl class="definition-list"><dt>Agent DID</dt><dd><code>' + esc(short(data.identity.agentDid, 25, 10)) + "</code></dd><dt>Identity Revision</dt><dd>" + data.identity.identityRevision + '</dd><dt>Successor DID</dt><dd>—</dd></dl><div class="disabled-actions"><button class="button" data-lifecycle="suspend" ' + (state === "ACTIVE" ? "" : "disabled") + '>暂停身份</button><button class="button" data-lifecycle="resume" ' + (state === "SUSPENDED" ? "" : "disabled") + '>恢复身份</button><button class="button danger" data-lifecycle="revoke" ' + (["ACTIVE", "SUSPENDED"].includes(state) ? "" : "disabled") + '>永久吊销</button></div><div class="info-banner" style="margin-top:14px"><b>真实链操作</b><span>Identity Key 签署 EIP-712，Relayer 支付 Gas；达到两次确认后页面才更新状态。</span></div></article>' +
    '<article class="card"><div class="section-label">Capability Negotiation</div><h2>Agent Skill 能力矩阵</h2><div class="capability-matrix">' +
    matrix.map(([cap, label]) => '<div class="capability-row"><div><b>' + esc(label) + "</b><br><code>" + cap + "</code></div>" + (data.contract.capabilities.includes(cap) ? badge("可用", "success") : badge("未开放", "warning")) + "</div>").join("") +
    "</div></article></div>";
}

function renderChain(data) {
  const chain = data.chain || {};
  const config = chain.config || {};
  const block = chain.latestBlock || {};
  const relayer = chain.accounts?.relayer || {};
  const contracts = config.contracts || {};
  const events = chain.events || [];
  const operations = chain.operations || [];
  const latestOperation = operations[0];
  const transaction = chain.latestTransaction;
  const rows = events.slice(0, 20).map((event) => '<tr><td>' + event.blockNumber + '</td><td><b>' + esc(event.name) + '</b><br><small>' + esc(event.contract) + '</small></td><td><code>' + esc(short(event.txHash, 18, 10)) + '</code></td><td><code>' + esc(short(JSON.stringify(event.args), 30, 12)) + '</code></td></tr>').join("");
  const operationRows = operations.map((operation) => '<tr><td><b>' + esc(operation.actionType) + '</b><br><code>' + esc(short(operation.operationId, 16, 8)) + '</code></td><td>' + badge(operation.state, operation.state === "CONFIRMED" ? "success" : operation.state === "REORGED" ? "warning" : "info") + '<br>' + esc(operation.confirmations) + '/' + esc(operation.requiredConfirmations) + '</td><td><code>' + esc(short(operation.userOpHash, 18, 10)) + '</code><br><small>' + esc(operation.bundlerState || "—") + '</small></td><td><code>' + esc(short(operation.txHash, 18, 10)) + '</code></td><td>' + esc(operation.actualGasUsed || "—") + '<br><small>' + esc(operation.actualGasCost || "—") + ' wei</small></td></tr>').join("");
  const contractCard = (label, item) => '<article class="card"><div class="section-label">' + label + '</div><h3><code>' + esc(short(item?.address, 18, 10)) + '</code></h3><dl class="definition-list"><dt>部署区块</dt><dd>' + esc(config.deploymentBlock) + '</dd><dt>Domain</dt><dd><code>' + esc(item?.domain?.name || "—") + '</code></dd><dt>verifyingContract</dt><dd><code>' + esc(item?.domain?.verifyingContract || item?.address || "—") + '</code></dd></dl></article>';
  const receipt = transaction?.receipt || {};
  const typedData = latestOperation ? '<div class="grid-2"><article class="card"><div class="section-label">最新 Agent DID EIP-712 Action</div><h3>' + esc(latestOperation.primaryType) + '</h3><dl class="definition-list"><dt>digest</dt><dd><code>' + esc(latestOperation.digest) + '</code></dd><dt>签名层</dt><dd>Agent / Manager（与 UserOp 分离）</dd></dl><pre class="terminal">' + esc(JSON.stringify({ domain: latestOperation.domain, types: latestOperation.types, primaryType: latestOperation.primaryType, message: latestOperation.message }, null, 2)) + '</pre></article><article class="card"><div class="section-label">最终 EntryPoint 交易</div><dl class="definition-list"><dt>userOpHash</dt><dd><code>' + esc(latestOperation.userOpHash || "—") + '</code></dd><dt>EntryPoint</dt><dd><code>' + esc(config.entryPoint?.address || "—") + '</code></dd><dt>Smart Account</dt><dd><code>' + esc(latestOperation.relayerSmartAccount || config.relayerSmartAccount || "—") + '</code></dd><dt>txHash</dt><dd><code>' + esc(transaction?.hash || "—") + '</code></dd><dt>from / to</dt><dd><code>' + esc(short(transaction?.from, 14, 8)) + ' → ' + esc(short(transaction?.to, 14, 8)) + '</code></dd><dt>gasUsed</dt><dd>' + esc(receipt.gasUsed || latestOperation.actualGasUsed || "—") + '</dd><dt>actualGasCost</dt><dd>' + esc(latestOperation.actualGasCost || receipt.feeWei || "—") + ' wei</dd></dl></article></div>' : '';
  $("#chain-content").innerHTML = '<div class="grid-3"><article class="card"><div class="section-label">网络</div><h2>' + esc(config.networkName || "MEMO Mainnet") + ' <code>' + esc(config.chainId) + '</code></h2><dl class="definition-list"><dt>环境</dt><dd>' + esc(config.environment) + '</dd><dt>最新区块</dt><dd>#' + esc(block.number) + '</dd><dt>区块 Hash</dt><dd><code>' + esc(short(block.hash, 18, 10)) + '</code></dd><dt>Finality</dt><dd>' + esc(config.finality?.preferFinalizedTag ? "finalized 优先" : "确认数") + ' / ' + esc(config.requiredConfirmations) + '</dd></dl></article><article class="card"><div class="section-label">ERC-4337 Relayer</div><h3><code>' + esc(short(relayer.address, 18, 10)) + '</code></h3><dl class="definition-list"><dt>角色</dt><dd>' + esc(relayer.role) + '</dd><dt>Smart Account 余额</dt><dd><code>' + esc(relayer.balanceWei) + '</code></dd><dt>EntryPoint deposit</dt><dd><code>' + esc(relayer.entryPointDepositWei) + '</code></dd><dt>Bundler</dt><dd>Alto · v0.7 · safe mode</dd></dl></article><article class="card"><div class="section-label">状态机</div><h3>CREATED → SIGNED → SUBMITTED → INCLUDED → CONFIRMED</h3><p class="muted small">SUBMITTED 记录 userOpHash；孤块进入 REORGED，并在原 Registry nonce 未消费且 deadline 有效时重放原 action。</p></article></div><div class="grid-2">' + contractCard("AgentDIDRegistryV1", contracts.agentDidRegistry) + contractCard("AgentManagementRegistryV1", contracts.agentManagementRegistry) + '</div>' + typedData + '<article class="card table-card"><div class="page-heading"><div><h2>UserOperation 与确认</h2><span>Agent action、UserOp nonce 与 Bundler executor nonce 三层分离。</span></div></div><div class="table-scroll"><table><thead><tr><th>Action</th><th>状态 / 确认</th><th>UserOp / Bundler</th><th>最终 txHash</th><th>actual Gas / Cost</th></tr></thead><tbody>' + (operationRows || '<tr class="empty-row"><td colspan="5">尚无链上操作</td></tr>') + '</tbody></table></div></article><article class="card table-card"><div class="page-heading"><div><h2>Canonical 合约事件</h2><span>Indexer 只展示当前规范链事件。</span></div></div><div class="table-scroll"><table><thead><tr><th>区块</th><th>事件</th><th>交易 Hash</th><th>Decoded args</th></tr></thead><tbody>' + (rows || '<tr class="empty-row"><td colspan="4">尚无链上事件</td></tr>') + '</tbody></table></div></article>';
}

function profileHtml(data) {
  const doc = data.resolution?.didDocument;
  const meta = data.resolution?.didDocumentMetadata;
  const history = (data.profileHistory || []).map((item) => "<tr><td>" + item.revision + "</td><td>" + when(item.occurredAt) + "</td><td>" + esc(item.kind) + "</td><td>" + esc(item.note) + "</td><td><code>" + esc(short(item.profileHash, 15, 8)) + "</code></td></tr>").join("");
  return '<div class="stack"><article class="card"><div class="page-heading"><div><h2>Profile 与版本历史</h2><span>名称与能力标签经过 profileHash 锚定；更新需要 Identity Key 支持。</span></div><button class="button" disabled>更新 Profile</button></div><dl class="definition-list"><dt>名称</dt><dd>' + esc(data.profile?.name || "—") + "</dd><dt>说明</dt><dd>" + esc(data.profile?.description || "—") + '</dd><dt>能力标签</dt><dd><div class="capabilities">' + (data.profile?.capabilities || []).map((item) => "<span>" + esc(item) + "</span>").join("") + "</div></dd><dt>profileHash</dt><dd><code>" + esc(data.identity.profileHash || "—") + "</code></dd></dl></article>" +
    '<article class="card table-card"><div class="table-scroll"><table><thead><tr><th>revision</th><th>时间</th><th>类型</th><th>变更说明</th><th>profileHash</th></tr></thead><tbody>' + (history || '<tr class="empty-row"><td colspan="5">暂无 Profile 历史</td></tr>') + "</tbody></table></div></article>" +
    '<div class="grid-2"><article class="card"><div class="section-label">当前 DID 文档（只读）</div>' + (doc ? '<pre class="terminal">' + esc(JSON.stringify(doc, null, 2)) + "</pre>" : '<div class="warning-banner"><b>不可用</b><span>Resolver 暂未返回可验证文档。</span></div>') + '</article><article class="card"><div class="section-label">解析证据</div><h2>' + (doc ? badge("完整性校验通过", "success") : badge("解析不可用", "warning")) + '</h2><dl class="definition-list"><dt>source</dt><dd>' + esc(data.resolution?.didResolutionMetadata?.source || "—") + "</dd><dt>verified</dt><dd>" + String(data.resolution?.didResolutionMetadata?.verified ?? false) + "</dd><dt>versionId</dt><dd>" + (meta?.versionId ?? "—") + "</dd><dt>state</dt><dd>" + esc(meta?.state || "—") + "</dd><dt>document.id</dt><dd><code>" + esc(doc?.id || "—") + "</code></dd></dl></article></div></div>";
}

function logsHtml(data) {
  const rows = data.events.map((event) => "<tr><td>#" + String(event.eventSequence).padStart(3, "0") + "</td><td>" + when(event.occurredAt) + "</td><td><b>" + esc(event.type) + "</b></td><td><code>" + esc(short(event.subject, 20, 8)) + "</code></td><td>" + esc(event.authority) + "</td></tr>").join("");
  return '<article class="card table-card"><div class="table-scroll"><table><thead><tr><th>序号</th><th>时间</th><th>事件</th><th>主体</th><th>权威来源</th></tr></thead><tbody>' + (rows || '<tr class="empty-row"><td colspan="5">暂无操作记录</td></tr>') + '</tbody></table></div></article><p class="muted small">日志只追加，不能修改或删除。</p>';
}

function renderDetail(data) {
  if (!data.identity.exists) return;
  $("#detail-name").textContent = data.profile?.name || "未命名 Agent";
  $("#detail-did").textContent = data.identity.agentDid;
  const state = data.identity.state || "ACTIVE";
  $("#detail-identity-chip").className = "status-chip " + (state === "ACTIVE" ? "success" : state === "SUSPENDED" ? "warning" : "danger");
  $("#detail-identity-chip").textContent = "● " + state;
  $("#detail-management-chip").className = "status-chip " + (data.management ? "success" : "info");
  $("#detail-management-chip").textContent = data.management ? "● 管理中" : "● 未管理";
  $("#instance-count").textContent = data.instances.filter((item) => item.state === "ACTIVE").length;
  $$("[data-tab]").forEach((node) => {
    const selected = node.dataset.tab === ui.tab;
    node.classList.toggle("selected", selected);
    node.setAttribute("aria-selected", String(selected));
  });
  const renderers = { overview: overviewHtml, instances: instancesHtml, lifecycle: lifecycleHtml, profile: profileHtml, logs: logsHtml };
  $("#detail-tab-content").innerHTML = renderers[ui.tab](data);
}

function renderCreate(data) {
  const exchanges = data.pairingExchanges || [];
  const statusRows = exchanges.slice(0, 8).map((item) => '<tr><td><code>' + esc(short(item.exchangeId, 20, 8)) + '</code><br><small>' + esc(item.kind) + '</small></td><td>' + badge(item.state, item.state === "PAIRED" ? "success" : ["FAILED", "EXPIRED", "CANCELLED"].includes(item.state) ? "danger" : "warning") + '</td><td>' + when(item.expiresAt) + '</td><td>' + (!["PAIRED", "FAILED", "EXPIRED", "CANCELLED"].includes(item.state) ? '<button class="button danger" data-cancel-pairing="' + esc(item.exchangeId) + '">取消</button>' : "—") + '</td></tr>').join("");
  $("#create-content").innerHTML = '<div class="info-banner"><b>已关联 ' + esc(data.counts?.total || 0) + ' 个 Agent</b><span>每个 Agent 同时只能属于一个钱包租户；Pairing 成功只创建管理草稿，不等于链上管理权。</span></div>' +
    '<div class="grid-2 pairing-directions"><article class="card"><div class="section-label">方式 A · Platform Invitation</div><h2>平台生成邀请文件</h2><p class="muted">下载后把文件路径交给 Agent。Skill 会校验平台、自动注册同一 DID、等待 finality，再完成 Pairing。</p><div class="create-form">' +
    '<label class="field">管理 scopes（逗号分隔）<input id="invitation-scopes" value="profile.update,instance.issue"></label>' +
    '<label class="field">管理期限<select id="invitation-term"><option value="2592000">30 天</option><option value="7776000">90 天</option><option value="31536000">365 天</option></select></label>' +
    '<label class="field">可发现性<select id="invitation-visibility"><option value="private">Private</option><option value="public">Public</option></select></label>' +
    '<label class="field">文件有效期<select id="invitation-ttl"><option value="900">15 分钟</option><option value="1800">30 分钟</option><option value="3600">1 小时</option></select></label>' +
    '<button id="create-invitation" class="button primary">生成并下载 Invitation</button></div><p class="muted small">文件含一次性 secret。页面不显示 handle，平台只保存 SHA-256(handle)。</p></article>' +
    '<article class="card"><div class="section-label">方式 B · Agent Offer</div><h2>导入 Agent 提供的 Offer</h2><p class="muted">本地 Skill 先生成受保护的 Offer 文件；平台校验后由钱包在 Agent 上限内选择管理条款。</p><div class="create-form">' +
    '<label class="field">Agent Offer 文件<input id="agent-offer-file" type="file" accept="application/json,.json"></label><div id="offer-preview" class="offer-preview muted small">尚未选择 Offer 文件</div>' +
    '<label class="field">申请 scopes（逗号分隔）<input id="offer-scopes" value="profile.update,instance.issue"></label>' +
    '<label class="field">申请期限<select id="offer-term"><option value="2592000">30 天</option><option value="7776000">90 天</option><option value="31536000">365 天</option></select></label>' +
    '<label class="field">可发现性<select id="offer-visibility"><option value="private">Private</option><option value="public">Public</option></select></label>' +
    '<button id="redeem-offer" class="button primary" ' + (ui.offerPackage ? "" : "disabled") + '>校验并关联 Agent</button></div><p class="muted small">Offer handle 只在本次上传内存中使用，不写入页面、sessionStorage 或日志。</p></article></div>' +
    '<article class="card table-card"><div class="page-heading"><div><h2>Pairing 进度</h2><span>CREATED → CLAIMED → REGISTRATION_PENDING → PAIRED</span></div></div><div class="table-scroll"><table><thead><tr><th>Exchange</th><th>状态</th><th>到期</th><th>操作</th></tr></thead><tbody>' + (statusRows || '<tr class="empty-row"><td colspan="4">尚无 Pairing exchange</td></tr>') + '</tbody></table></div></article>';
  if (ui.offerPackage) renderOfferPreview(ui.offerPackage);
}

function renderOfferPreview(value) {
  const node = $("#offer-preview");
  if (!node) return;
  node.className = "offer-preview";
  node.innerHTML = '<dl class="definition-list"><dt>Agent</dt><dd>' + esc(ui.offerProfile?.name || "未命名 Agent") + '</dd><dt>Agent DID</dt><dd><code>' + esc(short(value.agentDid, 28, 10)) + '</code></dd><dt>Profile Hash</dt><dd><code>' + esc(short(value.profileHash, 18, 10)) + '</code></dd><dt>最大 scopes</dt><dd>' + (value.maxScopes || []).map(esc).join(" · ") + '</dd><dt>最长期限</dt><dd>' + esc(value.maxTermSeconds) + ' 秒</dd><dt>到期</dt><dd>' + when(value.expiresAt) + '</dd></dl>';
}

function renderAlerts(data) {
  const alerts = alertsFor(data);
  const unread = alerts.filter((item) => !ui.readAlerts.has(item.id));
  $("#alert-count").classList.toggle("hidden", !unread.length);
  $("#alert-count").textContent = unread.length;
  $("#alerts-list").innerHTML = alerts.length ? alerts.map((item) => '<article class="card alert-card ' + (ui.readAlerts.has(item.id) ? "" : "unread") + '"><div class="alert-card-head"><div>' + badge(item.severity === "warn" ? "注意" : "提示", item.severity === "warn" ? "warning" : "info") + "<h3>" + esc(item.title) + '</h3><p class="muted">' + esc(item.body) + '</p></div><div><button class="button" data-alert-open="' + item.tab + '">去处理</button> ' + (ui.readAlerts.has(item.id) ? "" : '<button class="button" data-alert-read="' + item.id + '">标为已读</button>') + "</div></div></article>").join("") : '<article class="card"><h3>没有告警</h3><p class="muted">一切正常。</p></article>';
}

function renderAudit(data) {
  const type = $("#audit-type").value || "all";
  const authority = $("#audit-authority").value || "all";
  const types = [...new Set(data.events.map((event) => event.type))];
  const authorities = [...new Set(data.events.map((event) => event.authority))];
  $("#audit-type").innerHTML = '<option value="all">全部</option>' + types.map((value) => '<option ' + (value === type ? "selected" : "") + ">" + esc(value) + "</option>").join("");
  $("#audit-authority").innerHTML = '<option value="all">全部</option>' + authorities.map((value) => '<option ' + (value === authority ? "selected" : "") + ">" + esc(value) + "</option>").join("");
  const rows = data.events.filter((event) => (type === "all" || event.type === type) && (authority === "all" || event.authority === authority));
  $("#audit-table").innerHTML = rows.map((event) => "<tr><td>#" + String(event.eventSequence).padStart(3, "0") + "</td><td>" + when(event.occurredAt) + "</td><td><b>" + esc(event.type) + "</b></td><td><code>" + esc(short(event.subject, 22, 8)) + "</code></td><td>" + esc(event.authority) + "</td><td><code>" + esc(short(JSON.stringify(event.payload || {}), 24, 10)) + "</code></td></tr>").join("") || '<tr class="empty-row"><td colspan="6">暂无审计事件</td></tr>';
}

function renderAll() {
  const data = ui.dashboard;
  if (!data) return;
  renderTopbar(data);
  renderAgents(data);
  if (ui.detail) renderDetail(ui.detail);
  renderCreate(data);
  const alertData = ui.detail || (data.agents?.[0] ? { ...data.agents[0], contract: data.contract } : { identity: { exists: false }, instances: [], contract: data.contract });
  renderAlerts(alertData);
  renderAudit(data);
  renderChain(data);
}

async function refresh(quiet = false) {
  try {
    ui.dashboard = await api("/api/v1/dashboard");
    if (ui.selectedDid) {
      if (ui.dashboard.agents?.some((agent) => agent.agentDid === ui.selectedDid)) {
        ui.detail = await api("/api/v1/dashboard/agents/" + encodeURIComponent(ui.selectedDid));
      } else {
        ui.selectedDid = null;
        ui.detail = null;
        $("#agent-detail-screen").classList.add("hidden");
        $("#agent-list-screen").classList.remove("hidden");
      }
    }
    renderAll();
    if (!quiet) toast("数据已刷新");
  } catch (error) {
    if (String(error.code).includes("SESSION")) {
      sessionStorage.removeItem("memo-mainnet-wallet-session");
      ui.walletSession = null;
      showLogin();
    }
    toast((error.code || "ERROR") + "：" + error.message, "error");
  }
}

function setWalletStatus(message, kind = "") {
  const node = $("#wallet-detection-status");
  node.textContent = message;
  node.className = "wallet-status " + kind;
}

function registerWalletProvider(provider, name) {
  if (!provider || ui.discoveredProviders.some((item) => item.provider === provider)) return;
  const providerName = name || "EIP-1193 钱包";
  ui.discoveredProviders.push({ provider, name: providerName });
  if (!ui.walletProvider && ui.preferredProviderName === providerName) {
    ui.walletProvider = provider;
    ui.walletProviderName = providerName;
    ui.providerExplicitlySelected = true;
  }
  bindProviderEvents(provider);
  renderWalletProviders();
}

function renderWalletProviders() {
  const list = $("#wallet-provider-list");
  if (!list) return;
  if (!ui.discoveredProviders.length) {
    list.innerHTML = '<div class="wallet-diagnostic"><b>NO_PROVIDER</b><p>当前页面：<code>' + esc(location.href) + '</code></p><ol><li>复制此地址。</li><li>用已安装钱包插件的 Chrome 或 Edge 打开。</li><li>解锁插件后点击“重新检测钱包”。</li></ol><p>Codex 内置浏览器等隔离环境通常不会注入 EIP-1193 Provider，因此不能直接签名。</p><button class="button" data-copy="' + esc(location.href) + '">复制页面地址</button> <button id="redetect-wallet" class="button">重新检测钱包</button></div>';
    $("#connect-wallet").disabled = true;
    return;
  }
  list.innerHTML = ui.discoveredProviders.map((item, index) => '<button class="wallet-provider-choice ' + (item.provider === ui.walletProvider ? "selected" : "") + '" data-provider-index="' + index + '"><b>' + esc(item.name) + '</b><span>' + (item.provider === ui.walletProvider ? "已选择" : "选择此 Provider") + '</span></button>').join("");
  const button = $("#connect-wallet");
  button.disabled = !ui.walletProvider;
  button.querySelector("b").textContent = ui.walletProvider ? "连接 " + ui.walletProviderName : "请先选择钱包 Provider";
  button.querySelector("span").textContent = ui.discoveredProviders.length > 1 ? `检测到 ${ui.discoveredProviders.length} 个，平台不会自动选择` : "点击上方选择";
  setWalletStatus(ui.walletProvider ? "Provider 已选择。登录前会先校验并切换到 chain 985。" : "已检测到钱包插件；请选择要使用的 Provider。", ui.walletProvider ? "ready" : "");
}

function detectWalletProviders() {
  setWalletStatus("正在检测 EIP-6963 / EIP-1193 钱包 Provider…");
  window.addEventListener("eip6963:announceProvider", (event) => registerWalletProvider(event.detail?.provider, event.detail?.info?.name));
  window.dispatchEvent(new Event("eip6963:requestProvider"));
  setTimeout(() => {
    if (window.ethereum) registerWalletProvider(window.ethereum, window.ethereum.isMetaMask ? "MetaMask 兼容钱包" : "浏览器钱包");
    if (!ui.discoveredProviders.length) {
      setWalletStatus("NO_PROVIDER：此浏览器没有注入钱包 Provider。请按下方步骤换用已安装插件的 Chrome/Edge。", "error");
      renderWalletProviders();
    }
  }, 350);
}

async function connectWallet() {
  try {
    if (!ui.walletProvider) throw Object.assign(new Error("请先选择一个浏览器钱包 Provider"), { code: "NO_PROVIDER" });
    const chainConfig = await api("/api/v1/chain/config");
    await ensureWalletChain(chainConfig);
    const accounts = await ui.walletProvider.request({ method: "eth_requestAccounts" });
    const account = accounts?.[0];
    if (!/^0x[0-9a-fA-F]{40}$/.test(account || "")) throw Object.assign(new Error("钱包插件未返回有效 EVM 地址"), { code: "INVALID_WALLET_ACCOUNT" });
    const chainHex = await ui.walletProvider.request({ method: "eth_chainId" });
    const chainId = Number.parseInt(chainHex, 16);
    if (chainId !== 985) throw Object.assign(new Error("钱包仍未切换到 chain 985"), { code: "WRONG_NETWORK" });
    const intent = await api("/api/v1/wallet-login-intents", { method: "POST", body: JSON.stringify({ account, chainId }) });
    let signature;
    try {
      signature = await ui.walletProvider.request({ method: "personal_sign", params: [intent.message, account] });
    } catch (error) {
      if (error?.code !== -32602) throw error;
      signature = await ui.walletProvider.request({ method: "personal_sign", params: [account, intent.message] });
    }
    ui.walletSession = await api("/api/v1/wallet-sessions", { method: "POST", body: JSON.stringify({ challengeId: intent.challengeId, signature }) });
    sessionStorage.setItem("memo-mainnet-wallet-session", JSON.stringify(ui.walletSession));
    showApp("agents");
    await refresh(true);
    toast("钱包地址与签名已由服务端验证");
  } catch (error) {
    const normalized = walletError(error);
    setWalletStatus(normalized.code + "：" + normalized.message, "error");
    throw normalized;
  }
}

async function ensureWalletChain(config) {
  const expected = "0x" + Number(config.chainId).toString(16);
  const current = await ui.walletProvider.request({ method: "eth_chainId" });
  if (current.toLowerCase() === expected.toLowerCase()) {
    $("#wallet-network-help")?.classList.add("hidden");
    return;
  }
  try {
    await ui.walletProvider.request({ method: "wallet_switchEthereumChain", params: [{ chainId: expected }] });
  } catch (error) {
    if (error?.code !== 4902 || !config.walletAddChainEnabled) {
      renderManualNetwork(config);
      throw Object.assign(new Error("请按页面参数手工配置并切换到 " + config.networkName + " (chain 985)"), { code: "WRONG_NETWORK" });
    }
    await ui.walletProvider.request({ method: "wallet_addEthereumChain", params: [{
      chainId: expected,
      chainName: config.networkName,
      nativeCurrency: config.nativeCurrency,
      rpcUrls: [config.rpcUrl],
    }] });
  }
  const verified = await ui.walletProvider.request({ method: "eth_chainId" });
  if (verified.toLowerCase() !== expected.toLowerCase()) throw Object.assign(new Error("钱包网络切换未完成"), { code: "WRONG_NETWORK" });
}

function renderManualNetwork(config) {
  const node = $("#wallet-network-help");
  if (!node) return;
  node.classList.remove("hidden");
  node.innerHTML = '<b>手工添加网络</b><dl class="definition-list"><dt>Network</dt><dd>' + esc(config.networkName) + '</dd><dt>Chain ID</dt><dd><code>' + esc(config.chainId) + '</code> <button class="button small-copy" data-copy="' + esc(config.chainId) + '">复制</button></dd><dt>RPC</dt><dd><code>' + esc(config.rpcUrl || "请向管理员确认") + '</code>' + (config.rpcUrl ? ' <button class="button small-copy" data-copy="' + esc(config.rpcUrl) + '">复制</button>' : '') + '</dd><dt>原生币</dt><dd>' + esc(config.nativeCurrency?.symbol || "未配置") + '</dd></dl><p>配置完成并切换到 chain 985 后重新点击连接。</p>';
}

function walletError(error) {
  if (error?.code === 4001) return Object.assign(new Error("你拒绝了钱包请求；平台没有创建会话或提交交易"), { code: "USER_REJECTED" });
  if (error?.code === -32002) return Object.assign(new Error("钱包中已有待处理请求，请先在插件中完成或取消"), { code: "REQUEST_PENDING" });
  if (error?.code === "NO_PROVIDER") return error;
  if ([4902, "WRONG_NETWORK", "UNSUPPORTED_WALLET_NETWORK"].includes(error?.code)) return Object.assign(new Error(error.message || "钱包网络不是 chain 985"), { code: "WRONG_NETWORK" });
  if (String(error?.code || "").includes("SESSION")) return Object.assign(new Error("钱包会话已过期，请重新登录"), { code: "SESSION_EXPIRED" });
  return Object.assign(new Error(error?.message || "钱包请求失败"), { code: error?.code || "WALLET_REQUEST_FAILED" });
}

function bindProviderEvents(provider) {
  if (ui.providerListeners.has(provider) || typeof provider.on !== "function") return;
  ui.providerListeners.add(provider);
  provider.on("accountsChanged", (accounts) => {
    if (ui.walletSession && !accounts?.some((account) => account.toLowerCase() === ui.walletSession.account?.toLowerCase())) invalidateWalletSession("ACCOUNT_CHANGED");
  });
  provider.on("chainChanged", (chainId) => {
    if (ui.walletSession && Number.parseInt(chainId, 16) !== 985) invalidateWalletSession("CHAIN_CHANGED");
  });
}

function invalidateWalletSession(reason) {
  if (ui.walletSession?.token) void api("/api/v1/wallet-session", { method: "DELETE" }).catch(() => {});
  sessionStorage.removeItem("memo-mainnet-wallet-session");
  ui.walletSession = null;
  ui.dashboard = null;
  ui.detail = null;
  showLogin();
  setWalletStatus(reason + "：旧会话已立即失效，请确认账户和 chain 985 后重新登录。", "error");
}

function scopesFromInput(selector) {
  const scopes = [...new Set($(selector).value.split(",").map((item) => item.trim()).filter(Boolean))].sort();
  if (!scopes.length || scopes.some((scope) => !/^[a-z][a-z0-9_.:-]{1,63}$/.test(scope))) throw Object.assign(new Error("scope 格式不正确"), { code: "INVALID_PAIRING_SCOPES" });
  return scopes;
}

function randomBase64Url(bytes) {
  const value = crypto.getRandomValues(new Uint8Array(bytes));
  let binary = "";
  value.forEach((item) => { binary += String.fromCharCode(item); });
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replaceAll("=", "");
}

async function sha256Hex(value) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((item) => item.toString(16).padStart(2, "0")).join("");
}

function downloadPairingFile(filename, value) {
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2) + "\n"], { type: "application/json" }));
  link.download = filename;
  link.click();
  URL.revokeObjectURL(link.href);
}

async function createInvitation() {
  const exchangeId = "pinv_" + crypto.randomUUID();
  const handle = `memo-pair-v2.${exchangeId}.${randomBase64Url(32)}`;
  const requestedScopes = scopesFromInput("#invitation-scopes");
  const requestedTermSeconds = Number($("#invitation-term").value);
  const visibility = $("#invitation-visibility").value;
  const ttlSeconds = Number($("#invitation-ttl").value);
  const remote = await api("/api/v1/pairing-invitations", {
    method: "POST",
    headers: { "idempotency-key": `console:${exchangeId}:create` },
    body: JSON.stringify({ exchangeId, tokenHash: await sha256Hex(handle), platformOrigin: location.origin, requestedScopes, requestedTermSeconds, visibility, ttlSeconds }),
  });
  const invitation = {
    schema: "memo.agent-pairing-package/2",
    kind: "platform-invitation",
    exchangeId,
    platformOrigin: remote.platformOrigin,
    environment: remote.environment,
    chainId: remote.chainId,
    didRegistry: remote.didRegistry,
    managementRegistry: remote.managementRegistry,
    handle,
    issuedAt: remote.issuedAt,
    expiresAt: remote.expiresAt,
    managerAccount: remote.managerAccount,
    requestedScopes: remote.requestedScopes,
    requestedTermSeconds: remote.requestedTermSeconds,
    visibility: remote.visibility,
  };
  downloadPairingFile(`memo-agent-invitation-${exchangeId}.json`, invitation);
  return remote;
}

async function loadOfferFile(file) {
  if (!file || file.size > 65_536) throw Object.assign(new Error("Offer 文件不存在或超过 64 KiB"), { code: "INVALID_PAIRING_FILE" });
  let value;
  try { value = JSON.parse(await file.text()); } catch { throw Object.assign(new Error("Offer 不是有效 JSON"), { code: "INVALID_PAIRING_FILE" }); }
  const expectedFields = ["schema", "kind", "exchangeId", "platformOrigin", "environment", "chainId", "didRegistry", "managementRegistry", "handle", "issuedAt", "expiresAt", "agentDid", "identityAccount", "profileHash", "maxScopes", "maxTermSeconds"].sort();
  const actualFields = Object.keys(value || {}).sort();
  if (JSON.stringify(expectedFields) !== JSON.stringify(actualFields) || value.schema !== "memo.agent-pairing-package/2" || value.kind !== "agent-offer") {
    throw Object.assign(new Error("Offer schema、kind 或字段集合不正确"), { code: "INVALID_PAIRING_FILE" });
  }
  const remote = await api("/api/v1/pairing-offers/inspect", { method: "POST", body: JSON.stringify({ exchangeId: value.exchangeId, handle: value.handle }) });
  const scalarFields = ["schema", "kind", "exchangeId", "platformOrigin", "environment", "chainId", "didRegistry", "managementRegistry", "issuedAt", "expiresAt", "agentDid", "identityAccount", "profileHash", "maxTermSeconds"];
  if (scalarFields.some((field) => String(remote[field]).toLowerCase() !== String(value[field]).toLowerCase()) || JSON.stringify(remote.maxScopes) !== JSON.stringify(value.maxScopes)) {
    throw Object.assign(new Error("Offer 文件与平台权威元数据不一致"), { code: "PAIRING_PACKAGE_MISMATCH" });
  }
  ui.offerPackage = value;
  try { ui.offerProfile = (await api("/api/v1/agent-dids/" + encodeURIComponent(value.agentDid))).profile; } catch { ui.offerProfile = null; }
  renderOfferPreview(value);
  const button = $("#redeem-offer");
  if (button) button.disabled = false;
}

async function redeemOffer() {
  const offer = ui.offerPackage;
  if (!offer) throw Object.assign(new Error("请先选择并校验 Offer 文件"), { code: "PAIRING_OFFER_REQUIRED" });
  const requestedScopes = scopesFromInput("#offer-scopes");
  const requestedTermSeconds = Number($("#offer-term").value);
  if (requestedScopes.some((scope) => !offer.maxScopes.includes(scope))) throw Object.assign(new Error("申请 scope 超过 Agent Offer 上限"), { code: "PAIRING_SCOPE_EXCEEDED" });
  if (requestedTermSeconds > Number(offer.maxTermSeconds)) throw Object.assign(new Error("申请期限超过 Agent Offer 上限"), { code: "PAIRING_TERM_EXCEEDED" });
  const remote = await api(`/api/v1/pairing-offers/${encodeURIComponent(offer.exchangeId)}/redeem`, {
    method: "POST",
    headers: { "idempotency-key": `console:${offer.exchangeId}:redeem` },
    body: JSON.stringify({ handle: offer.handle, requestedScopes, requestedTermSeconds, visibility: $("#offer-visibility").value }),
  });
  ui.offerPackage = null;
  ui.offerProfile = null;
  return remote;
}

async function createManagementWithWallet(draftId = ui.detail?.managementDraft?.draftId) {
  if (!ui.walletProvider || !ui.walletSession) throw Object.assign(new Error("需要保持已验证的钱包插件连接"), { code: "WALLET_PLUGIN_NOT_FOUND" });
  const accounts = await ui.walletProvider.request({ method: "eth_accounts" });
  if (!accounts?.some((account) => account.toLowerCase() === ui.walletSession.account.toLowerCase())) throw Object.assign(new Error("钱包插件当前账户与登录会话不一致"), { code: "WALLET_ACCOUNT_MISMATCH" });
  if (!draftId) throw Object.assign(new Error("此 Agent 没有可签署的管理草稿"), { code: "MANAGEMENT_DRAFT_NOT_FOUND" });
  await ensureWalletChain(await api("/api/v1/chain/config"));
  const result = await api(`/api/v1/management-drafts/${encodeURIComponent(draftId)}/intent`, { method: "POST" });
  const intent = result.intent;
  const typedData = { domain: intent.domain, types: intent.types, primaryType: intent.primaryType, message: intent.message };
  let managerSignature;
  try { managerSignature = await ui.walletProvider.request({ method: "eth_signTypedData_v4", params: [ui.walletSession.account, JSON.stringify(typedData)] }); }
  catch (error) { throw walletError(error); }
  return api(`/api/v1/management-drafts/${encodeURIComponent(draftId)}/wallet-signature`, {
    method: "POST",
    headers: { "idempotency-key": intent.digest },
    body: JSON.stringify({ intentId: intent.intentId, managerSignature }),
  });
}

async function confirmAction(title, body) {
  $("#confirm-title").textContent = title;
  $("#confirm-body").innerHTML = body;
  const dialog = $("#confirm-dialog");
  dialog.showModal();
  return new Promise((resolve) => dialog.addEventListener("close", () => resolve(dialog.returnValue === "default"), { once: true }));
}

function exportEvents(format) {
  const events = ui.dashboard?.events || [];
  const content = format === "json" ? JSON.stringify(events, null, 2) : ["eventSequence,occurredAt,type,subject,authority", ...events.map((event) => [event.eventSequence, event.occurredAt, event.type, event.subject, event.authority].map((value) => '"' + String(value).replaceAll('"', '""') + '"').join(","))].join("\n");
  const link = document.createElement("a");
  link.href = URL.createObjectURL(new Blob([content], { type: format === "json" ? "application/json" : "text/csv" }));
  link.download = "agent-did-audit." + format;
  link.click();
  URL.revokeObjectURL(link.href);
  toast("已导出 " + format.toUpperCase());
}

document.addEventListener("click", async (event) => {
  const target = event.target.closest("button");
  if (!target) return;
  if (target.id === "connect-wallet") return action(connectWallet);
  if (target.id === "redetect-wallet") return detectWalletProviders();
  if (target.dataset.providerIndex !== undefined) {
    const selected = ui.discoveredProviders[Number(target.dataset.providerIndex)];
    if (!selected) return;
    ui.walletProvider = selected.provider;
    ui.walletProviderName = selected.name;
    ui.providerExplicitlySelected = true;
    ui.preferredProviderName = selected.name;
    sessionStorage.setItem("memo-mainnet-wallet-provider", selected.name);
    return renderWalletProviders();
  }
  if (target.dataset.view) return switchView(target.dataset.view);
  if (target.dataset.filter) {
    ui.filter = target.dataset.filter;
    $$("[data-filter]").forEach((node) => node.classList.toggle("selected", node.dataset.filter === ui.filter));
    return renderAgents(ui.dashboard);
  }
  if (target.dataset.openAgent) {
    return action(async () => {
      ui.selectedDid = target.dataset.openAgent;
      ui.detail = await api("/api/v1/dashboard/agents/" + encodeURIComponent(ui.selectedDid));
      $("#agent-list-screen").classList.add("hidden");
      $("#agent-detail-screen").classList.remove("hidden");
      ui.tab = "overview";
      renderDetail(ui.detail);
    });
  }
  if (target.dataset.tab) {
    ui.tab = target.dataset.tab;
    return ui.detail && renderDetail(ui.detail);
  }
  if (target.id === "back-to-list") {
    $("#agent-detail-screen").classList.add("hidden");
    $("#agent-list-screen").classList.remove("hidden");
    ui.selectedDid = null;
    ui.detail = null;
    return;
  }
  if (target.id === "refresh") return refresh();
  if (target.id === "refresh-chain") return refresh();
  if (target.id === "reset-session") {
    try { await api("/api/v1/wallet-session", { method: "DELETE" }); } catch {}
    sessionStorage.removeItem("memo-mainnet-wallet-session");
    ui.walletSession = null;
    ui.detail = null;
    ui.selectedDid = null;
    showLogin();
    return toast("钱包会话已退出");
  }
  if (target.id === "create-invitation") return action(createInvitation, "Invitation 已安全下载；请把文件交给目标 Agent 接受");
  if (target.id === "redeem-offer") return action(redeemOffer, "Agent Offer 已兑换，管理草稿已创建");
  if (target.id === "create-instance") return toast("Instance Key 只能在本地 Agent Skill 中生成", "error");
  if (target.id === "create-management") return action(() => createManagementWithWallet(), "管理请求已签名；等待本地 Agent 审核并签署");
  if (target.dataset.signDraft) return action(() => createManagementWithWallet(target.dataset.signDraft), "钱包已签署管理草稿；等待本地 Agent 审核");
  if (target.dataset.lifecycle) {
    const verb = target.dataset.lifecycle;
    const title = verb === "revoke" ? "永久吊销 Agent DID？" : verb === "suspend" ? "暂停 Agent DID？" : "恢复 Agent DID？";
    const yes = await confirmAction(title, '<p>该操作必须在本地 Agent Skill 中明确确认并由 Identity Key 签名；Console 不持有该密钥。永久吊销不可恢复。</p>');
    if (yes) return toast("请在本地运行 memo-agent-mainnet identity " + verb + " --json", "error");
  }
  if (target.id === "self-test") return toast("控制证明请在本地 Skill 执行 identity self-test", "error");
  if (target.dataset.cancelPairing) {
    const yes = await confirmAction("取消 Pairing exchange？", "<p>取消后 Invitation / Offer 立即失效，但不会影响 AgentDID 或已建立的管理关系。</p>");
    if (yes) return action(() => api("/api/v1/pairing-exchanges/" + encodeURIComponent(target.dataset.cancelPairing) + "/cancel", { method: "POST", headers: { "idempotency-key": `console:${target.dataset.cancelPairing}:cancel` } }), "Pairing exchange 已取消");
  }
  if (target.dataset.revoke) {
    const instance = (ui.detail?.instances || []).find((item) => item.instanceId === target.dataset.revoke);
    const yes = await confirmAction("撤销实例 " + (instance?.name || "") + "？", "<p>只撤销这个 Instance Credential；AgentDID 和其他实例不受影响。</p>");
    if (yes) return action(() => api("/api/v1/instance-credentials/" + encodeURIComponent(target.dataset.revoke) + "/revoke", { method: "POST", body: JSON.stringify({ reason: "console-request" }) }), "实例凭证已撤销");
  }
  if (target.dataset.alertOpen) {
    switchView(target.dataset.alertOpen === "create" ? "create" : "agents");
    if (target.dataset.alertOpen !== "create") {
      $("#agent-list-screen").classList.add("hidden");
      $("#agent-detail-screen").classList.remove("hidden");
      ui.tab = target.dataset.alertOpen;
      if (ui.detail) renderDetail(ui.detail);
    }
    return;
  }
  if (target.dataset.alertRead) {
    ui.readAlerts.add(target.dataset.alertRead);
    sessionStorage.setItem("memo-agent-read-alerts", JSON.stringify([...ui.readAlerts]));
    return renderAlerts(ui.detail || { identity: { exists: false }, instances: [], contract: ui.dashboard?.contract });
  }
  if (target.id === "mark-alerts-read") {
    alertsFor(ui.detail || { identity: { exists: false }, instances: [], contract: ui.dashboard?.contract }).forEach((item) => ui.readAlerts.add(item.id));
    sessionStorage.setItem("memo-agent-read-alerts", JSON.stringify([...ui.readAlerts]));
    return renderAlerts(ui.detail || { identity: { exists: false }, instances: [], contract: ui.dashboard?.contract });
  }
  if (target.id === "export-json") return exportEvents("json");
  if (target.id === "export-csv") return exportEvents("csv");
  if (target.dataset.copy) {
    await navigator.clipboard.writeText(target.dataset.copy);
    toast("已复制");
  }
});

$("#instance-form").addEventListener("submit", (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  toast("Instance Credential 必须由本地 Identity Key 签发", "error");
  $("#instance-dialog").close();
});

$("#audit-type").addEventListener("change", () => renderAudit(ui.dashboard));
$("#audit-authority").addEventListener("change", () => renderAudit(ui.dashboard));

document.addEventListener("change", async (event) => {
  if (event.target?.id !== "agent-offer-file") return;
  ui.offerPackage = null;
  ui.offerProfile = null;
  const button = $("#redeem-offer");
  if (button) button.disabled = true;
  try {
    await loadOfferFile(event.target.files?.[0]);
    toast("Offer 已通过平台校验；请确认管理条款");
  } catch (error) {
    const preview = $("#offer-preview");
    if (preview) {
      preview.className = "offer-preview warning-banner";
      preview.textContent = (error.code || "INVALID_PAIRING_FILE") + "：" + error.message;
    }
  }
});

async function initialize() {
  detectWalletProviders();
  if (!ui.walletSession?.token) return showLogin();
  try {
    const current = await api("/api/v1/wallet-session");
    ui.walletSession = { ...ui.walletSession, ...current };
    showApp("agents");
    await refresh(true);
  } catch {
    sessionStorage.removeItem("memo-mainnet-wallet-session");
    ui.walletSession = null;
    showLogin();
  }
}

initialize();
