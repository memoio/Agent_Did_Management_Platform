import type { PoolClient } from "pg";

export type IndexedEvent = {
  deploymentId:string; agentDid:string; eventType:string; revision:string; nonce:string;
  blockNumber:number; blockHash:string; txHash:string; logIndex:number; blockTimestamp:number;
  payload:Record<string,unknown>;
};

function field(event:IndexedEvent,name:string):string {
  const value=event.payload[name];
  if(typeof value!=="string" || !value)throw Error(`MIRROR_INVALID_${name}`);
  return value;
}
function bool(event:IndexedEvent,name:string):boolean {
  const value=event.payload[name];
  if(typeof value!=="boolean")throw Error(`MIRROR_INVALID_${name}`);
  return value;
}
function source(event:IndexedEvent){return [event.blockNumber,event.blockHash,event.txHash,event.logIndex,event.blockTimestamp];}
function sequence(event:IndexedEvent,previous:{revision:string;nonce:string}|undefined){
  const revision=BigInt(event.revision), nonce=BigInt(event.nonce);
  if(previous){
    if(revision!==BigInt(previous.revision)+1n || nonce!==BigInt(previous.nonce))throw Error("MIRROR_EVENT_GAP");
  }else if(revision!==1n || nonce!==0n)throw Error("MIRROR_EVENT_GAP");
  return (nonce+1n).toString();
}

export async function applyChainEvent(c:PoolClient,event:IndexedEvent):Promise<void>{
  const identity=["AgentRegistered","ProfileUpdated","DocumentUpdated","AgentStatusChanged","InstanceCredentialRevoked"].includes(event.eventType);
  const table=identity?"chain_identity_mirror":"chain_relationship_mirror";
  const previous=(await c.query(`SELECT revision::text,nonce::text${identity?"":",manager_address,relationship_id_hash"} FROM ${table} WHERE deployment_id=$1 AND agent_did=$2 FOR UPDATE`,[event.deploymentId,event.agentDid])).rows[0] as {revision:string;nonce:string;manager_address?:string;relationship_id_hash?:string}|undefined;
  const nextNonce=sequence(event,previous);
  const common=[event.deploymentId,event.agentDid,event.revision,nextNonce,...source(event)];
  if(event.eventType==="AgentRegistered"){
    if(previous)throw Error("MIRROR_DUPLICATE_REGISTRATION");
    await c.query(`INSERT INTO chain_identity_mirror(deployment_id,agent_did,revision,nonce,source_block_number,source_block_hash,source_tx_hash,source_log_index,source_block_timestamp,identity_account,status,identity_public_key_hash,document_hash,profile_hash)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'ACTIVE',$11,$12,$13)`,[...common,field(event,"identityAccount"),field(event,"identityPublicKeyHash"),field(event,"documentHash"),field(event,"profileHash")]);
  }else if(["ProfileUpdated","DocumentUpdated","AgentStatusChanged","InstanceCredentialRevoked"].includes(event.eventType)){
    if(!previous)throw Error("MIRROR_IDENTITY_MISSING");
    const change=event.eventType==="ProfileUpdated"?["profile_hash",field(event,"profileHash")]
      :event.eventType==="DocumentUpdated"?["document_hash",field(event,"documentHash")]
      :event.eventType==="AgentStatusChanged"?["status",field(event,"status")]:null;
    if(change && change[0]==="status" && !["ACTIVE","SUSPENDED","REVOKED"].includes(change[1]))throw Error("MIRROR_INVALID_STATUS");
    await c.query(`UPDATE chain_identity_mirror SET revision=$3,nonce=$4,source_block_number=$5,source_block_hash=$6,source_tx_hash=$7,source_log_index=$8,source_block_timestamp=$9,updated_at=now()${change?`,${change[0]}=$10`:""} WHERE deployment_id=$1 AND agent_did=$2`,change?[...common,change[1]]:common);
    if(event.eventType==="InstanceCredentialRevoked")await c.query(`INSERT INTO chain_revoked_credential_mirror(deployment_id,agent_did,credential_id_hash,revision,source_block_number,source_block_hash,source_tx_hash,source_log_index,source_block_timestamp) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING`,[event.deploymentId,event.agentDid,field(event,"credentialIdHash"),event.revision,...source(event)]);
  }else if(["RelationshipActivated","RelationshipRenewed","RelationshipTransferred"].includes(event.eventType)){
    if(event.eventType!=="RelationshipActivated" && !previous)throw Error("MIRROR_RELATIONSHIP_MISSING");
    if(event.eventType==="RelationshipTransferred" && (previous?.manager_address?.toLowerCase()!==field(event,"oldManager").toLowerCase() || previous?.relationship_id_hash!==field(event,"oldRelationshipIdHash")))throw Error("MIRROR_RELATIONSHIP_MISMATCH");
    if(event.eventType==="RelationshipRenewed" && (previous?.manager_address?.toLowerCase()!==field(event,"manager").toLowerCase() || previous?.relationship_id_hash!==field(event,"relationshipIdHash")))throw Error("MIRROR_RELATIONSHIP_MISMATCH");
    const manager=field(event,event.eventType==="RelationshipTransferred"?"newManager":"manager");
    const relationshipIdHash=field(event,event.eventType==="RelationshipTransferred"?"newRelationshipIdHash":"relationshipIdHash");
    const values=[...common,manager,relationshipIdHash,field(event,"scopesHash"),field(event,"expiresAt"),bool(event,"discoverable")];
    await c.query(`INSERT INTO chain_relationship_mirror(deployment_id,agent_did,revision,nonce,source_block_number,source_block_hash,source_tx_hash,source_log_index,source_block_timestamp,manager_address,relationship_id_hash,scopes_hash,expires_at,discoverable,ended)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,false)
      ON CONFLICT(deployment_id,agent_did) DO UPDATE SET revision=excluded.revision,nonce=excluded.nonce,source_block_number=excluded.source_block_number,source_block_hash=excluded.source_block_hash,source_tx_hash=excluded.source_tx_hash,source_log_index=excluded.source_log_index,source_block_timestamp=excluded.source_block_timestamp,manager_address=excluded.manager_address,relationship_id_hash=excluded.relationship_id_hash,scopes_hash=excluded.scopes_hash,expires_at=excluded.expires_at,discoverable=excluded.discoverable,ended=false,updated_at=now()`,values);
  }else if(event.eventType==="RelationshipEnded"){
    if(!previous)throw Error("MIRROR_RELATIONSHIP_MISSING");
    const changed=await c.query(`UPDATE chain_relationship_mirror SET revision=$3,nonce=$4,source_block_number=$5,source_block_hash=$6,source_tx_hash=$7,source_log_index=$8,source_block_timestamp=$9,ended=true,updated_at=now() WHERE deployment_id=$1 AND agent_did=$2 AND lower(manager_address)=lower($10) AND relationship_id_hash=$11`,[...common,field(event,"manager"),field(event,"relationshipIdHash")]);
    if(changed.rowCount!==1)throw Error("MIRROR_RELATIONSHIP_MISMATCH");
  }else throw Error(`MIRROR_UNKNOWN_EVENT_${event.eventType}`);
}

export async function clearProjection(c:PoolClient,deploymentId:string){
  for(const table of ["chain_revoked_credential_mirror","chain_relationship_mirror","chain_identity_mirror","chain_projection_checkpoint"])
    await c.query(`DELETE FROM ${table} WHERE deployment_id=$1`,[deploymentId]);
}

export async function rebuildProjection(c:PoolClient,deploymentId:string){
  await clearProjection(c,deploymentId);
  const rows=(await c.query("SELECT event FROM chain_events WHERE deployment_id=$1 ORDER BY block_number,log_index",[deploymentId])).rows;
  for(const row of rows)await applyChainEvent(c,row.event as IndexedEvent);
}
