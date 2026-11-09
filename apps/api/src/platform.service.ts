import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException, UnauthorizedException } from "@nestjs/common";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { computeAddress, getAddress, keccak256, recoverAddress, verifyMessage } from "ethers";
import { hashIdentifier, hashJson, hashScopes, toDid, type Intent, type ActionSignature } from "../../../packages/chain-adapter/src/index.js";
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
      let recovered:string;
      try { recovered=getAddress(verifyMessage(row.message,input.signature)); } catch { throw new UnauthorizedException({code:"INVALID_SIGNATURE",message:"Invalid signature"}); }
      if(recovered!==getAddress(row.address)) throw new UnauthorizedException({code:"INVALID_SIGNATURE",message:"Invalid signature"});
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

  async managementIntent(auth:string|undefined,input:{agentDid:string;scopes:string[];termSeconds:number;discoverable:boolean}){
    const session=await this.requireSession(auth,"manager");
    const agent=this.agentFromDid(input.agentDid);
    if(!Number.isSafeInteger(input.termSeconds) || input.termSeconds<60 || input.termSeconds>365*24*3600 || typeof input.discoverable!=="boolean") throw bad("INVALID_TERMS");
    const adapter=await this.chain.adapter();
    const identity=await adapter.readIdentity(agent);
    if(identity.status!=="ACTIVE") throw conflict("AGENT_NOT_ACTIVE");
    const block=await adapter.readBlock();
    const intent=await adapter.buildIntent("ActivateRelationship",{agent,manager:session.address,relationshipIdHash:hashIdentifier(uuid()),scopesHash:hashScopes(input.scopes),issuedAt:String(block.timestamp),expiresAt:String(block.timestamp+input.termSeconds),discoverable:input.discoverable});
    return this.persistIntent(intent,input.agentDid,session.address,null,null,{scopes:input.scopes,termSeconds:input.termSeconds,discoverable:input.discoverable});
  }

  async pendingManagement(auth:string|undefined){
    const session=await this.requireSession(auth,"agent");
    const did=toDid(5611,session.address);
    const rows=await this.db.query("SELECT i.intent,i.context FROM intents i JOIN operations o ON o.intent_id=i.id WHERE i.agent_did=$1 AND i.action_type='ActivateRelationship' AND i.expires_at>now() AND o.state='CREATED' ORDER BY i.created_at DESC LIMIT 30",[did]);
    return rows.map(r=>({intent:r.intent,display:r.context}));
  }

  async getIntent(auth:string|undefined,id:string){
    const session=await this.requireSession(auth);
    const rows=await this.db.query("SELECT * FROM intents WHERE id=$1",[id]);
    const row=rows[0];if(!row) throw notFound("INTENT_NOT_FOUND");
    if(this.agentFromDid(row.agent_did)!==session.address && row.created_by!==session.address) throw notFound("INTENT_NOT_FOUND");
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
    if(intent.actionType!=="ActivateRelationship") throw bad("INVALID_ACTION");
    const role=session.role;
    let signerAddress:string;
    try { signerAddress=getAddress(input.address); } catch { throw bad("INVALID_ADDRESS"); }
    if(input.role!==role || signerAddress!==session.address || !intent.requiredSigners.some(s=>s.role===role && getAddress(s.address)===session.address)) throw forbidden("SIGNER_NOT_REQUIRED");
    try { if(getAddress(recoverAddress(intent.digest,input.signature))!==session.address) throw Error(); }
    catch { throw bad("INVALID_SIGNATURE"); }
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
    await adapter.verifySignedAction(intent,signatures);
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
    const document=docs[0] && docs[0].document_hash===identity.documentHash && docs[0].profile_hash===identity.profileHash ? docs[0].document : null;
    return {did,status:identity.status,revision:identity.revision,profileHash:identity.profileHash,documentHash:identity.documentHash,document,proof:proof[0]??null,source:identity.source};
  }

  async relationship(did:string){
    const address=this.agentFromDid(did),adapter=await this.chain.adapter();
    return {agentDid:did,...await adapter.readRelationship(address)};
  }
}
