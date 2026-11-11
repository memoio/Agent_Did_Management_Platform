type Message={from:string;to:string;action:string;result:string};

function flow(steps:string[]){return `<ol class="guide-flow" aria-label="操作流程图">${steps.map((step,index)=>`<li><span class="guide-step-number">${index+1}</span><span>${step}</span></li>`).join("")}</ol>`;}
function sequence(messages:Message[]){return `<div class="guide-sequence" role="group" aria-label="交互时序图，按时间从上到下">${messages.map((message,index)=>`<div class="guide-message"><span class="guide-message-number">${index+1}</span><div><strong>${message.from} <span aria-hidden="true">→</span> ${message.to}</strong><p>${message.action}</p><small>${message.result}</small></div></div>`).join("")}</div>`;}

export function creationGuideMarkup(){return `
<div class="guide-intro"><p class="eyebrow">START HERE · OPBNB TESTNET 5611</p><h1>创建指引</h1><p>先选一条入口，最终都由钱包与 Agent 分别签署同一管理意图。看到链上操作 <strong>CONFIRMED</strong> 且管理关系为“管理中”，才算完成。</p><p>页面时间统一显示年月日时分秒，并标注“UTC+08:00”（东八区）。钱包签名、邀请文件和 API 保持原始时间格式，便于校验。</p></div>
<div class="grid three guide-choices">
  <article class="card"><h2>我是新 Agent 的管理员</h2><p>从 Console 下载 Invitation；Agent 按文件内指引安装 Skill、注册 DID，再完成双签。</p><a class="guide-link" href="#guide-invitation">查看新建流程 ↓</a></article>
  <article class="card"><h2>Agent 已有 DID 和 Offer</h2><p>导入 Agent 提供的 Offer，权限和期限不能超过 Agent 给出的上限。</p><a class="guide-link" href="#guide-offer">查看 Offer 流程 ↓</a></article>
  <article class="card"><h2>我只知道 Agent DID</h2><p>直接输入已注册 DID 并提出管理条款；Agent 仍须审核、签名。</p><a class="guide-link" href="#guide-known-did">查看 DID 流程 ↓</a></article>
</div>
<article class="card"><h2>整条链路</h2>${flow(["浏览器连接钱包并签登录消息","选 Invitation、Offer 或已知 DID","钱包核对权限与期限并签名","Agent 本地 Skill 审核同一意图并签名","平台 Worker 发送交易并等待最终性","在“我的 Agent”核对 DID 与管理关系"])}<p class="muted">操作场所：钱包用户在本页面，Agent 操作人在 Agent 本机终端，链上交易由平台 Worker 自动提交。</p><button data-view="create">前往“登记 / 创建”</button><button class="secondary" data-view="agents">查看“我的 Agent”</button></article>

<section id="guide-invitation" class="guide-section"><h2>路线 A：新 Agent · Invitation</h2><p>适合 Agent 尚无 DID。Invitation 内含 Skill 安装来源、平台 API、合约地址、一次性凭据和有效期；按临时密码传递，不能上传到公开仓库。</p>
${flow(["Console 创建 Invitation 并下载 JSON","Agent 安装测试链 Skill，检查邀请环境","Agent 指定唯一 ID，创建本地身份并领取 Invitation","Agent 确认 Profile，单独注册 DID，等待 CONFIRMED 后完成配对","钱包在“我的 Agent”签署管理草稿","Agent 用 Skill 审核并批准请求","Worker 上链，Console 查询到 CONFIRMED"])}
<div class="table-wrap"><table><thead><tr><th>步骤</th><th>在哪里、由谁做</th><th>具体操作</th><th>完成后看到</th></tr></thead><tbody>
<tr><td>1</td><td>Console · 钱包用户</td><td>连接 MetaMask、OKX Wallet 或 Rabby，确认网络为 opBNB Testnet 5611；在“登记 / 创建”填写权限、最长期限、邀请有效期，点击“生成并下载 Invitation”。</td><td><code>.memo-invitation.json</code> 文件</td></tr>
<tr><td>2</td><td>Agent 本机 · Agent 操作人</td><td>核对文件中的 <code>agentSetup</code> 并安装 Skill；同机测试部署使用内置公开配置，其他部署需完整配置 API 与合约地址。私钥只留在 Agent 本机。</td><td>Skill 可连接平台与测试链</td></tr>
<tr><td>3</td><td>Agent 本机 · Agent 操作人</td><td>为本 Agent 指定唯一 ID，运行 <code>agent init</code>；检查 Profile 模板，先领取 Invitation，再单独注册 DID，确认后重复接受邀请。</td><td>注册 <code>CONFIRMED</code>，平台形成配对草稿</td></tr>
<tr><td>4</td><td>Console · 钱包用户</td><td>刷新“我的 Agent”，打开该 Agent 的管理草稿，检查 DID、权限与期限，点击“钱包签署草稿”。</td><td>待 Agent 审核的请求</td></tr>
<tr><td>5</td><td>Agent 本机 · Agent 操作人</td><td>依次运行 <code>binding pending</code>、<code>binding inspect &lt;请求ID&gt;</code>、<code>binding approve &lt;请求ID&gt;</code>，逐项核对 Manager 和签名内容。</td><td>双方签名齐全，产生 operation</td></tr>
<tr><td>6</td><td>Console · 钱包用户</td><td>点击“查询绑定进度”，等待 <code>CONFIRMED</code>，再到“我的 Agent”核对“管理中”。</td><td>链上 DID 与管理关系均生效</td></tr>
</tbody></table></div>
<div class="guide-code"><h3>Agent 本机示例命令</h3><pre>git clone --branch main --single-branch https://github.com/memoio/agent_did_skill.git
cd agent_did_skill/skills/memo-agent-did-opbnb-testnet
npm ci --omit=dev
# 同机平台可用 Skill 内置公开配置；其他部署核对 agentSetup 后完整配置
node bin/memo-agent-opbnb-testnet agent init &lt;唯一Agent-ID&gt;
node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; pair invitation accept invitation.json
# 填写并确认返回目录中的 profile.template.json，再保存为 profile.json
node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; register --profile &lt;profile.json路径&gt;
node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; pair invitation accept invitation.json
node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; binding pending
node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; binding inspect &lt;请求ID&gt;
node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; binding approve &lt;请求ID&gt;</pre></div>
<h3>时序图 · Invitation 注册与绑定</h3>${sequence([
  {from:"钱包 / Console",to:"API / 数据库",action:"登录签名；创建 Invitation",result:"保存一次性凭据哈希，下载邀请文件"},
  {from:"钱包用户",to:"Agent 本机",action:"安全交付 Invitation",result:"Agent 核对平台来源、合约与有效期"},
  {from:"Agent Skill",to:"API / 数据库",action:"指定 Agent ID，创建本地身份并领取 Invitation",result:"返回 WAITING_REGISTRATION，不发送注册交易"},
  {from:"Agent Skill",to:"API / Worker / opBNB",action:"确认 Profile 后单独提交注册签名",result:"DID 注册交易达到 CONFIRMED"},
  {from:"Agent Skill",to:"API / 数据库",action:"再次接受 Invitation",result:"完成链下配对，生成管理草稿"},
  {from:"钱包 / Console",to:"API / 数据库",action:"核对草稿并签署管理意图",result:"请求进入 Agent 待办"},
  {from:"Agent Skill",to:"API / 数据库",action:"检查并批准同一意图",result:"双方签名齐全，产生 operation"},
  {from:"Worker",to:"opBNB Registry",action:"提交管理关系交易并确认最终性",result:"Indexer 写数据库镜像；Console 显示 CONFIRMED"},
])}
<p class="muted">若 Invitation 中的平台地址是 <code>127.0.0.1</code>，Agent 必须与平台在同一台机器。远程 Agent 需使用可访问的 HTTPS 平台地址重新创建邀请。</p></section>

<section id="guide-offer" class="guide-section"><h2>路线 B：已有 Agent · Offer</h2><p>适合 Agent 已注册且状态为 ACTIVE，想由 Agent 先限定钱包可申请的权限和期限。</p>
${flow(["Agent Skill 创建 Offer JSON","钱包在 Console 导入并校验 Offer","钱包在上限内选条款、核对并签名","Agent 检查待办并批准","Worker 上链，查询 CONFIRMED"])}
<div class="guide-code"><h3>Agent 本机创建 Offer</h3><pre>node bin/memo-agent-opbnb-testnet --agent &lt;唯一Agent-ID&gt; pair offer create &lt;该Agent的offers目录&gt;/agent.memo-offer.json agent.read 30 900</pre><p>30 是管理期限上限（天），900 是 Offer 文件有效期（秒）。文件含一次性凭据，请安全传给钱包用户。</p></div>
<ol class="guide-actions"><li>钱包用户在“登记 / 创建”选择“导入 Agent 提供的 Offer”，导入 JSON；页面显示权限、期限上限和有效期。</li><li>点击“核对绑定信息”，确认当前钱包地址、DID 与条款，再让钱包签名；平台生成配对与管理草稿。</li><li>Agent 指定自己的 ID，运行 <code>--agent &lt;唯一Agent-ID&gt; binding pending</code>、<code>binding inspect &lt;请求ID&gt;</code>、<code>binding approve &lt;请求ID&gt;</code>；钱包回到结果页查询操作进度。</li></ol>
<h3>时序图 · Offer 双签</h3>${sequence([
  {from:"Agent Skill",to:"API / 数据库",action:"登记 Offer 上限与一次性凭据哈希",result:"Agent 本机输出 Offer JSON"},
  {from:"Agent",to:"钱包 / Console",action:"安全交付 Offer",result:"钱包导入并核对来源与有效期"},
  {from:"钱包 / Console",to:"API / 数据库",action:"兑换 Offer、创建管理草稿并签名",result:"Agent 待办出现请求"},
  {from:"Agent Skill",to:"API / 数据库",action:"核对 Manager、权限、期限、digest 后批准",result:"operation 进入 Worker 队列"},
  {from:"Worker",to:"opBNB Registry",action:"提交 ActivateRelationship",result:"最终性确认后，关系显示“管理中”"},
])}</section>

<section id="guide-known-did" class="guide-section"><h2>路线 C：已有 Agent · 已知 DID</h2><p>无需传递文件。钱包选择“输入已知 Agent DID”，填写已注册 DID、权限和期限，点击“核对绑定信息”并签名。Agent 用相同的 <code>binding pending / inspect / approve</code> 命令审核。链上结果与 Offer 相同，都是双方签署的管理关系；此路线没有 Offer 的预设上限与一次性凭据。</p>
<p>钱包签名后，结果页显示“意图 ID（Agent 请求 ID）”和可复制的 Agent 提示词。Agent 在自己的电脑选择唯一 Agent ID，所有命令带 <code>--agent &lt;唯一Agent-ID&gt;</code>；先运行 <code>binding pending</code>，再用 <code>binding inspect &lt;意图ID&gt;</code> 核对 Manager、权限、期限及 digest；你确认一致后，Agent 运行 <code>binding approve &lt;意图ID&gt;</code>。Skill 自动提交双方已签名的意图，Worker 发送链上交易。若意图过期或交易失败，重新创建意图并取得双方新签名。“查询链上关系”在操作确认前会显示尚未生效。</p>
${flow(["钱包输入 DID 并核对条款","钱包签署管理意图","Agent Skill 审核并批准","Worker 提交关系交易","查询 CONFIRMED 与“管理中”"])}
<h3>时序图 · 已知 DID</h3>${sequence([
  {from:"钱包 / Console",to:"API / 数据库",action:"提交 DID 与条款，签署管理意图",result:"平台保存待 Agent 审核的请求"},
  {from:"Agent Skill",to:"API / 数据库",action:"binding inspect 并 approve",result:"核对后提供 Agent 签名"},
  {from:"Worker",to:"opBNB Registry",action:"提交双签交易",result:"Console 查询 operation 和管理关系"},
])}</section>

<section id="guide-after" class="guide-section"><h2>创建之后如何管理</h2><p>进入“我的 Agent”→“查看详情”。Profile、文档、生命周期和实例操作由 Agent 本机 Skill 发起；管理关系的续期、结束、转移从详情中的“管理关系操作”发起。</p>
<div class="table-wrap"><table><thead><tr><th>目标</th><th>在哪里操作</th><th>签名与链上结果</th><th>在哪里核对</th></tr></thead><tbody>
<tr><td>更新 Profile / DID 文档</td><td>Agent 本机：<code>identity update-profile profile.json</code> / <code>identity update-document document.json</code></td><td>Agent 签名；链上更新哈希，平台保留原文版本</td><td>详情 → Profile 与 DID 文档</td></tr>
<tr><td>暂停 / 恢复 / 永久吊销 DID</td><td>Agent 本机：<code>identity suspend</code> / <code>resume</code> / <code>revoke</code></td><td>Agent 签名；永久吊销不可恢复</td><td>详情 → 生命周期；安全告警</td></tr>
<tr><td>创建 / 撤销运行实例</td><td>Agent 本机：<code>instance create worker-01 1</code> / <code>instance revoke &lt;instanceId&gt;</code></td><td>实例私钥留本机；撤销凭证哈希上链</td><td>详情 → 运行实例</td></tr>
<tr><td>管理续期</td><td>Console 详情 → 管理关系操作 → 续期；Agent Skill 审核</td><td>当前 Manager 与 Agent 签同一意图</td><td>详情 → 概览、操作记录</td></tr>
<tr><td>结束管理关系</td><td>Console 详情 → 结束关系，或 Agent 本机 <code>management end</code></td><td>当前 Manager 或 Agent 签名；链上标记结束</td><td>详情 → 概览</td></tr>
<tr><td>转移管理关系</td><td>Console 详情 → 转移；填写新 Manager 地址</td><td>Agent、旧 Manager、新 Manager 各自签署同一意图</td><td>详情 → 概览、操作记录</td></tr>
<tr><td>排查与导出</td><td>Console → 安全告警 / 审计日志 / 区块链学习</td><td>查看真实事件、交易、最终性；导出审计 JSON / CSV</td><td>操作状态须为 CONFIRMED</td></tr>
</tbody></table></div>
<h3>时序图 · 后续链上动作</h3>${sequence([
  {from:"Console 或 Agent Skill",to:"API / 数据库",action:"创建动作意图，记录期望 revision、nonce、期限",result:"页面或 Skill 显示待签内容"},
  {from:"所需签署人",to:"API / 数据库",action:"分别核对并签署同一 digest",result:"签名齐全才生成可提交 operation"},
  {from:"Worker",to:"opBNB Registry",action:"提交交易、读取收据与最终性",result:"Indexer 同步事件、数据库镜像和游标"},
  {from:"Console",to:"API / 数据库",action:"查看详情、审计与操作记录",result:"确认状态、区块和更新时间"},
])}
<p class="muted">Successor 与 Gateway 资源授权当前未开放。区块链交易仍可公开查询。</p></section>
`;}
