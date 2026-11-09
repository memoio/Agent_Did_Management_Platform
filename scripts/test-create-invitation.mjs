import { randomBytes, createHash } from "node:crypto";
import { readFileSync, writeFileSync, lstatSync } from "node:fs";
import { resolve } from "node:path";
import { Wallet } from "ethers";

const [keyPath,outputPath]=process.argv.slice(2);
if(!keyPath||!outputPath)throw Error("USAGE: node scripts/test-create-invitation.mjs <isolated-manager-key-file> <invitation-output-file>");
const origin=process.env.MEMO_TEST_API_URL||"http://127.0.0.1:4273",url=new URL(origin);
if(url.username||url.password||url.search||url.hash||!(url.protocol==="https:"||url.protocol==="http:"&&["localhost","127.0.0.1"].includes(url.hostname)))throw Error("PLATFORM_ORIGIN_FORBIDDEN");
const stat=lstatSync(resolve(keyPath));if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077)!==0)throw Error("INSECURE_MANAGER_KEY_FILE");
const wallet=new Wallet(readFileSync(resolve(keyPath),"utf8").trim());
async function api(route,body,token,idem){
  const response=await fetch(new URL(`/api/v1/${route}`,url.origin),{method:body===undefined?"GET":"POST",redirect:"error",headers:{...(body===undefined?{}:{"content-type":"application/json"}),...(token?{authorization:`Bearer ${token}`}:{ }),...(idem?{"idempotency-key":idem}:{})},body:body===undefined?undefined:JSON.stringify(body)});
  const result=await response.json();if(!response.ok||!result.ok)throw Error(result.error?.code||`HTTP_${response.status}`);return result.data;
}
const config=await api("chain/config");if(config.network.chainId!==5611)throw Error("NETWORK_MISMATCH");
const challenge=await api("wallet-login-intents",{address:wallet.address}),session=await api("wallet-sessions",{challengeId:challenge.challengeId,signature:await wallet.signMessage(challenge.message)});
const handle=randomBytes(32).toString("base64url"),handleHash=createHash("sha256").update(handle).digest("hex");
const maxScopes=["agent.read","profile.update"],maxTermSeconds=30*86400,ttlSeconds=1800,discoverable=false;
const exchange=await api("pairing-invitations",{handleHash,maxScopes,maxTermSeconds,ttlSeconds,discoverable},session.token,`invitation:${handleHash.slice(0,40)}`);
const file={schema:"memo.agent-pairing-package/2",kind:"platform-invitation",exchangeId:exchange.exchangeId,handle,platformOrigin:url.origin,chainId:5611,didRegistry:config.contracts.didRegistry.address,managementRegistry:config.contracts.managementRegistry.address,maxScopes,maxTermSeconds,discoverable,expiresAt:exchange.expiresAt};
writeFileSync(resolve(outputPath),JSON.stringify(file,null,2),{mode:0o600,flag:"wx"});
process.stdout.write(JSON.stringify({exchangeId:exchange.exchangeId,manager:wallet.address,invitationFile:resolve(outputPath),expiresAt:exchange.expiresAt})+"\n");
