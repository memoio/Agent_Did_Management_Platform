import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { computeAddress, getAddress, hashMessage, keccak256, recoverAddress, verifyMessage } from "ethers";
import { hashIdentifier, hashJson, hashScopes, toDid, type Intent, type ActionSignature, type ActionType, type Message } from "../../../packages/chain-adapter/src/index.js";
import { ChainService } from "./chain.service.js";
import { PlatformDb } from "./db.js";

type Role = "agent" | "manager";
type Session = {role:Role;address:string};
type Json = Record<string, unknown>;
const digest = (value:string)=>createHash("sha256").update(value).digest("hex");
const bad=(code:string)=>new BadRequestException({code,message:code});
const conflict=(code:string)=>new ConflictException({code,message:code});
const notFound=(code:string)=>new NotFoundException({code,message:code});
const forbidden=(code:string)=>new ForbiddenException({code,message:code});
const uuid=()=>randomUUID();

@Injectable()
export class PlatformService {
  constructor(private readonly chain:ChainService, private readonly db:PlatformDb){}

  async challenge(role:Role, addressInput:string){
    let address:string;
    try { address=getAddress(addressInput); } catch { throw bad("INVALID_ADDRESS"); }
    const id=uuid(), nonce=randomBytes(24).toString("hex");
    const origin=process.env.MEMO_PLATFORM_ORIGIN || "http://127.0.0.1:4273";
    const message=`MEMO Agent DID session\nOrigin: ${origin}\nChain ID: 5611\nRole: ${role}\nAddress: ${address}\nNonce: ${nonce}\nExpires: ${new Date(Date.now()+5*60_000).toISOString()}`;
    await this.db.query("INSERT INTO challenges(id,role,address,message,expires_at) VALUES($1,$2,$3,$4,now()+interval '5 minutes')",[id,role,address,message]);
    return {challengeId:id,message,expiresAt:new Date(Date.now()+5*60_000).toISOString()};
  }

  async session(role:Role, input:{challengeId:string;signature:string}){
    const token=randomBytes(32).toString("base64url");
    const result=await this.db.transaction(async c=>{
      const rows=(await c.query("SELECT * FROM challenges WHERE id=$1 FOR UPDATE",[input.challengeId])).rows;
      const row=rows[0];
      if(!row || row.role!==role || row.used_at || new Date(row.expires_at).getTime()<Date.now()) throw new UnauthorizedException({code:"CHALLENGE_EXPIRED",message:"Challenge expired"});
      let recovered:string|undefined;
      try { recovered=getAddress(verifyMessage(row.message,input.signature)); } catch {/* ERC-1271 wallet signatures do not recover as EOA signatures. */}
      if(recovered!==getAddress(row.address)) {
        if(role!=="manager")throw new UnauthorizedException({code:"INVALID_SIGNATURE",message:"Invalid signature"});
        try{await(await this.chain.adapter()).verifyAddressSignature(row.address,hashMessage(row.message),input.signature);}catch{throw new UnauthorizedException({code:"INVALID_SIGNATURE",message:"Invalid signature"});}
        recovered=getAddress(row.address);
      }
      await c.query("UPDATE challenges SET used_at=now() WHERE id=$1",[input.challengeId]);
      await c.query("INSERT INTO sessions(token_hash,role,address,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",[digest(token),role,recovered]);
      return recovered;
    });
    return {token,role,address:result,expiresAt:new Date(Date.now()+3600_000).toISOString()};
  }

  async requireSession(header:string|undefined,role?:Role):Promise<Session>{
    const match=/^Bearer ([A-Za-z0-9_-]{40,})$/.exec(header||"");
    if(!match) throw new UnauthorizedException({code:"SESSION_REQUIRED",message:"Session required"});
    const rows=await this.db.query("SELECT role,address FROM sessions WHERE token_hash=$1 AND expires_at>now()",[digest(match[1])]);
    if(!rows[0]) throw new UnauthorizedException({code:"SESSION_EXPIRED",message:"Session expired"});
    if(role && rows[0].role!==role) throw forbidden("ROLE_FORBIDDEN");
    return {role:rows[0].role as Role,address:rows[0].address as string};
  }

  async walletSession(header:string|undefined){const s=await this.requireSession(header,"manager");return {address:s.address,network:"eip155:5611"};}
  async endWalletSession(header:string|undefined){await this.requireSession(header,"manager");const token=header!.slice(7);await this.db.query("DELETE FROM sessions WHERE token_hash=$1",[digest(token)]);return {ended:true};}

  private agentFromDid(did:string){
    const m=/^did:memo:agent:5611:(0x[0-9a-f]{40})$/.exec(did);
    if(!m) throw bad("INVALID_DID");
    return getAddress(m[1]);
  }

  private async persistIntent(intent:Intent, agentDid:string, createdBy:string, profile:unknown=null, document:unknown=null, context:unknown=null){
    const operationId=uuid(),requestId=uuid();
    await this.db.transaction(async c=>{
      await c.query("INSERT INTO intents(id,agent_did,action_type,intent,profile,document,context,created_by,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9))",[intent.intentId,agentDid,intent.actionType,intent,profile,document,context,createdBy,intent.message.deadline]);
      await c.query("INSERT INTO operations(id,intent_id,agent_did,action_type,action_digest,state,request_id) VALUES($1,$2,$3,$4,$5,'CREATED',$6)",[operationId,intent.intentId,agentDid,intent.actionType,intent.digest,requestId]);
      await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,actor,detail) VALUES($1,$2,'INTENT_CREATED',$3,$4)",[operationId,intent.intentId,createdBy,{actionType:intent.actionType,actionDigest:intent.digest}]);
      if(profile!==null||document!==null)await c.query("INSERT INTO agent_document_versions(intent_id,agent_did,action_type,profile,document,profile_hash,document_hash) VALUES($1,$2,$3,$4,$5,$6,$7)",[intent.intentId,agentDid,intent.actionType,profile,document,intent.message.profileHash??null,intent.message.documentHash??null]);
    });
    return intent;
  }

  async registrationIntent(auth:string|undefined, input:{identityAccount:string;identityPublicKey:string;profile:Json;document:Json}){
    const session=await this.requireSession(auth,"agent");
    let address:string, publicKeyHash:string;
    try {
      address=getAddress(input.identityAccount);
      if(!/^0x04[0-9a-fA-F]{128}$/.test(input.identityPublicKey)) throw Error();
      if(address!==session.address || computeAddress(input.identityPublicKey)!==address) throw Error();
      publicKeyHash=keccak256(`0x${input.identityPublicKey.replace(/^0x04/,"").replace(/^04/,"")}`);
    } catch { throw bad("IDENTITY_KEY_MISMATCH"); }
    if(!input.profile || typeof input.profile!=="object" || Array.isArray(input.profile) || !input.document || typeof input.document!=="object" || Array.isArray(input.document)) throw bad("INVALID_DOCUMENT");
    const adapter=await this.chain.adapter();
    const intent=await adapter.buildIntent("RegisterAgent",{identityAccount:address,identityPublicKeyHash:publicKeyHash,profileHash:hashJson(input.profile),documentHash:hashJson(input.document)});
    return this.persistIntent(intent,toDid(5611,address),address,input.profile,input.document);
  }

  async managementIntent(auth:string|undefined,input:{agentDid:string;scopes:string[];termSeconds:number;discoverable:boolean},ttlSeconds=300){
    const session=await this.requireSession(auth,"manager");
    const agent=this.agentFromDid(input.agentDid);
    if(!Number.isSafeInteger(input.termSeconds) || input.termSeconds<60 || input.termSeconds>365*24*3600 || typeof input.discoverable!=="boolean") throw bad("INVALID_TERMS");
    const adapter=await this.chain.adapter();
    const identity=await adapter.readIdentity(agent);
    if(identity.status!=="ACTIVE") throw conflict("AGENT_NOT_ACTIVE");
    const block=await adapter.readBlock();
    const intent=await adapter.buildIntent("ActivateRelationship",{agent,manager:session.address,relationshipIdHash:hashIdentifier(uuid()),scopesHash:hashScopes(input.scopes),issuedAt:String(block.timestamp),expiresAt:String(block.timestamp+input.termSeconds),discoverable:input.discoverable},undefined,ttlSeconds);
    return this.persistIntent(intent,input.agentDid,session.address,null,null,{scopes:input.scopes,termSeconds:input.termSeconds,discoverable:input.discoverable});
  }

  async registryActionIntent(auth:string|undefined,input:{actionType:ActionType;profile?:Json;document?:Json;credentialId?:string}){
    const actor=await this.requireSession(auth,"agent");
    const action=input.actionType;
    if(!["UpdateProfile","UpdateDocument","SuspendAgent","ResumeAgent","RevokeAgent","RevokeInstanceCredential"].includes(action))throw bad("INVALID_ACTION");
    const payload:Message={identityAccount:actor.address};
    if(action==="UpdateProfile"){
      if(!input.profile||typeof input.profile!=="object"||Array.isArray(input.profile))throw bad("INVALID_PROFILE");
      payload.profileHash=hashJson(input.profile);
    }
    if(action==="UpdateDocument"){
      if(!input.document||typeof input.document!=="object"||Array.isArray(input.document))throw bad("INVALID_DOCUMENT");
      payload.documentHash=hashJson(input.document);
    }
    if(action==="RevokeInstanceCredential"){
      if(!input.credentialId)throw bad("CREDENTIAL_ID_REQUIRED");payload.credentialIdHash=hashIdentifier(input.credentialId);
    }
    const intent=await(await this.chain.adapter()).buildIntent(action,payload);
    return this.persistIntent(intent,toDid(5611,actor.address),actor.address,input.profile??null,input.document??null,input.credentialId?{credentialId:input.credentialId}:null);
  }

  async managementActionIntent(auth:string|undefined,input:{actionType:ActionType;agentDid:string;scopes?:string[];termSeconds?:number;discoverable?:boolean;newManager?:string;reason?:string}){
    const actor=await this.requireSession(auth);
    if(input.actionType==="ActivateRelationship")return this.managementIntent(auth,{agentDid:input.agentDid,scopes:input.scopes!,termSeconds:input.termSeconds!,discoverable:input.discoverable!});
    const adapter=await this.chain.adapter(),agent=this.agentFromDid(input.agentDid),relationship=await adapter.readRelationship(agent);
    if(!relationship.live&&input.actionType!=="EndRelationship")throw conflict("RELATIONSHIP_NOT_ACTIVE");
    const manager=getAddress(relationship.manager);
    if(input.actionType==="RenewRelationship"||input.actionType==="TransferRelationship"){
      if(actor.role!=="manager"||actor.address!==manager)throw forbidden("MANAGER_REQUIRED");
      const identity=await adapter.readIdentity(agent);if(identity.status!=="ACTIVE")throw conflict("AGENT_NOT_ACTIVE");
      if(!Number.isSafeInteger(input.termSeconds)||input.termSeconds!<60||input.termSeconds!>365*86400||typeof input.discoverable!=="boolean")throw bad("INVALID_TERMS");
      const block=await adapter.readBlock();
      const shared={agent,scopesHash:hashScopes(input.scopes!),expiresAt:String(block.timestamp+input.termSeconds!),discoverable:input.discoverable!};
      let payload:Message;
      if(input.actionType==="RenewRelationship")payload={...shared,manager,relationshipIdHash:relationship.relationshipIdHash};
      else {
        let newManager:string;try{newManager=getAddress(input.newManager!);}catch{throw bad("INVALID_ADDRESS");}
        if(newManager===manager)throw bad("INVALID_ADDRESS");
        payload={...shared,oldManager:manager,newManager,oldRelationshipIdHash:relationship.relationshipIdHash,newRelationshipIdHash:hashIdentifier(uuid())};
      }
      return this.persistIntent(await adapter.buildIntent(input.actionType,payload),input.agentDid,actor.address,null,null,{scopes:input.scopes,termSeconds:input.termSeconds,discoverable:input.discoverable,newManager:input.newManager});
    }
    if(input.actionType==="EndRelationship"){
      if(actor.address!==manager&&actor.address!==agent)throw forbidden("SIGNER_NOT_REQUIRED");
      const reason=actor.address===agent?"AGENT_ENDED":"MANAGER_ENDED";
      const selected=input.reason||reason;
      if(selected!==reason&&selected!=="SECURITY_REVOCATION")throw bad("INVALID_REASON");
      const payload={agent,manager,relationshipIdHash:relationship.relationshipIdHash,actor:actor.address,reasonHash:hashIdentifier(selected)};
      return this.persistIntent(await adapter.buildIntent("EndRelationship",payload),input.agentDid,actor.address,null,null,{reason:selected});
    }
    throw bad("INVALID_ACTION");
  }

  async pendingManagement(auth:string|undefined){
    const session=await this.requireSession(auth,"agent");
    const did=toDid(5611,session.address);
    const rows=await this.db.query("SELECT i.intent,i.context FROM intents i JOIN operations o ON o.intent_id=i.id WHERE i.agent_did=$1 AND i.action_type IN ('ActivateRelationship','RenewRelationship','EndRelationship','TransferRelationship') AND i.expires_at>now() AND o.state='CREATED' ORDER BY i.created_at DESC LIMIT 30",[did]);
    return rows.filter(r=>(r.intent as Intent).requiredSigners.some(s=>getAddress(s.address)===session.address)).map(r=>({intent:r.intent,display:r.context}));
  }

  async getIntent(auth:string|undefined,id:string){
    const session=await this.requireSession(auth);
    const rows=await this.db.query("SELECT * FROM intents WHERE id=$1",[id]);
    const row=rows[0];if(!row) throw notFound("INTENT_NOT_FOUND");
    if(this.agentFromDid(row.agent_did)!==session.address && row.created_by!==session.address && !(row.intent as Intent).requiredSigners.some(s=>getAddress(s.address)===session.address)) throw notFound("INTENT_NOT_FOUND");
    return row.intent as Intent;
  }

  async getManagementIntentDetails(auth:string|undefined,id:string){
    const intent=await this.getIntent(auth,id);
    const rows=await this.db.query("SELECT context FROM intents WHERE id=$1",[id]);
    return {intent,display:rows[0]?.context??null};
  }

  async addSignature(auth:string|undefined,id:string,input:ActionSignature){
    const session=await this.requireSession(auth);
    const intent=await this.getIntent(auth,id);
    const role=input.role;
    let signerAddress:string;
    try { signerAddress=getAddress(input.address); } catch { throw bad("INVALID_ADDRESS"); }
    if(signerAddress!==session.address || !intent.requiredSigners.some(s=>s.role===role && getAddress(s.address)===session.address)) throw forbidden("SIGNER_NOT_REQUIRED");
    let eoaValid=false;
    try { eoaValid=getAddress(recoverAddress(intent.digest,input.signature))===session.address; }catch{/* Contract wallet signature. */}
    if(!eoaValid){
      if(session.role!=="manager")throw bad("INVALID_SIGNATURE");
      try{await(await this.chain.adapter()).verifyAddressSignature(session.address,intent.digest,input.signature);}catch{throw bad("INVALID_SIGNATURE");}
    }
    await this.db.transaction(async c=>{
      const inserted=await c.query("INSERT INTO intent_signatures(intent_id,role,address,signature) VALUES($1,$2,$3,$4) ON CONFLICT(intent_id,role) DO NOTHING RETURNING role",[id,role,session.address,input.signature]);
      if(inserted.rowCount)await c.query("INSERT INTO audit_events(intent_id,event_type,actor,detail) VALUES($1,'SIGNATURE_ACCEPTED',$2,$3)",[id,session.address,{role}]);
    });
    const rows=await this.db.query("SELECT role FROM intent_signatures WHERE intent_id=$1",[id]);
    return {intentId:id,receivedRoles:rows.map(r=>r.role)};
  }

  private async signAndQueue(auth:string|undefined,id:string,signatures:ActionSignature[],key:string){
    if(!/^[A-Za-z0-9._:-]{8,128}$/.test(key||"")) throw bad("IDEMPOTENCY_KEY_REQUIRED");
    const session=await this.requireSession(auth);
    const intent=await this.getIntent(auth,id);
    const normalizedSignatures=[...signatures].sort((a,b)=>a.role.localeCompare(b.role)||a.address.localeCompare(b.address));
    const bodyHash=digest(JSON.stringify({id,signatures:normalizedSignatures}));
    const existing=await this.db.query("SELECT id,state,idempotency_body_hash,action_digest FROM operations WHERE idempotency_subject=$1 AND idempotency_key=$2",[session.address,key]);
    if(existing[0]) {if(existing[0].idempotency_body_hash!==bodyHash) throw conflict("IDEMPOTENCY_CONFLICT");return {operationId:existing[0].id,state:existing[0].state,actionDigest:existing[0].action_digest};}
    const adapter=await this.chain.adapter();
    for(let attempt=0;;attempt++){
      try{await adapter.verifySignedAction(intent,signatures);break;}
      catch(error){if(attempt>=2||!["CHAIN_UNAVAILABLE","CHAIN_STATE_UNCERTAIN"].includes((error as {code?:string}).code||""))throw error;await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));}
    }
    return this.db.transaction(async c=>{
      const rows=(await c.query("SELECT * FROM operations WHERE intent_id=$1 FOR UPDATE",[id])).rows;
      const row=rows[0];if(!row || row.state!=="CREATED") throw conflict("INTENT_ALREADY_SUBMITTED");
      for(const s of signatures) await c.query("INSERT INTO intent_signatures(intent_id,role,address,signature) VALUES($1,$2,$3,$4) ON CONFLICT(intent_id,role) DO NOTHING",[id,s.role,s.address,s.signature]);
      await c.query("UPDATE operations SET state='SIGNED',idempotency_subject=$2,idempotency_key=$3,idempotency_body_hash=$4,updated_at=now() WHERE id=$1",[row.id,session.address,key,bodyHash]);
      await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,actor,detail) VALUES($1,$2,'OPERATION_SIGNED',$3,$4)",[row.id,id,session.address,{actionDigest:intent.digest,roles:signatures.map(s=>s.role)}]);
      return {operationId:row.id,state:"SIGNED",actionDigest:intent.digest};
    });
  }

  async submitRegistration(auth:string|undefined,input:{intentId:string;signature:string},key:string){
    const session=await this.requireSession(auth,"agent");
    const intent=await this.getIntent(auth,input.intentId);
    if(intent.actionType!=="RegisterAgent") throw bad("INVALID_ACTION");
    return this.signAndQueue(auth,input.intentId,[{role:"agent",address:session.address,signature:input.signature}],key);
  }

  async submitRegistryAction(auth:string|undefined,input:{intentId:string;signature:string},key:string){
    const session=await this.requireSession(auth,"agent"),intent=await this.getIntent(auth,input.intentId);
    if(intent.actionType==="RegisterAgent"||!intent.requiredSigners.some(s=>s.role==="agent"&&getAddress(s.address)===session.address))throw bad("INVALID_ACTION");
    return this.signAndQueue(auth,input.intentId,[{role:"agent",address:session.address,signature:input.signature}],key);
  }

  async submitManagement(auth:string|undefined,input:{intentId:string},key:string){
    await this.requireSession(auth);
    const rows=await this.db.query("SELECT role,address,signature FROM intent_signatures WHERE intent_id=$1",[input.intentId]);
    return this.signAndQueue(auth,input.intentId,rows as ActionSignature[],key);
  }

  async operation(auth:string|undefined,id:string){
    const session=await this.requireSession(auth);
    const rows=await this.db.query("SELECT o.*,i.created_by FROM operations o JOIN intents i ON i.id=o.intent_id WHERE o.id=$1",[id]);
    const r=rows[0];if(!r || (this.agentFromDid(r.agent_did)!==session.address && r.created_by!==session.address)) throw notFound("OPERATION_NOT_FOUND");
    return {operationId:r.id,state:r.state,actionDigest:r.action_digest,submissionId:r.submission_id,txHash:r.tx_hash,blockNumber:r.block_number,blockHash:r.block_hash,confirmations:r.confirmations,finalitySource:r.finality_source,errorCode:r.error_code,updatedAt:r.updated_at};
  }

  async resolve(did:string){
    const address=this.agentFromDid(did), adapter=await this.chain.adapter();
    const identity=await adapter.readIdentity(address);
    if(identity.status==="NONE") throw notFound("DID_NOT_FOUND");
    const docs=await this.db.query("SELECT * FROM agent_documents WHERE agent_did=$1",[did]);
    const proof=await this.db.query("SELECT tx_hash,block_number,block_hash,action_digest FROM operations WHERE agent_did=$1 AND action_type='RegisterAgent' AND state='CONFIRMED' ORDER BY updated_at DESC LIMIT 1",[did]);
    const versions=await this.db.query("SELECT profile,document,profile_hash,document_hash FROM agent_document_versions WHERE agent_did=$1 AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC",[did]);
    const profile=versions.find(v=>v.profile_hash===identity.profileHash)?.profile??(docs[0]?.profile_hash===identity.profileHash?docs[0].profile:null);
    const document=versions.find(v=>v.document_hash===identity.documentHash)?.document??(docs[0]?.document_hash===identity.documentHash?docs[0].document:null);
    return {did,status:identity.status,revision:identity.revision,profileHash:identity.profileHash,documentHash:identity.documentHash,profile,document,verified:profile!==null&&document!==null,proof:proof[0]??null,source:identity.source};
  }

  async relationship(did:string){
    const address=this.agentFromDid(did),adapter=await this.chain.adapter();
    return {agentDid:did,...await adapter.readRelationship(address)};
  }

  async dashboard(auth:string|undefined){
    const actor=await this.requireSession(auth,"manager");
    const rows=await this.db.query("SELECT DISTINCT o.agent_did FROM operations o JOIN intents i ON i.id=o.intent_id WHERE i.created_by=$1 AND o.state='CONFIRMED' AND o.action_type IN ('ActivateRelationship','RenewRelationship','TransferRelationship') UNION SELECT DISTINCT o.agent_did FROM operations o JOIN intent_signatures s ON s.intent_id=o.intent_id WHERE s.address=$1 AND s.role IN ('manager','newManager') AND o.state='CONFIRMED' AND o.action_type IN ('ActivateRelationship','TransferRelationship') UNION SELECT DISTINCT agent_did FROM pairing_bindings WHERE manager_address=$1 AND state='ACTIVE'",[actor.address]);
    const agents=[];
    for(const row of rows){
      try{agents.push(await this.agentDetail(auth,row.agent_did as string));}catch{/* A stale binding must not expose another manager's data. */}
    }
    const exchanges=await this.db.query("SELECT id,kind,state,agent_did,expires_at FROM pairing_exchanges WHERE creator=$1 OR manager_address=$1 ORDER BY created_at DESC LIMIT 30",[actor.address]);
    return {schema:"memo.agent-dashboard/2",walletSession:{account:actor.address},agents,pairingExchanges:exchanges,counts:{total:agents.length,managed:agents.filter(a=>a.management?.live).length,pending:agents.filter(a=>a.managementDraft&&!["CONFIRMED","REJECTED"].includes(String(a.managementDraft.state))).length,unmanaged:agents.filter(a=>!a.management?.live).length}};
  }

  async agentDetail(auth:string|undefined,did:string){
    const actor=await this.requireSession(auth,"manager"),address=this.agentFromDid(did);
    const binding=(await this.db.query("SELECT * FROM pairing_bindings WHERE agent_did=$1 AND manager_address=$2 AND state='ACTIVE'",[did,actor.address]))[0];
    const confirmed=(await this.db.query("SELECT o.id FROM operations o JOIN intents i ON i.id=o.intent_id WHERE o.agent_did=$1 AND o.state='CONFIRMED' AND o.action_type IN ('ActivateRelationship','RenewRelationship','TransferRelationship') AND (i.created_by=$2 OR EXISTS(SELECT 1 FROM intent_signatures s WHERE s.intent_id=o.intent_id AND s.address=$2 AND s.role IN ('manager','newManager'))) LIMIT 1",[did,actor.address]))[0];
    if(!binding&&!confirmed)throw notFound("TENANT_AGENT_ACCESS_DENIED");
    const adapter=await this.chain.adapter(),management=await adapter.readRelationship(address);
    if((management.live||!binding)&&getAddress(management.manager)!==actor.address)throw notFound("TENANT_AGENT_ACCESS_DENIED");
    const identity=await adapter.readIdentity(address);
    const versions=await this.db.query("SELECT profile,document,profile_hash,document_hash,confirmed_at FROM agent_document_versions WHERE agent_did=$1 AND confirmed_at IS NOT NULL ORDER BY confirmed_at DESC LIMIT 30",[did]);
    const legacy=(await this.db.query("SELECT * FROM agent_documents WHERE agent_did=$1",[did]))[0];
    const profile=versions.find(v=>v.profile_hash===identity.profileHash)?.profile??(legacy?.profile_hash===identity.profileHash?legacy.profile:null);
    const document=versions.find(v=>v.document_hash===identity.documentHash)?.document??(legacy?.document_hash===identity.documentHash?legacy.document:null);
    const draft=(await this.db.query("SELECT d.*,i.expires_at AS intent_expires_at FROM management_drafts d LEFT JOIN intents i ON i.id=d.intent_id WHERE d.agent_did=$1 AND d.manager_address=$2 ORDER BY d.created_at DESC LIMIT 1",[did,actor.address]))[0]??null;
    const operations=await this.db.query("SELECT id,action_type,state,action_digest,tx_hash,block_number,block_hash,finality_source,created_at FROM operations WHERE agent_did=$1 ORDER BY created_at DESC LIMIT 50",[did]);
    const events=await this.db.query("SELECT event,block_number,tx_hash FROM chain_events WHERE agent_did=$1 ORDER BY block_number DESC,log_index DESC LIMIT 100",[did]);
    const audit=await this.db.query("SELECT id,event_type,actor,detail,created_at FROM audit_events WHERE operation_id IN (SELECT id FROM operations WHERE agent_did=$1) ORDER BY id DESC LIMIT 100",[did]);
    const instances=await this.db.query("SELECT instance_id,name,public_key,credential,expires_at,state FROM agent_instances WHERE agent_did=$1 ORDER BY created_at DESC",[did]);
    return {schema:"memo.agent-dashboard-detail/2",binding:binding??null,associationSource:binding?"pairing":"confirmed-chain-management",identity:{exists:identity.status!=="NONE",agentDid:did,state:identity.status,identityRevision:identity.revision,profileHash:identity.profileHash,documentHash:identity.documentHash,network:"eip155:5611",source:identity.source},profile,document,profileHistory:versions.map(v=>({profileHash:v.profile_hash,documentHash:v.document_hash,confirmedAt:v.confirmed_at})),management:getAddress(management.manager)===actor.address?management:null,managementDraft:draft,operations,events,audit,instances};
  }

  async audit(auth:string|undefined){
    const actor=await this.requireSession(auth,"manager");
    return this.db.query("SELECT a.id,a.event_type,a.actor,a.detail,a.created_at FROM audit_events a LEFT JOIN operations o ON o.id=a.operation_id LEFT JOIN intents i ON i.id=COALESCE(a.intent_id,o.intent_id) WHERE i.created_by=$1 OR (o.agent_did IN (SELECT agent_did FROM pairing_bindings WHERE manager_address=$1 AND state='ACTIVE')) OR (a.event_type LIKE 'PAIRING_%' AND (a.actor=$1 OR a.detail->>'exchangeId' IN (SELECT id::text FROM pairing_exchanges WHERE creator=$1 OR manager_address=$1))) ORDER BY a.id DESC LIMIT 500",[actor.address]);
  }

  async publishInstance(auth:string|undefined,input:{schema:string;agentDid:string;instanceId:string;name:string;publicKey:string;expiresAt:number;identityRevision:number;signature:string}){
    const actor=await this.requireSession(auth,"agent"),did=toDid(5611,actor.address);
    if(input.schema!=="memo.instance-credential/1"||input.agentDid!==did||!/^[A-Za-z0-9._:-]{8,128}$/.test(input.instanceId)||!/^[A-Za-z0-9._-]{1,64}$/.test(input.name)||!/^0x04[0-9a-fA-F]{128}$/.test(input.publicKey)||!Number.isSafeInteger(input.expiresAt)||input.expiresAt<=Date.now()||input.expiresAt>Date.now()+30*86400_000)throw bad("INVALID_INSTANCE_CREDENTIAL");
    const identity=await(await this.chain.adapter()).readIdentity(actor.address);
    if(identity.status!=="ACTIVE"||Number(identity.revision)!==input.identityRevision)throw conflict("IDENTITY_REVISION_MISMATCH");
    const message=JSON.stringify([input.schema,input.agentDid,input.instanceId,input.name,input.publicKey,input.expiresAt,input.identityRevision]);
    try{if(getAddress(verifyMessage(message,input.signature))!==actor.address)throw Error();}catch{throw bad("INVALID_SIGNATURE");}
    await this.db.query("INSERT INTO agent_instances(instance_id,agent_did,name,public_key,credential,expires_at) VALUES($1,$2,$3,$4,$5,to_timestamp($6)) ON CONFLICT(instance_id) DO NOTHING",[input.instanceId,did,input.name,input.publicKey,input,input.expiresAt/1000]);
    return {instanceId:input.instanceId,agentDid:did,state:"ACTIVE",expiresAt:input.expiresAt};
  }

  async instances(auth:string|undefined){const actor=await this.requireSession(auth,"agent");return this.db.query("SELECT instance_id,name,public_key,expires_at,state FROM agent_instances WHERE agent_did=$1 ORDER BY created_at DESC",[toDid(5611,actor.address)]);}
}
