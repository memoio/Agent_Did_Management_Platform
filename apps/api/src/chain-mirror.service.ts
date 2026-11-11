import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from "@nestjs/common";
import { getAddress } from "ethers";
import { PlatformDb } from "./db.js";
import { ChainService } from "./chain.service.js";

const didPattern=/^did:memo:agent:5611:0x[0-9a-fA-F]{40}$/;
const hashPattern=/^0x[0-9a-fA-F]{64}$/;
const eventTypes=new Set(["AgentRegistered","ProfileUpdated","DocumentUpdated","AgentStatusChanged","InstanceCredentialRevoked","RelationshipActivated","RelationshipRenewed","RelationshipEnded","RelationshipTransferred"]);
function limit(value:string|undefined){
  const n=value===undefined?50:Number(value);
  if(!Number.isSafeInteger(n)||n<1||n>100)throw new BadRequestException({code:"INVALID_LIMIT"});
  return n;
}
function did(value:string){if(!didPattern.test(value))throw new BadRequestException({code:"INVALID_DID"});return value.toLowerCase();}
function deployment(){
  const id=process.env.MEMO_DEPLOYMENT_ID;
  if(!id)throw new ServiceUnavailableException({code:"DEPLOYMENT_NOT_CONFIGURED"});
  return id;
}
function identity(row:Record<string,unknown>|undefined){
  if(!row)return null;
  return {identityAccount:row.identity_account,status:row.status,revision:String(row.revision),nonce:String(row.nonce),identityPublicKeyHash:row.identity_public_key_hash,documentHash:row.document_hash,profileHash:row.profile_hash,source:{blockNumber:Number(row.source_block_number),blockHash:row.source_block_hash,txHash:row.source_tx_hash,logIndex:row.source_log_index,blockTimestamp:Number(row.source_block_timestamp)}};
}
function relationship(row:Record<string,unknown>|undefined,identityStatus:string|undefined){
  if(!row)return null;
  return {manager:row.manager_address,relationshipIdHash:row.relationship_id_hash,scopesHash:row.scopes_hash,expiresAt:String(row.expires_at),discoverable:row.discoverable,ended:row.ended,revision:String(row.revision),nonce:String(row.nonce),live:identityStatus==="ACTIVE" && row.ended===false && BigInt(String(row.expires_at))>BigInt(Math.floor(Date.now()/1000)),source:{blockNumber:Number(row.source_block_number),blockHash:row.source_block_hash,txHash:row.source_tx_hash,logIndex:row.source_log_index,blockTimestamp:Number(row.source_block_timestamp)}};
}

@Injectable()
export class ChainMirrorService {
  constructor(private readonly db:PlatformDb,private readonly chain:ChainService){}

  async status(){
    const id=deployment();
    const rows=await this.db.query(`SELECT p.block_number,p.block_hash,p.finalized_block_number,p.finalized_block_hash,p.updated_at,c.block_number AS cursor_block_number,(SELECT count(*) FROM chain_events WHERE deployment_id=$1) AS event_count,(SELECT count(*) FROM chain_identity_mirror WHERE deployment_id=$1) AS agent_count,(SELECT count(*) FROM chain_relationship_mirror WHERE deployment_id=$1) AS relationship_count,(SELECT count(*) FROM chain_revoked_credential_mirror WHERE deployment_id=$1) AS revoked_credential_count FROM chain_projection_checkpoint p JOIN index_cursor c USING(deployment_id) WHERE p.deployment_id=$1`,[id]);
    const r=rows[0];
    const finalized=r?.finalized_block_number===null||!r?null:Number(r.finalized_block_number);
    const indexed=r?Number(r.block_number):null;
    return {deploymentId:id,state:!r?"NOT_INDEXED":Number(r.block_number)===Number(r.cursor_block_number)?"READY":"OUT_OF_SYNC",indexedBlockNumber:indexed,indexedBlockHash:r?.block_hash??null,finalizedBlockNumber:finalized,finalizedBlockHash:r?.finalized_block_hash??null,blocksBehindFinalized:indexed===null||finalized===null?null:Math.max(0,finalized-indexed),caughtUpToFinalized:indexed===null||finalized===null?null:indexed>=finalized,updatedAt:r?.updated_at??null,counts:r?{events:Number(r.event_count),agents:Number(r.agent_count),relationships:Number(r.relationship_count),revokedCredentials:Number(r.revoked_credential_count)}:null};
  }

  async agents(query:{did?:string;status?:string;manager?:string;limit?:string;after?:string}){
    const id=deployment(), count=limit(query.limit);
    const filters:string[]=[];const values:unknown[]=[id];
    if(query.did){values.push(did(query.did));filters.push(`i.agent_did=$${values.length}`);}
    if(query.status){if(!["ACTIVE","SUSPENDED","REVOKED"].includes(query.status))throw new BadRequestException({code:"INVALID_STATUS"});values.push(query.status);filters.push(`i.status=$${values.length}`);}
    if(query.manager){try{values.push(getAddress(query.manager).toLowerCase());}catch{throw new BadRequestException({code:"INVALID_MANAGER"});}filters.push(`lower(r.manager_address)=$${values.length}`);}
    if(query.after){values.push(did(query.after));filters.push(`i.agent_did>$${values.length}`);}
    values.push(count);
    const rows=await this.db.query(`SELECT i.*,r.manager_address,r.relationship_id_hash,r.scopes_hash,r.expires_at,r.discoverable,r.ended,r.revision AS relationship_revision,r.nonce AS relationship_nonce,r.source_block_number AS relationship_block_number FROM chain_identity_mirror i LEFT JOIN chain_relationship_mirror r ON r.deployment_id=i.deployment_id AND r.agent_did=i.agent_did WHERE i.deployment_id=$1 ${filters.map(f=>`AND ${f}`).join(" ")} ORDER BY i.agent_did LIMIT $${values.length}`,values);
    return {deploymentId:id,items:rows.map(r=>({agentDid:r.agent_did,identity:identity(r),relationship:r.manager_address?{manager:r.manager_address,relationshipIdHash:r.relationship_id_hash,scopesHash:r.scopes_hash,expiresAt:String(r.expires_at),discoverable:r.discoverable,ended:r.ended,revision:String(r.relationship_revision),nonce:String(r.relationship_nonce),live:r.status==="ACTIVE"&&!r.ended&&BigInt(String(r.expires_at))>BigInt(Math.floor(Date.now()/1000)),sourceBlockNumber:Number(r.relationship_block_number)}:null})),nextAfter:rows.length===count?rows.at(-1)?.agent_did:null};
  }

  async agent(agentDid:string){
    const id=deployment(), value=did(agentDid);
    const [i,r,revoked,checkpoint]=await this.db.transaction(async c=>{
      await c.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY");
      return [
        (await c.query("SELECT * FROM chain_identity_mirror WHERE deployment_id=$1 AND agent_did=$2",[id,value])).rows,
        (await c.query("SELECT * FROM chain_relationship_mirror WHERE deployment_id=$1 AND agent_did=$2",[id,value])).rows,
        (await c.query("SELECT credential_id_hash,revision::text,source_block_number,source_block_hash,source_tx_hash,source_log_index FROM chain_revoked_credential_mirror WHERE deployment_id=$1 AND agent_did=$2 ORDER BY source_block_number,source_log_index",[id,value])).rows,
        (await c.query("SELECT block_number,block_hash,finalized_block_number FROM chain_projection_checkpoint WHERE deployment_id=$1",[id])).rows,
      ] as const;
    });
    if(!i[0])throw new NotFoundException({code:"MIRROR_AGENT_NOT_FOUND"});
    const finalized=checkpoint[0]?.finalized_block_number===null||!checkpoint[0]?null:Number(checkpoint[0].finalized_block_number);
    return {deploymentId:id,agentDid:value,indexedBlockNumber:checkpoint[0]?Number(checkpoint[0].block_number):null,indexedBlockHash:checkpoint[0]?.block_hash??null,finalizedBlockNumber:finalized,identity:identity(i[0]),identityFinalized:finalized!==null&&Number(i[0].source_block_number)<=finalized,relationship:relationship(r[0],i[0].status),relationshipFinalized:r[0]?finalized!==null&&Number(r[0].source_block_number)<=finalized:null,revokedCredentials:revoked.map(x=>({credentialIdHash:x.credential_id_hash,revision:x.revision,finalized:finalized!==null&&Number(x.source_block_number)<=finalized,source:{blockNumber:Number(x.source_block_number),blockHash:x.source_block_hash,txHash:x.source_tx_hash,logIndex:x.source_log_index}}))};
  }

  async events(query:{agentDid?:string;eventType?:string;txHash?:string;limit?:string;beforeBlock?:string;beforeLogIndex?:string}){
    const id=deployment(), count=limit(query.limit), values:unknown[]=[id], filters:string[]=[];
    if(query.agentDid){values.push(did(query.agentDid));filters.push(`agent_did=$${values.length}`);}
    if(query.eventType){if(!eventTypes.has(query.eventType))throw new BadRequestException({code:"INVALID_EVENT_TYPE"});values.push(query.eventType);filters.push(`event->>'eventType'=$${values.length}`);}
    if(query.txHash){if(!hashPattern.test(query.txHash))throw new BadRequestException({code:"INVALID_TX_HASH"});values.push(query.txHash.toLowerCase());filters.push(`lower(tx_hash)=$${values.length}`);}
    if(query.beforeBlock!==undefined){const block=Number(query.beforeBlock),log=Number(query.beforeLogIndex??2147483647);if(!Number.isSafeInteger(block)||block<0||!Number.isSafeInteger(log)||log<0)throw new BadRequestException({code:"INVALID_CURSOR"});values.push(block,log);filters.push(`(block_number,log_index)<($${values.length-1},$${values.length})`);}
    values.push(count);
    const rows=await this.db.query(`SELECT event FROM chain_events WHERE deployment_id=$1 ${filters.map(f=>`AND ${f}`).join(" ")} ORDER BY block_number DESC,log_index DESC LIMIT $${values.length}`,values);
    return {deploymentId:id,items:rows.map(r=>r.event),nextCursor:rows.length===count?{beforeBlock:rows.at(-1)?.event.blockNumber,beforeLogIndex:rows.at(-1)?.event.logIndex}:null};
  }

  async verify(agentDid:string){
    const mirror=await this.agent(agentDid);
    if(mirror.indexedBlockNumber===null)throw new ServiceUnavailableException({code:"MIRROR_NOT_INDEXED"});
    const address=mirror.agentDid.split(":").at(-1)!;
    const adapter=await this.chain.adapter();
    // The configured public RPCs can verify old block hashes but may not serve historical eth_call.
    // Compare latest state only when its revisions have not advanced beyond the mirror.
    const [block,onChainIdentity,onChainRelationship]=await Promise.all([adapter.readBlock(mirror.indexedBlockNumber),adapter.readIdentity(address),adapter.readRelationship(address)]);
    if(block.blockHash!==mirror.indexedBlockHash)throw new ServiceUnavailableException({code:"MIRROR_BLOCK_REORGED"});
    const identityAhead=BigInt(onChainIdentity.revision)>BigInt(mirror.identity!.revision as string);
    const relationshipAhead=BigInt(onChainRelationship.revision)>BigInt(mirror.relationship?.revision??"0");
    if(identityAhead||relationshipAhead)return {deploymentId:mirror.deploymentId,agentDid:mirror.agentDid,indexedBlockNumber:mirror.indexedBlockNumber,indexedBlockHash:block.blockHash,chainBlockNumber:Math.max(onChainIdentity.source.blockNumber,onChainRelationship.source.blockNumber),state:"CHAIN_AHEAD",matches:null,differences:[]};
    const equal=(a:unknown,b:unknown)=>String(a).toLowerCase()===String(b).toLowerCase();
    const diffs:string[]=[];
    for(const key of ["status","revision","nonce","identityPublicKeyHash","documentHash","profileHash"] as const)if(!equal(mirror.identity?.[key],onChainIdentity[key]))diffs.push(`identity.${key}`);
    const rel=mirror.relationship;
    if(rel){
      for(const [key,chainKey] of [["manager","manager"],["relationshipIdHash","relationshipIdHash"],["scopesHash","scopesHash"],["expiresAt","expiresAt"],["discoverable","discoverable"],["ended","ended"],["revision","revision"],["nonce","nonce"]] as const)
        if(!equal(rel[key],onChainRelationship[chainKey]))diffs.push(`relationship.${key}`);
    }else if(onChainRelationship.revision!=="0")diffs.push("relationship.missing");
    return {deploymentId:mirror.deploymentId,agentDid:mirror.agentDid,indexedBlockNumber:mirror.indexedBlockNumber,indexedBlockHash:block.blockHash,chainBlockNumber:Math.max(onChainIdentity.source.blockNumber,onChainRelationship.source.blockNumber),state:diffs.length?"MISMATCH":"MATCH",matches:diffs.length===0,differences:diffs};
  }
}
