import { readFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, TypedDataEncoder, getAddress } from "ethers";

const [draftId,keyPath]=process.argv.slice(2);
if(!/^[0-9a-f-]{36}$/i.test(draftId||"")||!keyPath)throw Error("USAGE: node scripts/test-draft-manager.mjs <draft-id> <isolated-manager-key-file>");
const origin=process.env.MEMO_TEST_API_URL||"http://127.0.0.1:4273",url=new URL(origin);
if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname)))throw Error("PLATFORM_ORIGIN_FORBIDDEN");
const stat=lstatSync(resolve(keyPath));
if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error("INSECURE_MANAGER_KEY_FILE");
const wallet=new Wallet(readFileSync(resolve(keyPath),"utf8").trim());
async function api(route,body,token){
  const response=await fetch(new URL(`/api/v1/${route}`,url.origin),{method:body===undefined?"GET":"POST",redirect:"error",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(token?{authorization:`Bearer ${token}`}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.code||`HTTP_${response.status}`);return result.data;
}
const config=await api("chain/config");
if(config.network.chainId!==5611)throw Error("NETWORK_MISMATCH");
const challenge=await api("wallet-login-intents",{address:wallet.address});
const session=await api("wallet-sessions",{challengeId:challenge.challengeId,signature:await wallet.signMessage(challenge.message)});
const response=await api(`management-drafts/${encodeURIComponent(draftId)}/intent`,{},session.token),intent=response.intent;
if(intent.actionType!=="ActivateRelationship"||intent.networkId!=="eip155:5611"||getAddress(intent.domain.verifyingContract)!==getAddress(config.contracts.managementRegistry.address)||getAddress(intent.message.manager)!==wallet.address||TypedDataEncoder.hash(intent.domain,intent.types,intent.message)!==intent.digest)throw Error("INTENT_MISMATCH");
const signature=await wallet.signTypedData(intent.domain,intent.types,intent.message);
await api(`management-drafts/${encodeURIComponent(draftId)}/wallet-signature`,{intentId:intent.intentId,managerSignature:signature},session.token);
process.stdout.write(JSON.stringify({draftId,intentId:intent.intentId,digest:intent.digest,manager:wallet.address,state:"WAITING_AGENT"})+"\n");
