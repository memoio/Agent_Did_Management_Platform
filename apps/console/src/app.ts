import { BrowserProvider, TypedDataEncoder, getAddress } from "ethers";

declare global { interface Window { ethereum?: {request:(args:{method:string;params?:unknown[]})=>Promise<unknown>} } }
const el=(id:string)=>document.getElementById(id) as HTMLElement;
const value=(id:string)=>(el(id) as HTMLInputElement).value.trim();
const result=el("result");
let provider:BrowserProvider|undefined, address="",token="";

async function api(path:string,body?:unknown,auth=false,idem=false){
  const response=await fetch(`/api/v1/${path}`,{method:body===undefined?"GET":"POST",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(auth?{authorization:`Bearer ${token}`}:{ }),...(idem?{"idempotency-key":crypto.randomUUID()}:{})},body:body===undefined?undefined:JSON.stringify(body),cache:"no-store"});
  const payload=await response.json();
  if(!response.ok||!payload.ok)throw Error(payload.error?.code||`HTTP_${response.status}`);
  return payload.data;
}
function show(data:unknown){result.textContent=typeof data==="string"?data:JSON.stringify(data,null,2);}
function rpcCode(error:unknown):number|undefined{
  let current:unknown=error;
  for(let n=0;n<4&&current&&typeof current==="object";n++){
    const detail=current as {code?:unknown;error?:unknown;info?:{error?:unknown};cause?:unknown};
    if(typeof detail.code==="number")return detail.code;
    current=detail.error??detail.info?.error??detail.cause;
  }
  return undefined;
}
async function network(){
  const config=await api("chain/config");
  if(config.network.chainId!==5611||config.network.caip2!=="eip155:5611"||!config.contracts.managementRegistry?.address)throw Error("NETWORK_OR_DEPLOYMENT_MISMATCH");
  return config;
}
async function connect(){
  if(!window.ethereum)throw Error("请安装支持 EIP-712 的浏览器钱包");
  provider=undefined;address="";token="";el("wallet-status").textContent="未连接";
  const config=await network();
  let requested:unknown;
  try{requested=await window.ethereum.request({method:"eth_requestAccounts"});}
  catch(error){throw Error(rpcCode(error)===4001?"请在钱包中允许此站点连接账户":"钱包账户授权失败，请在钱包中允许 127.0.0.1:4273 访问该账户");}
  if(!Array.isArray(requested)||typeof requested[0]!=="string")throw Error("钱包没有返回已授权账户");
  const selected=getAddress(requested[0]);
  try{await window.ethereum.request({method:"wallet_switchEthereumChain",params:[{chainId:"0x15eb"}]});}
  catch(error){
    if(rpcCode(error)!==4902)throw Error("切换 opBNB Testnet 失败，请在钱包中确认网络切换");
    await window.ethereum.request({method:"wallet_addEthereumChain",params:[{chainId:"0x15eb",chainName:config.network.name,rpcUrls:[config.network.publicRpcUrl],blockExplorerUrls:[config.network.explorerUrl],nativeCurrency:config.network.nativeCurrency}]});
  }
  const connected=new BrowserProvider(window.ethereum as never);
  if((await connected.getNetwork()).chainId!==5611n)throw Error("钱包当前网络不是 opBNB Testnet (5611)");
  const accounts=await connected.send("eth_accounts",[]) as string[];
  if(!accounts.some(account=>getAddress(account)===selected))throw Error("钱包尚未授权当前账户，请重新连接");
  const signer=await connected.getSigner(selected);
  const challenge=await api("wallet-login-intents",{address:selected});
  let signature:string;
  try{signature=await signer.signMessage(challenge.message);}
  catch(error){
    const code=rpcCode(error);
    throw Error(code===4100?"钱包未授权登录签名。请在钱包扩展中允许 127.0.0.1:4273 使用当前账户，然后重新连接":code===4001?"已取消钱包登录签名":"钱包登录签名失败，请检查当前账户的站点权限");
  }
  const session=await api("wallet-sessions",{challengeId:challenge.challengeId,signature});
  provider=connected;address=selected;token=session.token;
  el("wallet-status").textContent=selected;
  show({wallet:selected,network:config.network.caip2});
}
async function createIntent(){
  if(!provider||!token)throw Error("请先连接钱包");
  const config=await network();
  const intent=await api("management-intents",{agentDid:value("agent-did"),scopes:value("scopes").split(",").map(x=>x.trim()).filter(Boolean),termSeconds:Number(value("term-days"))*86400,discoverable:(el("discoverable") as HTMLInputElement).checked},true);
  if(intent.domain.chainId!==5611||getAddress(intent.domain.verifyingContract)!==getAddress(config.contracts.managementRegistry.address)||TypedDataEncoder.hash(intent.domain,intent.types,intent.message)!==intent.digest)throw Error("意图签名域或 digest 不匹配");
  const signer=await provider.getSigner();
  if(await signer.getAddress()!==address)throw Error("钱包账户已切换，请重新登录");
  if((await provider.getNetwork()).chainId!==5611n)throw Error("钱包网络已切换，请重新登录");
  const signature=await signer.signTypedData(intent.domain,intent.types,intent.message);
  await api(`management-intents/${encodeURIComponent(intent.intentId)}/signatures`,{role:"manager",address,signature},true);
  (el("intent-id") as HTMLInputElement).value=intent.intentId;
  show({intentId:intent.intentId,agentDid:value("agent-did"),digest:intent.digest,status:"等待 Agent 在测试链 Skill 中批准同一意图"});
}
async function submit(){
  if(!token)throw Error("请先连接钱包");
  const op=await api("management-actions",{intentId:value("intent-id")},true,true);
  show(op);
  for(let n=0;n<60;n++){
    const state=await api(`operations/${encodeURIComponent(op.operationId)}`,undefined,true);
    show(state);
    if(["CONFIRMED","FAILED","REORGED"].includes(state.state))break;
    await new Promise(r=>setTimeout(r,3000));
  }
}
async function relationship(){show(await api(`management/${encodeURIComponent(value("agent-did"))}`));}
for(const [id,run] of [["connect-wallet",connect],["create-intent",createIntent],["submit-action",submit],["check-relationship",relationship]] as const){el(id).addEventListener("click",()=>{run().catch(e=>show(`操作失败：${e.message}`));});}
api("integration/status").then(s=>{el("status-title").textContent=s.network?.name||"测试链";el("status-detail").textContent=s.chainConnected?"合约连接已验证":"等待部署清单或链连接";}).catch(()=>{el("status-detail").textContent="API 暂不可用";});
