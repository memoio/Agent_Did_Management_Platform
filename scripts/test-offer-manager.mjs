import { readFileSync, writeFileSync, existsSync, lstatSync, chmodSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet, TypedDataEncoder, getAddress } from "ethers";

const [offerPath,keyPath]=process.argv.slice(2);
if(!offerPath||!keyPath)throw Error("USAGE: node scripts/test-offer-manager.mjs <offer-file> <isolated-manager-key-file>");
const origin=process.env.MEMO_TEST_API_URL||"http://127.0.0.1:4273";
const url=new URL(origin);
if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname)))throw Error("PLATFORM_ORIGIN_FORBIDDEN");
const path=resolve(offerPath),stat=lstatSync(path);
if(!stat.isFile()||stat.isSymbolicLink()||stat.size>65536)throw Error("INVALID_OFFER_FILE");
const offer=JSON.parse(readFileSync(path,"utf8"));
if(offer.schema!=="memo.agent-pairing-package/2"||offer.kind!=="agent-offer"||offer.platformOrigin!==url.origin||offer.chainId!==5611||Date.parse(offer.expiresAt)<Date.now())throw Error("OFFER_MISMATCH");
const keyFile=resolve(keyPath);
if(!existsSync(keyFile)){const generated=Wallet.createRandom();writeFileSync(keyFile,generated.privateKey,{mode:0o600,flag:"wx"});}
const keyStat=lstatSync(keyFile);if(!keyStat.isFile()||keyStat.isSymbolicLink()||(keyStat.mode&0o077)!==0)throw Error("INSECURE_MANAGER_KEY_FILE");
const wallet=new Wallet(readFileSync(keyFile,"utf8").trim());
async function api(route,body,token,idem){
  const response=await fetch(new URL(`/api/v1/${route}`,url.origin),{method:body===undefined?"GET":"POST",redirect:"error",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(token?{authorization:`Bearer ${token}`}:{ }),...(idem?{"idempotency-key":idem}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.code||`HTTP_${response.status}`);return result.data;
}
const config=await api("chain/config");
if(config.network.chainId!==5611||getAddress(offer.didRegistry)!==getAddress(config.contracts.didRegistry.address)||getAddress(offer.managementRegistry)!==getAddress(config.contracts.managementRegistry.address))throw Error("DEPLOYMENT_MISMATCH");
const challenge=await api("wallet-login-intents",{address:wallet.address});
const session=await api("wallet-sessions",{challengeId:challenge.challengeId,signature:await wallet.signMessage(challenge.message)});
const token=session.token;
const inspected=await api("pairing-offers/inspect",{exchangeId:offer.exchangeId,handle:offer.handle},token);
if(inspected.agentDid!==offer.agentDid||JSON.stringify(inspected.maxScopes)!==JSON.stringify(offer.maxScopes)||Number(inspected.maxTermSeconds)!==Number(offer.maxTermSeconds))throw Error("OFFER_METADATA_MISMATCH");
const redeemed=await api(`pairing-offers/${encodeURIComponent(offer.exchangeId)}/redeem`,{handle:offer.handle,requestedScopes:["agent.read"],requestedTermSeconds:86400,discoverable:false},token);
const draft=await api(`management-drafts/${encodeURIComponent(redeemed.draftId)}/intent`,{},token);
const intent=draft.intent;
if(intent.actionType!=="ActivateRelationship"||intent.networkId!=="eip155:5611"||getAddress(intent.domain.verifyingContract)!==getAddress(config.contracts.managementRegistry.address)||getAddress(intent.message.manager)!==wallet.address||TypedDataEncoder.hash(intent.domain,intent.types,intent.message)!==intent.digest)throw Error("INTENT_MISMATCH");
const signature=await wallet.signTypedData(intent.domain,intent.types,intent.message);
await api(`management-drafts/${encodeURIComponent(redeemed.draftId)}/wallet-signature`,{intentId:intent.intentId,managerSignature:signature},token);
process.stdout.write(JSON.stringify({schema:"memo.offer-manager-test-result/1",manager:wallet.address,agentDid:offer.agentDid,exchangeId:offer.exchangeId,draftId:redeemed.draftId,intentId:intent.intentId,digest:intent.digest,state:"WAITING_AGENT"})+"\n");
