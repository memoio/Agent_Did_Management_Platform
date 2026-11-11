import { BrowserProvider, TypedDataEncoder, getAddress } from "ethers";
import {findInjectedWallets,type InjectedProvider,type ProviderAnnouncement,type WalletOption} from "./wallet-discovery.js";
import {invitationAgentSetup} from "./invitation-guide.js";
import {formatBeijingTime} from "./time.js";
import {pairingPresentation} from "./pairing-presentation.js";
import {creationGuideMarkup} from "./creation-guide.js";

declare global {interface Window{ethereum?:InjectedProvider;okxwallet?:InjectedProvider}}
const $=(id:string)=>document.getElementById(id) as HTMLElement;
const value=(id:string)=>($(id) as HTMLInputElement).value.trim();
const checked=(id:string)=>($(id) as HTMLInputElement).checked;
const esc=(v:unknown)=>String(v??"").replace(/[&<>"']/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;","\"":"&quot;","'":"&#39;"}[c]!));
const short=(v:unknown)=>{const s=String(v??"");return s.length>32?`${s.slice(0,20)}…${s.slice(-8)}`:s;};
const scopes=(s:string)=>s.split(",").map(x=>x.trim()).filter(Boolean);
const announcements:ProviderAnnouncement[]=[];
let walletOptions:WalletOption[]=[],injected:InjectedProvider|undefined,provider:BrowserProvider|undefined,address="",token="",dashboard:any,detail:any,offer:any,auditRows:any[]=[];
let accountListener:((value:unknown)=>void)|undefined,chainListener:((value:unknown)=>void)|undefined,walletBusy=false;
let currentView="agents",currentTab="overview",currentFilter="all";
let bindingReviewFingerprint="",bindingBusy=false,bindingResultDid="",bindingStatusIntentId="";

function toast(message:string){const box=$("toast");box.textContent=message;box.classList.add("show");setTimeout(()=>box.classList.remove("show"),7000);}
$("creation-guide").innerHTML=creationGuideMarkup();
async function api(path:string,body?:unknown,auth=false,idem?:string,method?:string){
  const response=await fetch(`/api/v1/${path}`,{method:method??(body===undefined?"GET":"POST"),headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(auth?{authorization:`Bearer ${token}`}:{ }),...(idem?{"idempotency-key":idem}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.code||`HTTP_${response.status}`);return result.data;
}
async function config(){const c=await api("chain/config");if(c.network.chainId!==5611||c.network.caip2!=="eip155:5611"||!c.contracts.didRegistry?.address||!c.contracts.managementRegistry?.address)throw Error("NETWORK_OR_DEPLOYMENT_MISMATCH");return c;}
window.addEventListener("eip6963:announceProvider",(event:Event)=>{
  const detail=(event as CustomEvent<ProviderAnnouncement>).detail;
  if(detail?.provider?.request&&detail.info&&!announcements.some(x=>x.provider===detail.provider))announcements.push(detail);
});
window.dispatchEvent(new Event("eip6963:requestProvider"));

function clearProviderListeners(){
  if(injected&&accountListener)injected.removeListener?.("accountsChanged",accountListener);
  if(injected&&chainListener)injected.removeListener?.("chainChanged",chainListener);
  accountListener=chainListener=undefined;
}
function invalidate(){
  const previousToken=token;
  clearProviderListeners();provider=undefined;injected=undefined;address="";token="";dashboard=undefined;detail=undefined;
  offer=undefined;bindingStatusIntentId="";($("offer-file") as HTMLInputElement).value="";$("offer-preview").textContent="尚未选择文件";
  resetBindingReview();updateBindingAvailability();$("binding-result").classList.add("hidden");
  if(previousToken)void fetch("/api/v1/wallet-session",{method:"DELETE",headers:{authorization:`Bearer ${previousToken}`}}).catch(()=>{});
  $("app-screen").classList.add("hidden");$("login-screen").classList.remove("hidden");
  $("wallet-status").textContent="钱包账户或网络已变更，请重新登录";
}
function walletChoices(){
  const list=$("provider-list");
  list.innerHTML=`<p>检测到多个钱包，请选择用于登录的插件：</p><div class="wallet-options">${walletOptions.map((wallet,index)=>`<button type="button" class="secondary" data-wallet-index="${index}">${esc(wallet.name)}</button>`).join("")}</div>`;
}
async function discoverAndConnect(){
  if(walletBusy)return;
  walletBusy=true;($("connect-wallet") as HTMLButtonElement).disabled=true;
  $("wallet-status").textContent="正在检测钱包插件…";
  try{
    window.dispatchEvent(new Event("eip6963:requestProvider"));
    await new Promise(resolve=>setTimeout(resolve,350));
    walletOptions=findInjectedWallets(announcements,{ethereum:window.ethereum,okxwallet:window.okxwallet});
    if(walletOptions.length===1){$("provider-list").innerHTML="";await connectInjected(walletOptions[0]);return;}
    if(walletOptions.length>1){walletChoices();$("wallet-status").textContent=`检测到 ${walletOptions.length} 个钱包插件`;return;}
    $("provider-list").innerHTML='<p class="muted">未检测到 MetaMask、OKX Wallet 或 Rabby。请在当前浏览器中安装并启用其中一个钱包插件。</p>';
    $("wallet-status").textContent="未检测到支持的钱包插件";
  }finally{walletBusy=false;($("connect-wallet") as HTMLButtonElement).disabled=false;}
}
async function connectInjected(selected:WalletOption){
  if(token)return;
  injected=selected.provider;
  $("wallet-status").textContent=`正在连接 ${selected.name}…`;
  try{
  const c=await config();let requested:unknown;
  try{requested=await injected.request({method:"eth_requestAccounts"});}catch{throw Error("钱包账户授权失败，请允许本站访问当前账户");}
  if(!Array.isArray(requested)||typeof requested[0]!=="string")throw Error("钱包没有返回已授权账户");
  const account=getAddress(requested[0]);
  const currentChain=await injected.request({method:"eth_chainId"}).catch(()=>null);
  if(String(currentChain).toLowerCase()!=="0x15eb"){
    try{await injected.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x15eb"}]});}
    catch(error){if((error as {code?:number}).code!==4902)throw Error("请将钱包切换到 opBNB Testnet (5611)");await injected.request({method:"wallet_addEthereumChain",params:[{chainId:"0x15eb",chainName:c.network.name,rpcUrls:[c.network.publicRpcUrl],blockExplorerUrls:[c.network.explorerUrl],nativeCurrency:c.network.nativeCurrency}]});}
  }
  const p=new BrowserProvider(injected as never);if((await p.getNetwork()).chainId!==5611n)throw Error("钱包网络不是 opBNB Testnet");
  const signer=await p.getSigner(account),challenge=await api("wallet-login-intents",{address:account});
  let signature:string;try{signature=await signer.signMessage(challenge.message);}catch{throw Error("钱包登录签名被拒绝或站点未获授权");}
  const session=await api("wallet-sessions",{challengeId:challenge.challengeId,signature});
  provider=p;address=account;token=session.token;$("wallet-status").textContent=account;$("wallet-account").textContent=account;
  accountListener=()=>invalidate();chainListener=()=>invalidate();
  injected.on?.("accountsChanged",accountListener);injected.on?.("chainChanged",chainListener);
  $("login-screen").classList.add("hidden");$("app-screen").classList.remove("hidden");
  await refresh();switchView("agents");
  }finally{if(!token){clearProviderListeners();injected=undefined;provider=undefined;$("wallet-status").textContent="登录未完成，请重试";}}
}
async function connectChoice(index:number){
  if(walletBusy)return;
  const selected=walletOptions[index];if(!selected)throw Error("请重新检测钱包插件");
  walletBusy=true;
  try{await connectInjected(selected);}finally{walletBusy=false;}
}
function switchView(view:string){currentView=view;document.querySelectorAll<HTMLElement>(".view").forEach(x=>x.classList.toggle("hidden",x.id!==`view-${view}`));document.querySelectorAll<HTMLElement>("[data-view]").forEach(x=>x.classList.toggle("active",x.dataset.view===view));if(view==="audit")void loadAudit();if(view==="chain")void loadChain();if(view==="create")renderPairingExchanges();}
function chip(label:string,kind=""){return `<span class="chip ${kind}">${esc(label)}</span>`;}
function table(head:string[],rows:string[]){return `<div class="table-wrap"><table><thead><tr>${head.map(h=>`<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${rows.join("")||`<tr><td colspan="${head.length}">暂无记录</td></tr>`}</tbody></table></div>`;}
async function refresh(){
  if(!token)return;
  dashboard=await api("dashboard",undefined,true);
  renderAgents();renderAlerts();renderPairingExchanges();
  $("chain-status").textContent=`${dashboard.counts?.managed??0} 个管理中 · opBNB 5611`;
  if(detail)await openAgent(detail.identity.agentDid);
}
function renderPairingExchanges(){
  const items:any[]=dashboard?.pairingExchanges??[];
  $("pairing-exchanges").innerHTML=`<div class="pairing-history"><div class="pairing-history-heading"><h2>最近配对</h2><p>这里展示文件是否完成配对，以及管理关系是否已在链上确认。</p></div>${items.length?`<div class="pairing-history-grid" role="list">${items.map(x=>{
    const state=pairingPresentation(x),paired=x.state==="PAIRED";
    const kind=x.kind==="platform-invitation"?"新 Agent · Invitation":"现有 Agent · Offer";
    const accessible=paired&&x.agent_did&&dashboard.agents?.some((agent:any)=>agent.identity?.agentDid===x.agent_did);
    const scopes=Array.isArray(x.requested_scopes)?x.requested_scopes.join(", "):"";
    const days=Number(x.requested_term_seconds)/86400;
    const tx=typeof x.operation_tx_hash==="string"&&/^0x[0-9a-fA-F]{64}$/.test(x.operation_tx_hash)?x.operation_tx_hash:"";
    return `<article class="card pairing-card ${esc(state.tone)}" role="listitem"><div class="pairing-card-head"><div><p class="eyebrow">${esc(kind)}</p><h3>${esc(state.label)}</h3></div>${chip(paired?"已配对":"未配对",paired?"good":"warn")}</div><p>${esc(state.description)}</p><dl class="pairing-card-meta"><dt>交换 ID</dt><dd class="code">${esc(x.id)}</dd>${x.agent_did?`<dt>Agent DID</dt><dd class="code">${esc(x.agent_did)}</dd>`:""}${paired&&x.manager_address?`<dt>Manager</dt><dd class="code">${esc(x.manager_address)}</dd>`:""}${paired&&scopes?`<dt>权限</dt><dd>${esc(scopes)}</dd>`:""}${paired&&Number.isFinite(days)&&days>0?`<dt>管理期限</dt><dd>${esc(days)} 天</dd>`:""}<dt>${esc(state.timeLabel)}</dt><dd>${esc(formatBeijingTime(state.time))}</dd>${paired?`<dt>链上状态</dt><dd>${esc(x.operation_state??"尚未提交")}</dd>`:""}</dl>${paired&&(accessible||tx)?`<div class="pairing-card-actions">${accessible?`<button data-open-agent="${esc(x.agent_did)}">查看 Agent 与管理关系</button>`:""}${tx?`<a class="guide-link" href="https://opbnb-testnet.bscscan.com/tx/${esc(tx)}" target="_blank" rel="noopener noreferrer">查看链上交易 ↗</a>`:""}</div>`:""}</article>`;
  }).join("")}</div>`:`<article class="card"><p>暂无配对记录。请从上方选择一种方式开始。</p></article>`}</div>`;
}
function renderAgents(){const agents=(dashboard?.agents||[]).filter((x:any)=>currentFilter==="all"||currentFilter==="managed"&&x.management?.live||currentFilter==="unmanaged"&&!x.management?.live||currentFilter==="pending"&&x.managementDraft&&!["CONFIRMED","REJECTED"].includes(x.managementDraft.state));$("agent-list").innerHTML=table(["Agent","DID","身份","管理","来源","操作"],agents.map((x:any)=>`<tr><td>${esc(x.profile?.name||"未命名 Agent")}</td><td class="code">${esc(short(x.identity.agentDid))}</td><td>${chip(x.identity.state,x.identity.state==="ACTIVE"?"good":"warn")}</td><td>${chip(x.management?.live?"管理中":"未管理",x.management?.live?"good":"warn")}</td><td>${esc(x.associationSource)}</td><td><button data-open-agent="${esc(x.identity.agentDid)}">查看详情</button></td></tr>`));}
async function openAgent(did:string){detail=await api(`dashboard/agents/${encodeURIComponent(did)}`,undefined,true);$("agent-list").classList.add("hidden");$("agent-detail").classList.remove("hidden");$("detail-title").textContent=detail.profile?.name||"未命名 Agent";$("detail-did").textContent=did;renderDetail();}
function renderDetail(){if(!detail)return;const d=detail;document.querySelectorAll<HTMLElement>("[data-tab]").forEach(x=>x.classList.toggle("active",x.dataset.tab===currentTab));let html="";
  if(currentTab==="overview")html=`<div class="grid two"><article class="card"><h2>身份状态</h2><p>${chip(d.identity.state,d.identity.state==="ACTIVE"?"good":"warn")}</p><p>DID：<span class="code">${esc(d.identity.agentDid)}</span></p><p>Revision：${esc(d.identity.identityRevision)}</p><p>Profile Hash：<span class="code">${esc(d.identity.profileHash)}</span></p></article><article class="card"><h2>管理关系</h2><p>${chip(d.management?.live?"管理中":"未管理",d.management?.live?"good":"warn")}</p><p>Manager：<span class="code">${esc(d.management?.manager)}</span></p><p>到期时间：${esc(formatBeijingTime(d.management?.expiresAt))}</p><p>来源：${esc(d.associationSource)}</p></article></div>${d.managementDraft?`<article class="card"><h2>管理草稿</h2><p>${chip(d.managementDraft.state)}</p><p>权限：${esc((d.managementDraft.scopes||[]).join(", "))}</p><p>草稿有效期：${esc(formatBeijingTime(d.managementDraft.expires_at))}</p>${d.managementDraft.intent_expires_at?`<p>签名意图有效期：${esc(formatBeijingTime(d.managementDraft.intent_expires_at))}</p>`:""}${d.managementDraft.state==="AWAITING_WALLET_SIGNATURE"?`<button data-sign-draft="${esc(d.managementDraft.id)}">钱包签署草稿</button>`:d.managementDraft.state==="WAITING_AGENT"&&d.managementDraft.intent_expires_at&&new Date(d.managementDraft.intent_expires_at).getTime()<Date.now()?`<p>旧签名意图已过期，需要钱包重新签署。</p><button data-sign-draft="${esc(d.managementDraft.id)}">更新并签署草稿</button>`:""}</article>`:""}<article class="card"><h2>管理关系操作</h2><p>续期和转移需要 Agent 及相关 Manager 签署同一意图；结束关系由 Agent 或当前 Manager 签署。</p><label>新权限范围<input id="action-scopes" value="agent.read"></label><label>新期限（天）<input id="action-days" type="number" value="30"></label><label>新 Manager（仅转移）<input id="new-manager" placeholder="0x..."></label><button data-manage="RenewRelationship">续期</button><button data-manage="TransferRelationship">转移</button><button data-manage="EndRelationship" class="danger">结束关系</button><label>管理意图 ID<input id="action-intent-id"></label><button id="sign-action-intent">当前钱包签署意图</button><button id="submit-action-intent">所有签名齐全后提交</button></article>`;
  if(currentTab==="overview"&&d.managementDraft?.state==="FROZEN_REORG")html+=`<article class="card"><h2>注册或管理交易遇到重组</h2><p>平台已冻结旧草稿。请核实链状态后重新创建签名意图。</p><button data-retry-draft="${esc(d.managementDraft.id)}">核实并重试草稿</button></article>`;
  if(currentTab==="instances")html=`<article class="card"><h2>运行实例与凭证</h2><p>Instance Key 由 Agent 本地 Skill 创建；这里显示经过 Identity Key 签名的公开元数据。</p><pre>memo-agent-opbnb-testnet instance create worker-01 1\nmemo-agent-opbnb-testnet instance list\nmemo-agent-opbnb-testnet instance revoke &lt;instanceId&gt;</pre>${table(["实例","状态","到期时间","公钥"],(d.instances||[]).map((x:any)=>`<tr><td>${esc(x.name)}</td><td>${chip(x.state)}</td><td>${esc(formatBeijingTime(x.expires_at))}</td><td class="code">${esc(short(x.public_key))}</td></tr>`))}</article>`;
  if(currentTab==="lifecycle")html=`<article class="card"><h2>身份生命周期</h2><p>当前状态：${chip(d.identity.state)}</p><p>Identity Key 留在本地 Agent Skill；以下动作由 Agent 明确确认并签名。</p><pre>memo-agent-opbnb-testnet identity suspend\nmemo-agent-opbnb-testnet identity resume\nmemo-agent-opbnb-testnet identity revoke</pre><p>永久吊销不可恢复。Successor 当前未开放。</p></article>`;
  if(currentTab==="profile")html=`<div class="grid two"><article class="card"><h2>Profile</h2><pre>${esc(JSON.stringify(d.profile,null,2))}</pre><p class="code">${esc(d.identity.profileHash)}</p></article><article class="card"><h2>DID 文档</h2><pre>${esc(JSON.stringify(d.document,null,2))}</pre><p class="code">${esc(d.identity.documentHash)}</p></article></div><article class="card"><h2>版本历史</h2>${table(["确认时间","Profile Hash","Document Hash"],(d.profileHistory||[]).map((x:any)=>`<tr><td>${esc(formatBeijingTime(x.confirmedAt))}</td><td class="code">${esc(short(x.profileHash))}</td><td class="code">${esc(short(x.documentHash))}</td></tr>`))}<pre>memo-agent-opbnb-testnet identity update-profile profile.json\nmemo-agent-opbnb-testnet identity update-document document.json</pre></article>`;
  if(currentTab==="logs")html=`<article class="card"><h2>链上操作</h2>${table(["动作","状态","交易","更新时间","最终性"],(d.operations||[]).map((x:any)=>`<tr><td>${esc(x.action_type)}</td><td>${chip(x.state,x.state==="CONFIRMED"?"good":"warn")}</td><td class="code">${esc(short(x.tx_hash))}</td><td>${esc(formatBeijingTime(x.updated_at))}</td><td>${esc(x.finality_source)}</td></tr>`))}</article><article class="card"><h2>链事件</h2>${table(["区块","区块时间","交易","事件"],(d.events||[]).map((x:any)=>`<tr><td>${esc(x.block_number)}</td><td>${esc(formatBeijingTime(x.event?.blockTimestamp))}</td><td class="code">${esc(short(x.tx_hash))}</td><td>${esc(x.event?.eventName||x.event?.name||"链事件")}</td></tr>`))}</article>`;
  $("detail-content").innerHTML=html;
}
function renderAlerts(){const alerts:string[]=[];for(const a of dashboard?.agents||[]){if(a.identity.state!=="ACTIVE")alerts.push(`${a.identity.agentDid} 身份状态：${a.identity.state}`);if(a.managementDraft&&!["CONFIRMED","REJECTED"].includes(a.managementDraft.state))alerts.push(`${a.identity.agentDid} 管理草稿待处理：${a.managementDraft.state}`);for(const x of a.instances||[])if(x.state==="ACTIVE"&&new Date(x.expires_at).getTime()<Date.now()+86400_000)alerts.push(`${a.identity.agentDid} 实例 ${x.name} 将于 ${formatBeijingTime(x.expires_at)} 到期`);}$("alerts-list").innerHTML=alerts.length?alerts.map(x=>`<article class="card">${esc(x)}</article>`).join(""):'<article class="card">当前没有告警</article>';}
async function loadAudit(){auditRows=await api("audit-events",undefined,true);$("audit-list").innerHTML=table(["序号","时间（东八区）","事件","主体","详情"],auditRows.map(x=>`<tr><td>${esc(x.id)}</td><td>${esc(formatBeijingTime(x.created_at))}</td><td>${esc(x.event_type)}</td><td class="code">${esc(short(x.actor))}</td><td class="code">${esc(JSON.stringify(x.detail))}</td></tr>`));}
async function loadChain(){const [c,b]=await Promise.all([config(),api("chain/blocks/latest")]);$("chain-content").innerHTML=`<div class="grid three"><article class="card"><h2>网络</h2><p>${esc(c.network.name)} · ${esc(c.network.caip2)}</p><p>最新区块：${esc(b.blockNumber)}</p><p>区块时间：${esc(formatBeijingTime(b.timestamp))}</p><p class="code">${esc(b.blockHash)}</p></article><article class="card"><h2>DID Registry</h2><p class="code">${esc(c.contracts.didRegistry.address)}</p></article><article class="card"><h2>Management Registry</h2><p class="code">${esc(c.contracts.managementRegistry.address)}</p></article></div><article class="card"><h2>最终性与交易</h2><p>${esc(c.finality.mode||"finalized-tag")} · direct-relayer</p><p>操作按 CREATED → SIGNED → SUBMITTED → INCLUDED → CONFIRMED 跟踪。只有达到最终性才显示已确认。</p></article>`;}
async function verifyAndSign(intent:any){const c=await config();const key="identityAccount" in intent.message?"didRegistry":"managementRegistry";if(intent.domain.chainId!==5611||getAddress(intent.domain.verifyingContract)!==getAddress(c.contracts[key].address)||TypedDataEncoder.hash(intent.domain,intent.types,intent.message)!==intent.digest)throw Error("INTENT_DOMAIN_OR_DIGEST_MISMATCH");if(!provider)throw Error("请先连接钱包");if((await provider.getNetwork()).chainId!==5611n)throw Error("钱包网络已变更");const signer=await provider.getSigner(address),role=intent.requiredSigners.find((x:any)=>getAddress(x.address)===address&&x.role!=="agent")?.role??intent.requiredSigners.find((x:any)=>getAddress(x.address)===address)?.role;if(!role)throw Error("当前钱包不是所需签署人");const signature=await signer.signTypedData(intent.domain,intent.types,intent.message);await api(`management-intents/${encodeURIComponent(intent.intentId)}/signatures`,{role,address,signature},true);return signature;}
type BindingTerms={source:"offer"|"did";agentDid:string;scopes:string[];termSeconds:number;discoverable:boolean;exchangeId?:string};
function bindingSource():"invitation"|"offer"|"did"{return (document.querySelector('input[name="binding-source"]:checked') as HTMLInputElement).value as "invitation"|"offer"|"did";}
function bindingTerms():BindingTerms{
  const source=bindingSource();
  if(source==="invitation")throw Error("请先选择现有 Agent 的绑定方式");
  const agentDid=source==="offer"?offer?.agentDid:value("binding-did");
  if(source==="offer"&&!offer)throw Error("请先导入并校验 Agent Offer");
  if(source==="offer"&&Date.parse(offer.expiresAt)<=Date.now())throw Error("Agent Offer 已过期，请导入新文件");
  if(typeof agentDid!=="string"||!/^did:memo:agent:5611:0x[0-9a-fA-F]{40}$/.test(agentDid))throw Error("请填写有效的 opBNB Agent DID");
  const selectedScopes=scopes(value("binding-scopes")),days=Number(value("binding-days"));
  if(!selectedScopes.length||!Number.isSafeInteger(days)||days<1||days>365)throw Error("请填写有效的权限和期限");
  if(source==="offer"&&(selectedScopes.some(s=>!offer.maxScopes.includes(s))||days*86400>offer.maxTermSeconds))throw Error("申请条款超过 Agent Offer 的上限");
  return {source,agentDid,scopes:selectedScopes,termSeconds:days*86400,discoverable:false,...(source==="offer"?{exchangeId:offer.exchangeId}:{})};
}
function resetBindingReview(){bindingReviewFingerprint="";$("binding-review").classList.add("hidden");}
function updateBindingAvailability(){
  const source=bindingSource();
  if(source==="invitation"){($("review-binding") as HTMLButtonElement).disabled=true;return;}
  const ready=source==="offer"?Boolean(offer)&&Date.parse(offer.expiresAt)>Date.now():/^did:memo:agent:5611:0x[0-9a-fA-F]{40}$/.test(value("binding-did"));
  ($("review-binding") as HTMLButtonElement).disabled=!ready;
  $("binding-next-hint").textContent=source==="offer"
    ? ready?"Offer 已校验，可以继续核对管理条款。":offer?"Offer 已过期，请导入新文件。":"请先导入并校验 Agent Offer。"
    : ready?"DID 格式有效，可以继续核对管理条款。":"请输入完整的 opBNB Agent DID。";
}
function showBindingSource(){
  const source=bindingSource();
  $("binding-invitation-workspace").classList.toggle("hidden",source!=="invitation");
  $("binding-existing-workspace").classList.toggle("hidden",source==="invitation");
  $("binding-offer-source").classList.toggle("hidden",source!=="offer");
  $("binding-did-source").classList.toggle("hidden",source!=="did");
  resetBindingReview();
  $("binding-result").classList.add("hidden");
  if(source==="offer"&&offer){
    ($("binding-scopes") as HTMLInputElement).value=offer.maxScopes.join(",");
    ($("binding-days") as HTMLInputElement).value=String(Math.floor(offer.maxTermSeconds/86400));
  }
  updateBindingAvailability();
}
function reviewBinding(){
  const terms=bindingTerms();bindingReviewFingerprint=JSON.stringify({address,terms});
  $("binding-review-text").textContent=`来源: ${terms.source==="offer"?"Agent Offer":"已知 DID"}\nAgent DID: ${terms.agentDid}\nManager: ${address}\n权限: ${terms.scopes.join(", ")}\n期限: ${terms.termSeconds/86400} 天`;
  $("binding-review").classList.remove("hidden");
  $("binding-review").scrollIntoView({behavior:"smooth",block:"nearest"});
}
function bindingResult(html:string){$("binding-result").innerHTML=html;$("binding-result").classList.remove("hidden");}
function agentBindingHelp(requestId:string,terms:BindingTerms){
  const prompt=`请使用 $memo-agent-did-opbnb-testnet 审核 opBNB 5611 上 Agent DID ${terms.agentDid} 的管理请求。请求 ID：${requestId}。先运行 binding pending，再运行 binding inspect ${requestId}，向我报告 Manager 地址、权限、期限、digest 和签名截止时间；请与钱包页面的 Manager ${address}、权限 ${terms.scopes.join(", ")}、期限 ${terms.termSeconds/86400} 天逐项核对。现在先不要批准或签名。待我确认后，再运行 binding approve ${requestId}，返回 operationId 和状态；不要输出私钥或签名原文。`;
  return `<section class="binding-agent-help"><h4>下一步：把请求 ID 交给 Agent</h4><p>将下方提示词发给运行此 DID 的 Agent。Agent 先检查并回报，你确认内容一致后，再请它批准。请求 ID 是平台记录的编号，无需传 Offer 凭据、私钥或签名。</p><textarea id="binding-agent-prompt" rows="6" readonly>${esc(prompt)}</textarea><button id="copy-binding-prompt" class="secondary">复制给 Agent 的提示词</button></section>`;
}
async function checkBindingStatus(){
  if(!bindingStatusIntentId)throw Error("请先完成钱包签名");
  const output=$("binding-operation-status");output.textContent="正在查询操作进度…";
  try{
    const [operation,details]=await Promise.all([
      api(`management-intents/${encodeURIComponent(bindingStatusIntentId)}/operation`,undefined,true),
      api(`management-intents/${encodeURIComponent(bindingStatusIntentId)}`,undefined,true),
    ]);
    const deadline=Number(details.intent?.message?.deadline);
    const expired=Number.isFinite(deadline)&&deadline*1000<=Date.now();
    const nextStep=operation.state==="FAILED"
      ?`\n绑定失败，当前意图和交易不能重试。${operation.errorCode==="ACTION_EXPIRED"?"交易到达区块时签名已过期。":"请核对失败原因。"}请返回“绑定现有 Agent”，用同一 DID 重新创建管理意图；钱包签名后把新的请求 ID 交给 Agent 审核，并在截止时间前至少 2 分钟完成批准。`
      :operation.state==="CREATED"&&expired
        ?"\n此意图已过期，不能再请 Agent 签名；请重新创建管理意图。"
        :operation.state==="SIGNED"
          ?"\n双方已签名，平台正在提交；请稍后再查询进度。"
          :operation.state==="SUBMITTED"||operation.state==="INCLUDED"
            ?"\n交易正在链上确认，请稍后再查询进度。"
            :"";
    output.textContent=`操作 ID: ${operation.operationId}\n状态: ${operation.state}\n交易: ${operation.txHash||"等待提交"}\n区块: ${operation.blockNumber||"等待上链"}\n签名截止: ${formatBeijingTime(deadline)}\n更新时间: ${formatBeijingTime(operation.updatedAt)}\n最终性: ${operation.finalitySource||"等待确认"}${operation.errorCode?`\n错误: ${operation.errorCode}`:""}${nextStep}`;
    if(operation.state==="CONFIRMED")try{await refresh();}catch{toast("操作已确认，但列表刷新失败，请稍后点击刷新");}
  }catch(error){output.textContent=`进度查询失败：${error instanceof Error?error.message:"请稍后重试"}`;}
}
async function checkBindingRelationship(){
  const output=$("binding-relationship-status");output.textContent="正在查询链上关系…";
  try{
    if(!bindingResultDid||!bindingStatusIntentId)throw Error("请先完成钱包签名");
    const operation=await api(`management-intents/${encodeURIComponent(bindingStatusIntentId)}/operation`,undefined,true);
    if(operation.state!=="CONFIRMED"){
      const details=await api(`management-intents/${encodeURIComponent(bindingStatusIntentId)}`,undefined,true);
      const deadline=Number(details.intent?.message?.deadline),expired=Number.isFinite(deadline)&&deadline*1000<=Date.now();
      output.textContent=operation.state==="FAILED"
        ?`当前操作状态：FAILED${operation.errorCode?`（${operation.errorCode}）`:""}。链上关系未建立。此操作不能再提交；请返回“绑定现有 Agent”，重新创建意图并完成钱包和 Agent 两方签名。`
        :expired&&operation.state==="CREATED"
          ?`当前操作状态：${operation.state}。此意图已于 ${formatBeijingTime(deadline)} 过期，链上关系尚未生效。请重新创建管理意图，不要再使用旧 ID。`
          :operation.state==="SIGNED"
            ?"双方已签名，正在等待平台提交；此时链上关系尚未生效。请点击“查询绑定进度”。"
            :operation.state==="SUBMITTED"||operation.state==="INCLUDED"
              ?"交易正在确认，链上关系尚未最终生效。请点击“查询绑定进度”，确认后再次查询关系。"
              :`当前操作状态：${operation.state}。管理关系尚未在链上确认；请先让 Agent 审核并批准，再用“查询绑定进度”跟踪交易。`;
      return;
    }
    const relationship=await api(`management/${encodeURIComponent(bindingResultDid)}`);
    output.textContent=`链上关系：${relationship.live?"管理中":"未生效"}\nAgent DID：${relationship.agentDid}\nManager：${relationship.manager}\n到期时间：${formatBeijingTime(relationship.expiresAt)}\n来源区块：${relationship.source?.blockNumber??"—"}\n区块哈希：${relationship.source?.blockHash??"—"}`;
  }catch(error){output.textContent=`链上关系查询失败：${error instanceof Error?error.message:"请稍后重试"}`;}
}
async function createDirect(terms:BindingTerms){const intent=await api("management-intents",{agentDid:terms.agentDid,scopes:terms.scopes,termSeconds:terms.termSeconds,discoverable:terms.discoverable},true);await verifyAndSign(intent);toast(`管理意图 ${intent.intentId} 已由钱包签署；等待 Agent 审核`);return intent;}
async function confirmBinding(){
  if(bindingBusy)return;
  const terms=bindingTerms();
  if(!bindingReviewFingerprint||JSON.stringify({address,terms})!==bindingReviewFingerprint)throw Error("绑定信息已变化，请重新核对");
  bindingBusy=true;($("confirm-binding") as HTMLButtonElement).disabled=true;
  try{
    bindingResultDid=terms.agentDid;
    if(terms.source==="offer"){
      const paired=await redeemOffer(terms);
      bindingResult(`<h3>Offer 已兑换</h3><p>草稿 ID：<span class="code">${esc(paired.draftId)}</span></p><p>请在钱包完成签名；如签名中断，可从“我的 Agent”继续。</p>`);
      const intentId=await signDraft(paired.draftId);
      bindingStatusIntentId=intentId;
      bindingResult(`<h3>等待 Agent 审核</h3><p>Agent DID：<span class="code">${esc(terms.agentDid)}</span></p><p>草稿 ID（Agent 请求 ID）：<span class="code">${esc(paired.draftId)}</span></p><p>意图 ID：<span class="code">${esc(intentId)}</span></p>${agentBindingHelp(paired.draftId,terms)}<div class="binding-result-actions"><button id="check-binding-status" class="secondary">查询绑定进度</button><button id="check-relationship" class="secondary">查询链上关系</button></div><pre id="binding-operation-status" aria-live="polite"></pre><pre id="binding-relationship-status" aria-live="polite"></pre>`);
    }else{
      const intent=await createDirect(terms);
      bindingStatusIntentId=intent.intentId;
      bindingResult(`<h3>等待 Agent 审核</h3><p>Agent DID：<span class="code">${esc(terms.agentDid)}</span></p><label>意图 ID（Agent 请求 ID）<input id="intent-id" value="${esc(intent.intentId)}" readonly></label><p>签名截止时间：${esc(formatBeijingTime(intent.message.deadline))}</p>${agentBindingHelp(intent.intentId,terms)}<div class="binding-result-actions"><button id="check-binding-status" class="secondary">查询绑定进度</button><button id="check-relationship" class="secondary">查询链上关系</button></div><pre id="binding-operation-status" aria-live="polite"></pre><pre id="binding-relationship-status" aria-live="polite"></pre>`);
    }
    resetBindingReview();
  }finally{bindingBusy=false;($("confirm-binding") as HTMLButtonElement).disabled=false;}
}
async function submitIntent(id:string){
  const result=await api("management-actions",{intentId:id},true,id);
  toast(`操作 ${result.operationId} 已接收，状态 ${result.state}`);
  try{await refresh();}catch{toast("操作已接收，但列表刷新失败，请查询绑定进度");}
  return result;
}
async function copyBindingPrompt(){
  const field=$("binding-agent-prompt") as HTMLTextAreaElement;
  try{await navigator.clipboard.writeText(field.value);toast("已复制给 Agent 的提示词");}
  catch{field.focus();field.select();toast("复制失败，已选中文本，请手动复制");}
}
async function createInvitation(){
  const c=await config(),bytes=crypto.getRandomValues(new Uint8Array(32));
  const handle=Array.from(bytes,b=>b.toString(16).padStart(2,"0")).join("");
  const hash=Array.from(new Uint8Array(await crypto.subtle.digest("SHA-256",new TextEncoder().encode(handle))),b=>b.toString(16).padStart(2,"0")).join("");
  const maxScopes=scopes(value("invite-scopes")),maxTermSeconds=Number(value("invite-days"))*86400,ttlSeconds=Number(value("invite-ttl"))*60,discoverable=false;
  const x=await api("pairing-invitations",{handleHash:hash,maxScopes,maxTermSeconds,ttlSeconds,discoverable},true,crypto.randomUUID());
  const file={schema:"memo.agent-pairing-package/2",kind:"platform-invitation",exchangeId:x.exchangeId,handle,platformOrigin:location.origin,chainId:5611,didRegistry:c.contracts.didRegistry.address,managementRegistry:c.contracts.managementRegistry.address,maxScopes,maxTermSeconds,discoverable,expiresAt:x.expiresAt,agentSetup:invitationAgentSetup(location.origin,c.contracts.didRegistry.address,c.contracts.managementRegistry.address)};
  download(`manager-${x.exchangeId}.memo-invitation.json`,JSON.stringify(file,null,2));
  $("invitation-result").innerHTML=`<h3>Invitation 已生成并下载</h3><p>请保存下载文件并安全交给新 Agent。Agent 接受并完成 DID 注册后，在“我的 Agent”签署管理草稿。</p><dl class="pairing-card-meta"><dt>交换 ID</dt><dd class="code">${esc(x.exchangeId)}</dd><dt>有效期至</dt><dd>${esc(formatBeijingTime(x.expiresAt))}</dd></dl><ol><li>Agent 按文件中的安装指引运行测试链 Skill。</li><li>Agent 注册 DID 并接受 Invitation。</li><li>你在“我的 Agent”签署草稿，Agent 再批准，等待链上确认。</li></ol><button data-view="agents" class="secondary">前往“我的 Agent”</button>`;
  $("invitation-result").classList.remove("hidden");
  toast("Invitation 已下载，内含 Agent 安装与绑定步骤；请安全交给 Agent");
  await refresh();
}
function download(name:string,content:string,type="application/json"){const blob=new Blob([content],{type}),url=URL.createObjectURL(blob),a=document.createElement("a");a.href=url;a.download=name;a.click();setTimeout(()=>URL.revokeObjectURL(url),1000);}
async function loadOffer(file:File){
  if(file.size>65536)throw Error("Offer 文件过大");
  const parsed=JSON.parse(await file.text());
  if(parsed.schema!=="memo.agent-pairing-package/2"||parsed.kind!=="agent-offer"||parsed.chainId!==5611||parsed.discoverable!==false)throw Error("Offer 文件格式或测试链编号不正确");
  if(parsed.platformOrigin!==location.origin)throw Error("Offer 的平台地址与当前页面不一致，请使用文件指定的平台地址打开 Console");
  if(!Number.isFinite(Date.parse(parsed.expiresAt))||Date.parse(parsed.expiresAt)<=Date.now())throw Error("Offer 已过期，请让 Agent 重新生成");
  const c=await config();
  if(getAddress(parsed.didRegistry)!==getAddress(c.contracts.didRegistry.address)||getAddress(parsed.managementRegistry)!==getAddress(c.contracts.managementRegistry.address))throw Error("Offer 的合约地址与当前平台不一致");
  const x=await api("pairing-offers/inspect",{exchangeId:parsed.exchangeId,handle:parsed.handle},true);
  if(x.agentDid!==parsed.agentDid||JSON.stringify(x.maxScopes)!==JSON.stringify(parsed.maxScopes)||Number(x.maxTermSeconds)!==Number(parsed.maxTermSeconds)||x.discoverable!==false)throw Error("Offer 内容与平台记录不匹配");
  if(file!==($("offer-file") as HTMLInputElement).files?.[0])return;
  offer=parsed;resetBindingReview();updateBindingAvailability();
  $("offer-preview").textContent=`Agent: ${parsed.agentDid}\n权限上限: ${parsed.maxScopes.join(", ")}\n期限上限: ${Math.floor(parsed.maxTermSeconds/86400)} 天\n有效期: ${formatBeijingTime(parsed.expiresAt)}`;
  if(bindingSource()==="offer"){
    ($("binding-scopes") as HTMLInputElement).value=parsed.maxScopes.join(",");
    ($("binding-days") as HTMLInputElement).value=String(Math.floor(parsed.maxTermSeconds/86400));
  }
}
async function redeemOffer(terms:BindingTerms){
  if(!offer||offer.exchangeId!==terms.exchangeId)throw Error("请重新导入并校验 Offer 文件");
  const x=await api(`pairing-offers/${encodeURIComponent(offer.exchangeId)}/redeem`,{handle:offer.handle,requestedScopes:terms.scopes,requestedTermSeconds:terms.termSeconds,discoverable:terms.discoverable},true,crypto.randomUUID());
  offer=undefined;($("offer-file") as HTMLInputElement).value="";$("offer-preview").textContent="Offer 已兑换";updateBindingAvailability();
  await refresh();return x;
}
async function signDraft(id:string){
  const response=await api(`management-drafts/${encodeURIComponent(id)}/intent`,{},true),intent=response.intent;
  const signature=await verifyAndSign(intent);
  await api(`management-drafts/${encodeURIComponent(id)}/wallet-signature`,{intentId:intent.intentId,managerSignature:signature},true);
  toast("钱包已签署草稿，等待 Agent 在 Skill 中审批");await refresh();return intent.intentId as string;
}
async function createManagementAction(actionType:string){if(!detail)throw Error("请先选择 Agent");if(actionType==="EndRelationship"&&!await confirmAction("结束管理关系","该操作将在链上结束当前关系。"))return;const body:any={actionType,agentDid:detail.identity.agentDid};if(actionType!=="EndRelationship"){body.scopes=scopes(value("action-scopes"));body.termSeconds=Number(value("action-days"))*86400;body.discoverable=false;if(actionType==="TransferRelationship")body.newManager=value("new-manager");}const intent=await api("management-action-intents",body,true);await verifyAndSign(intent);($("action-intent-id") as HTMLInputElement).value=intent.intentId;toast(`意图 ${intent.intentId} 已签名，请其他签署人审核`);}
async function confirmAction(title:string,content:string){const dialog=$("confirm-dialog") as HTMLDialogElement;$("confirm-title").textContent=title;$("confirm-text").textContent=content;dialog.showModal();return new Promise<boolean>(resolve=>dialog.addEventListener("close",()=>resolve(dialog.returnValue==="confirm"),{once:true}));}
function exportAudit(kind:"json"|"csv"){const clean=auditRows.map(x=>({id:x.id,time:formatBeijingTime(x.created_at),timeIso:x.created_at,event:x.event_type,actor:x.actor,detail:x.detail}));if(kind==="json")download("memo-agent-audit.json",JSON.stringify(clean,null,2));else{const rows=[["id","time_beijing","time_iso","event","actor","detail"],...clean.map(x=>[x.id,x.time,x.timeIso,x.event,x.actor,JSON.stringify(x.detail)])];download("memo-agent-audit.csv",rows.map(r=>r.map(v=>`"${String(v??"").replaceAll('"','""')}"`).join(",")).join("\n"),"text/csv");}}

document.addEventListener("click",e=>{const b=(e.target as HTMLElement).closest("button");if(!b)return;const run=async()=>{if(b.dataset.view)return switchView(b.dataset.view);if(b.dataset.filter){currentFilter=b.dataset.filter;document.querySelectorAll<HTMLElement>("[data-filter]").forEach(x=>x.classList.toggle("active",x.dataset.filter===currentFilter));return renderAgents();}if(b.dataset.openAgent){switchView("agents");return openAgent(b.dataset.openAgent);}if(b.dataset.tab){currentTab=b.dataset.tab;return renderDetail();}if(b.dataset.walletIndex!==undefined)return connectChoice(Number(b.dataset.walletIndex));if(b.dataset.signDraft)return signDraft(b.dataset.signDraft);if(b.dataset.manage)return createManagementAction(b.dataset.manage);switch(b.id){case"connect-wallet":return discoverAndConnect();case"logout":await api("wallet-session",undefined,true,undefined,"DELETE");token="";return invalidate();case"refresh":return refresh();case"back-to-list":detail=undefined;$("agent-detail").classList.add("hidden");$("agent-list").classList.remove("hidden");return;case"create-invitation":return createInvitation();case"review-binding":return reviewBinding();case"confirm-binding":return confirmBinding();case"check-binding-status":return checkBindingStatus();case"copy-binding-prompt":return copyBindingPrompt();case"check-relationship":return checkBindingRelationship();case"sign-action-intent":{const x=await api(`management-intents/${encodeURIComponent(value("action-intent-id"))}`,undefined,true);await verifyAndSign(x.intent);return toast("当前钱包已签署意图");}case"submit-action-intent":return submitIntent(value("action-intent-id"));case"export-json":return exportAudit("json");case"export-csv":return exportAudit("csv");}};void Promise.resolve().then(run).catch(error=>toast(`操作失败：${error.message}`));});
$("offer-file").addEventListener("change",e=>{
  offer=undefined;resetBindingReview();updateBindingAvailability();
  const input=e.target as HTMLInputElement,file=input.files?.[0];
  if(!file){$("offer-preview").textContent="尚未选择文件";return;}
  $("offer-preview").textContent="正在校验 Offer，链配置检查可能需要几秒…";
  void loadOffer(file).catch(error=>{
    if(file!==input.files?.[0])return;
    offer=undefined;updateBindingAvailability();input.value="";
    const code=error instanceof Error?error.message:"";
    const message=error instanceof SyntaxError?"文件不是有效 JSON"
      :code==="PAIRING_INVALID_OR_EXPIRED"?"Offer 已失效或过期，请让 Agent 重新生成"
      :code==="HTTP_401"||code==="HTTP_403"?"钱包登录已失效，请重新连接钱包"
      :code==="HTTP_503"||code==="CHAIN_UNAVAILABLE"||code==="NETWORK_OR_DEPLOYMENT_MISMATCH"?"平台链配置暂不可用，请稍后重试"
      :code.startsWith("Offer ")?code
      :"校验未完成，请检查平台连接后重试";
    $("offer-preview").textContent=`Offer 校验失败：${message}`;
    toast(`Offer 校验失败：${message}`);
  });
});
document.addEventListener("click",e=>{const id=(e.target as HTMLElement).closest<HTMLButtonElement>("[data-retry-draft]")?.dataset.retryDraft;if(id)void api(`management-drafts/${encodeURIComponent(id)}/retry`,{},true).then(()=>refresh()).then(()=>toast("链状态已核实，请重新签署草稿")).catch(error=>toast(`重试失败：${error.message}`));});
void api("integration/status").then(x=>{$("chain-status").textContent=x.chainConnected?"opBNB 合约已连接":"链连接待检查";}).catch(()=>{$("chain-status").textContent="API 暂不可用";});

document.querySelectorAll<HTMLInputElement>('input[name="binding-source"]').forEach(input=>input.addEventListener("change",showBindingSource));
for(const id of ["binding-did","binding-scopes","binding-days"])$(id).addEventListener("input",resetBindingReview);
$("binding-did").addEventListener("input",updateBindingAvailability);
showBindingSource();
window.setInterval(()=>{if(token&&currentView==="create")renderPairingExchanges();},15000);
