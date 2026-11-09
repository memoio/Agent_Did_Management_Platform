import { BadRequestException, ConflictException, ForbiddenException, Injectable, NotFoundException } from "@nestjs/common";
import { createHash, randomUUID } from "node:crypto";
import { getAddress } from "ethers";
import { toDid } from "../../../packages/chain-adapter/src/index.js";
import { ChainService } from "./chain.service.js";
import { PlatformDb } from "./db.js";
import { PlatformService } from "./platform.service.js";

type PairInput = {handleHash:string;maxScopes:string[];maxTermSeconds:number;ttlSeconds:number;discoverable?:boolean};
type RedeemInput = {handle:string;requestedScopes:string[];requestedTermSeconds:number;discoverable:boolean};
const fail=(code:string)=>new BadRequestException({code,message:code});
const conflict=(code:string)=>new ConflictException({code,message:code});
const hash=(value:string)=>createHash("sha256").update(value).digest("hex");
const scopes=(value:unknown)=>{
  if(!Array.isArray(value)||!value.length||value.length>64||value.some(s=>typeof s!=="string"||!/^[-A-Za-z0-9._:]{1,128}$/.test(s)))throw fail("INVALID_SCOPES");
  return [...new Set(value as string[])].sort();
};
const term=(n:number)=>{if(!Number.isSafeInteger(n)||n<60||n>365*86400)throw fail("INVALID_TERM");return n;};
const key=(v:string)=>{if(!/^[A-Za-z0-9._:-]{8,128}$/.test(v||""))throw fail("IDEMPOTENCY_KEY_REQUIRED");return v;};
const view=(r:Record<string,unknown>)=>({exchangeId:r.id,kind:r.kind,state:r.state,agentDid:r.agent_did,managerAddress:r.manager_address,maxScopes:r.max_scopes,maxTermSeconds:r.max_term_seconds,requestedScopes:r.requested_scopes,requestedTermSeconds:r.requested_term_seconds,discoverable:r.discoverable,expiresAt:r.expires_at});

@Injectable()
export class PairingService {
  constructor(private readonly db:PlatformDb,private readonly platform:PlatformService,private readonly chain:ChainService){}

  private async create(auth:string|undefined,role:"agent"|"manager",kind:"agent-offer"|"platform-invitation",input:PairInput,idem:string){
    const actor=await this.platform.requireSession(auth,role);
    const maxScopes=scopes(input.maxScopes),maxTermSeconds=term(input.maxTermSeconds);
    if(!/^[0-9a-f]{64}$/.test(input.handleHash||"")||!Number.isSafeInteger(input.ttlSeconds)||input.ttlSeconds<60||input.ttlSeconds>86400)throw fail("INVALID_PAIRING_FILE");
    if(input.discoverable!==undefined&&typeof input.discoverable!=="boolean")throw fail("INVALID_VISIBILITY");
    const agentDid=role==="agent"?toDid(5611,actor.address):null;
    if(agentDid){const adapter=await this.chain.adapter(),identity=await adapter.readIdentity(actor.address),relationship=await adapter.readRelationship(actor.address);if(identity.status!=="ACTIVE")throw conflict("IDENTITY_NOT_ACTIVE");if(relationship.live)throw conflict("ACTIVE_MANAGEMENT_RELATIONSHIP");}
    const id=randomUUID(),bodyHash=hash(JSON.stringify({kind,input:{...input,maxScopes}}));
    return this.db.transaction(async c=>{
      const existing=(await c.query("SELECT p.*,i.body_hash FROM pairing_idempotency i JOIN pairing_exchanges p ON p.id=i.exchange_id WHERE i.subject=$1 AND i.key=$2",[actor.address,key(idem)])).rows[0];
      if(existing){if(existing.body_hash!==bodyHash)throw conflict("IDEMPOTENCY_CONFLICT");return view(existing);}
      const row=(await c.query("INSERT INTO pairing_exchanges(id,kind,handle_hash,creator,agent_did,manager_address,max_scopes,max_term_seconds,requested_scopes,requested_term_seconds,discoverable,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,'OPEN',now()+($12*interval '1 second')) RETURNING *",[id,kind,input.handleHash,actor.address,agentDid,role==="manager"?actor.address:null,JSON.stringify(maxScopes),maxTermSeconds,role==="manager"?JSON.stringify(maxScopes):null,role==="manager"?maxTermSeconds:null,input.discoverable??false,input.ttlSeconds])).rows[0];
      await c.query("INSERT INTO pairing_idempotency(subject,key,body_hash,exchange_id) VALUES($1,$2,$3,$4)",[actor.address,idem,bodyHash,id]);
      await c.query("INSERT INTO audit_events(event_type,actor,detail) VALUES('PAIRING_CREATED',$1,$2)",[actor.address,{exchangeId:id,kind}]);
      return view(row);
    });
  }
  invitation(auth:string|undefined,input:PairInput,idem:string){return this.create(auth,"manager","platform-invitation",input,idem);}
  offer(auth:string|undefined,input:PairInput,idem:string){return this.create(auth,"agent","agent-offer",input,idem);}

  private async inspect(id:string,handle:string,kind:"agent-offer"|"platform-invitation"){
    if(typeof handle!=="string"||handle.length<32||handle.length>256)throw fail("INVALID_PAIRING_FILE");
    const rows=await this.db.query("SELECT * FROM pairing_exchanges WHERE id=$1 AND kind=$2",[id,kind]);
    const row=rows[0];if(!row||row.handle_hash!==hash(handle)||row.state!=="OPEN"||new Date(row.expires_at).getTime()<Date.now())throw fail("PAIRING_INVALID_OR_EXPIRED");
    return row;
  }
  async inspectInvitation(auth:string|undefined,input:{exchangeId:string;handle:string}){await this.platform.requireSession(auth,"agent");return view(await this.inspect(input.exchangeId,input.handle,"platform-invitation"));}
  async inspectOffer(auth:string|undefined,input:{exchangeId:string;handle:string}){await this.platform.requireSession(auth,"manager");return view(await this.inspect(input.exchangeId,input.handle,"agent-offer"));}

  async claimInvitation(auth:string|undefined,id:string,handle:string){
    const actor=await this.platform.requireSession(auth,"agent");await this.inspect(id,handle,"platform-invitation");
    const did=toDid(5611,actor.address);
    return this.db.transaction(async c=>{
      const row=(await c.query("SELECT * FROM pairing_exchanges WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(row?.state==="CLAIMED"&&row.handle_hash===hash(handle)&&row.agent_did===did)return view(row);
      if(!row||row.handle_hash!==hash(handle)||row.state!=="OPEN"||new Date(row.expires_at).getTime()<Date.now())throw fail("PAIRING_INVALID_OR_EXPIRED");
      const updated=(await c.query("UPDATE pairing_exchanges SET state='CLAIMED',agent_did=$2,completion_expires_at=now()+interval '30 minutes',updated_at=now() WHERE id=$1 RETURNING *",[id,did])).rows[0];
      await c.query("INSERT INTO audit_events(event_type,actor,detail) VALUES('PAIRING_CLAIMED',$1,$2)",[actor.address,{exchangeId:id,agentDid:did}]);
      return view(updated);
    });
  }

  private async bind(id:string,agentDid:string,manager:string,requestedScopes:string[],requestedTermSeconds:number,discoverable:boolean){
    return this.db.transaction(async c=>{
      await c.query("SELECT pg_advisory_xact_lock(hashtext($1))",[agentDid]);
      const exchange=(await c.query("SELECT * FROM pairing_exchanges WHERE id=$1 FOR UPDATE",[id])).rows[0];
      if(exchange?.state==="PAIRED"&&exchange.agent_did===agentDid&&exchange.manager_address===manager){
        const old=(await c.query("SELECT b.id AS binding_id,d.id AS draft_id FROM pairing_bindings b JOIN management_drafts d ON d.binding_id=b.id WHERE b.exchange_id=$1",[id])).rows[0];
        if(old)return {exchangeId:id,bindingId:old.binding_id,draftId:old.draft_id,state:"PAIRED",agentDid};
      }
      if(!exchange||exchange.agent_did!==agentDid||(exchange.manager_address&&exchange.manager_address!==manager)||!["CLAIMED","OPEN"].includes(exchange.state))throw fail("PAIRING_INVALID_OR_EXPIRED");
      if(new Date(exchange.kind==="platform-invitation"?exchange.completion_expires_at:exchange.expires_at).getTime()<Date.now())throw fail("PAIRING_INVALID_OR_EXPIRED");
      if(requestedScopes.some(s=>!(exchange.max_scopes as string[]).includes(s)))throw fail("PAIRING_SCOPE_EXCEEDED");
      if(requestedTermSeconds>exchange.max_term_seconds)throw fail("PAIRING_TERM_EXCEEDED");
      if(discoverable&&!exchange.discoverable)throw fail("PAIRING_VISIBILITY_EXCEEDED");
      const active=(await c.query("SELECT id FROM pairing_bindings WHERE agent_did=$1 AND state='ACTIVE' FOR UPDATE",[agentDid])).rows[0];
      if(active)throw conflict("PAIRING_CONFLICT");
      const bindingId=randomUUID(),draftId=randomUUID();
      await c.query("INSERT INTO pairing_bindings(id,exchange_id,agent_did,manager_address,max_scopes,max_term_seconds) VALUES($1,$2,$3,$4,$5,$6)",[bindingId,id,agentDid,manager,JSON.stringify(exchange.max_scopes),exchange.max_term_seconds]);
      await c.query("INSERT INTO management_drafts(id,binding_id,agent_did,manager_address,scopes,term_seconds,discoverable,state,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7,'AWAITING_WALLET_SIGNATURE',now()+interval '1 day')",[draftId,bindingId,agentDid,manager,JSON.stringify(requestedScopes),requestedTermSeconds,discoverable]);
      await c.query("UPDATE pairing_exchanges SET state='PAIRED',manager_address=$5,requested_scopes=$2,requested_term_seconds=$3,discoverable=$4,updated_at=now() WHERE id=$1",[id,JSON.stringify(requestedScopes),requestedTermSeconds,discoverable,manager]);
      await c.query("INSERT INTO audit_events(event_type,actor,detail) VALUES('PAIRING_COMPLETED',$1,$2)",[manager,{exchangeId:id,bindingId,draftId,agentDid}]);
      return {exchangeId:id,bindingId,draftId,state:"PAIRED",agentDid};
    });
  }
  async completeInvitation(auth:string|undefined,id:string){
    const actor=await this.platform.requireSession(auth,"agent"),did=toDid(5611,actor.address);
    const row=(await this.db.query("SELECT * FROM pairing_exchanges WHERE id=$1",[id]))[0];
    if(!row||row.agent_did!==did||row.kind!=="platform-invitation")throw new NotFoundException();
    const adapter=await this.chain.adapter(),identity=await adapter.readIdentity(actor.address),relationship=await adapter.readRelationship(actor.address);if(identity.status!=="ACTIVE")throw conflict("IDENTITY_NOT_ACTIVE");if(relationship.live)throw conflict("ACTIVE_MANAGEMENT_RELATIONSHIP");
    return this.bind(id,did,row.manager_address as string,row.max_scopes as string[],Number(row.max_term_seconds),Boolean(row.discoverable));
  }
  async redeemOffer(auth:string|undefined,id:string,input:RedeemInput){
    const actor=await this.platform.requireSession(auth,"manager");
    const prior=(await this.db.query("SELECT * FROM pairing_exchanges WHERE id=$1 AND kind='agent-offer'",[id]))[0];
    if(prior?.state==="PAIRED"&&prior.handle_hash===hash(input.handle)&&prior.manager_address===actor.address&&JSON.stringify(prior.requested_scopes)===JSON.stringify(scopes(input.requestedScopes))&&Number(prior.requested_term_seconds)===input.requestedTermSeconds&&prior.discoverable===input.discoverable)return this.bind(id,prior.agent_did as string,actor.address,prior.requested_scopes as string[],Number(prior.requested_term_seconds),Boolean(prior.discoverable));
    const row=await this.inspect(id,input.handle,"agent-offer");
    const agent=getAddress(String(row.agent_did).split(":").at(-1)!),adapter=await this.chain.adapter(),identity=await adapter.readIdentity(agent),relationship=await adapter.readRelationship(agent);
    if(identity.status!=="ACTIVE")throw conflict("IDENTITY_NOT_ACTIVE");if(relationship.live)throw conflict("ACTIVE_MANAGEMENT_RELATIONSHIP");
    const selected=scopes(input.requestedScopes),termSeconds=term(input.requestedTermSeconds);
    if(typeof input.discoverable!=="boolean")throw fail("INVALID_VISIBILITY");
    return this.bind(id,row.agent_did as string,actor.address,selected,termSeconds,input.discoverable);
  }
  async exchange(auth:string|undefined,id:string){
    const actor=await this.platform.requireSession(auth),row=(await this.db.query("SELECT * FROM pairing_exchanges WHERE id=$1",[id]))[0];
    if(!row||![row.creator,row.manager_address,String(row.agent_did||"").split(":").at(-1)].some(v=>typeof v==="string"&&v.toLowerCase()===actor.address.toLowerCase()))throw new NotFoundException();
    return view(row);
  }
  async cancel(auth:string|undefined,id:string){
    const actor=await this.platform.requireSession(auth),row=(await this.db.query("SELECT * FROM pairing_exchanges WHERE id=$1",[id]))[0];
    if(!row||row.creator.toLowerCase()!==actor.address.toLowerCase())throw new NotFoundException();
    if(row.state==="PAIRED")throw conflict("PAIRING_ALREADY_COMPLETED");
    await this.db.query("UPDATE pairing_exchanges SET state='CANCELLED',updated_at=now() WHERE id=$1 AND state IN ('OPEN','CLAIMED')",[id]);
    return this.exchange(auth,id);
  }
  async bindings(auth:string|undefined){const actor=await this.platform.requireSession(auth,"manager");return this.db.query("SELECT * FROM pairing_bindings WHERE manager_address=$1 AND state='ACTIVE' ORDER BY created_at DESC",[actor.address]);}
  async endBinding(auth:string|undefined,id:string){const actor=await this.platform.requireSession(auth,"manager"),binding=(await this.db.query("SELECT * FROM pairing_bindings WHERE id=$1 AND manager_address=$2 AND state='ACTIVE'",[id,actor.address]))[0];if(!binding)throw new NotFoundException();const agent=getAddress(String(binding.agent_did).split(":").at(-1)!),relationship=await(await this.chain.adapter()).readRelationship(agent);if(relationship.live&&getAddress(relationship.manager)===actor.address)throw conflict("ACTIVE_MANAGEMENT_RELATIONSHIP");await this.db.query("UPDATE pairing_bindings SET state='ENDED',ended_at=now() WHERE id=$1 AND manager_address=$2 AND state='ACTIVE'",[id,actor.address]);return {bindingId:id,state:"ENDED"};}
  async draft(auth:string|undefined,id:string){const actor=await this.platform.requireSession(auth,"manager");const row=(await this.db.query("SELECT * FROM management_drafts WHERE id=$1 AND manager_address=$2",[id,actor.address]))[0];if(!row)throw new NotFoundException();return row;}
  async createDraftIntent(auth:string|undefined,id:string){
    const draft=await this.draft(auth,id);
    if(new Date(draft.expires_at).getTime()<Date.now()||!["AWAITING_WALLET_SIGNATURE","WAITING_AGENT"].includes(draft.state))throw conflict("DRAFT_NOT_SIGNABLE");
    if(draft.intent_id){
      const old=(await this.db.query("SELECT expires_at FROM intents WHERE id=$1",[draft.intent_id]))[0];
      if(old&&new Date(old.expires_at).getTime()>Date.now()){
        if(draft.state!=="AWAITING_WALLET_SIGNATURE")throw conflict("DRAFT_WAITING_AGENT");
        return {draft,intent:await this.platform.getIntent(auth,draft.intent_id as string)};
      }
      await this.db.query("UPDATE management_drafts SET state='AWAITING_WALLET_SIGNATURE',intent_id=NULL,operation_id=NULL,updated_at=now() WHERE id=$1 AND intent_id=$2 AND state IN ('AWAITING_WALLET_SIGNATURE','WAITING_AGENT')",[id,draft.intent_id]);
    }
    const intent=await this.platform.managementIntent(auth,{agentDid:draft.agent_did as string,scopes:draft.scopes as string[],termSeconds:Number(draft.term_seconds),discoverable:Boolean(draft.discoverable)},900);
    await this.db.query("UPDATE management_drafts SET intent_id=$2,updated_at=now() WHERE id=$1 AND intent_id IS NULL AND state='AWAITING_WALLET_SIGNATURE'",[id,intent.intentId]);
    return {draftId:id,intent};
  }
  async signDraft(auth:string|undefined,id:string,intentId:string,signature:string){
    const draft=await this.draft(auth,id);
    if(draft.intent_id!==intentId||draft.state!=="AWAITING_WALLET_SIGNATURE")throw conflict("DRAFT_NOT_SIGNABLE");
    const result=await this.platform.addSignature(auth,intentId,{role:"manager",address:draft.manager_address as string,signature});
    await this.db.query("UPDATE management_drafts SET state='WAITING_AGENT',updated_at=now() WHERE id=$1",[id]);
    return {draftId:id,state:"WAITING_AGENT",receivedRoles:result.receivedRoles};
  }
  async retryFrozenDraft(auth:string|undefined,id:string){
    const draft=await this.draft(auth,id);
    if(draft.state!=="FROZEN_REORG")throw conflict("DRAFT_NOT_FROZEN");
    const agent=getAddress(String(draft.agent_did).split(":").at(-1)!);
    const adapter=await this.chain.adapter(),identity=await adapter.readIdentity(agent),relationship=await adapter.readRelationship(agent);
    if(identity.status!=="ACTIVE"||relationship.live)throw conflict("CHAIN_STATE_NOT_READY");
    await this.db.query("UPDATE management_drafts SET state='AWAITING_WALLET_SIGNATURE',intent_id=NULL,operation_id=NULL,updated_at=now() WHERE id=$1 AND state='FROZEN_REORG'",[id]);
    return {draftId:id,state:"AWAITING_WALLET_SIGNATURE"};
  }
  async nextRequest(auth:string|undefined){
    const actor=await this.platform.requireSession(auth,"agent"),did=toDid(5611,actor.address);
    const rows=await this.db.query("SELECT d.*,i.intent FROM management_drafts d JOIN intents i ON i.id=d.intent_id WHERE d.agent_did=$1 AND d.state='WAITING_AGENT' AND d.expires_at>now() AND i.expires_at>now() ORDER BY d.created_at LIMIT 1",[did]);
    return {request:rows[0]??null};
  }
  async decide(auth:string|undefined,id:string,input:{decision:string;signature?:string;reason?:string}){
    const actor=await this.platform.requireSession(auth,"agent"),did=toDid(5611,actor.address);
    const row=(await this.db.query("SELECT * FROM management_drafts WHERE id=$1 AND agent_did=$2",[id,did]))[0];
    if(!row||row.state!=="WAITING_AGENT")throw conflict("AGENT_REQUEST_NOT_PENDING");
    if(input.decision==="reject"){
      await this.db.query("UPDATE management_drafts SET state='REJECTED',updated_at=now() WHERE id=$1 AND state='WAITING_AGENT'",[id]);
      return {requestId:id,state:"REJECTED"};
    }
    if(input.decision!=="approve"||!input.signature)throw fail("AGENT_SIGNATURE_REQUIRED");
    await this.platform.addSignature(auth,row.intent_id as string,{role:"agent",address:actor.address,signature:input.signature});
    const operation=await this.platform.submitManagement(auth,{intentId:row.intent_id as string},`draft:${id}`);
    await this.db.query("UPDATE management_drafts SET state='SUBMITTED',operation_id=$2,updated_at=now() WHERE id=$1",[id,operation.operationId]);
    return {requestId:id,state:"SUBMITTED",operation};
  }
}
