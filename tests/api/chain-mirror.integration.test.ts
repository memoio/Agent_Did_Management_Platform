import "reflect-metadata";
import { expect, it } from "vitest";
import { PlatformDb } from "../../apps/api/src/db.js";
import { ChainMirrorService } from "../../apps/api/src/chain-mirror.service.js";
import { applyChainEvent, clearProjection, rebuildProjection, type IndexedEvent } from "../../apps/chain-worker/src/projection.js";
import type { ChainService } from "../../apps/api/src/chain.service.js";

const run=process.env.TEST_DATABASE_URL?it:it.skip;
const deploymentId="mirror-integration-5611";
const address="0x1111111111111111111111111111111111111111";
const manager="0x2222222222222222222222222222222222222222";
const nextManager="0x3333333333333333333333333333333333333333";
const agentDid=`did:memo:agent:5611:${address}`;
const hash=(n:number)=>`0x${n.toString(16).padStart(64,"0")}`;
function event(eventType:string,revision:number,nonce:number,payload:Record<string,unknown>,blockNumber:number):IndexedEvent{
  return {deploymentId,agentDid,eventType,revision:String(revision),nonce:String(nonce),payload,blockNumber,blockHash:hash(blockNumber),txHash:hash(blockNumber+1000),logIndex:0,blockTimestamp:1700000000+blockNumber};
}
const examples=[
  event("AgentRegistered",1,0,{identityAccount:address,identityPublicKeyHash:hash(1),documentHash:hash(2),profileHash:hash(3)},10),
  event("ProfileUpdated",2,1,{profileHash:hash(4)},11),
  event("DocumentUpdated",3,2,{documentHash:hash(5)},12),
  event("InstanceCredentialRevoked",4,3,{credentialIdHash:hash(6)},13),
  event("AgentStatusChanged",5,4,{status:"SUSPENDED"},14),
  event("AgentStatusChanged",6,5,{status:"ACTIVE"},15),
  event("RelationshipActivated",1,0,{manager,relationshipIdHash:hash(7),scopesHash:hash(8),expiresAt:"9999999999",discoverable:true},16),
  event("RelationshipRenewed",2,1,{manager,relationshipIdHash:hash(7),scopesHash:hash(9),expiresAt:"9999999999",discoverable:false},17),
  event("RelationshipTransferred",3,2,{oldManager:manager,newManager:nextManager,oldRelationshipIdHash:hash(7),newRelationshipIdHash:hash(10),scopesHash:hash(9),expiresAt:"9999999999",discoverable:true},18),
  event("RelationshipEnded",4,3,{manager:nextManager,relationshipIdHash:hash(10),actor:nextManager,reasonHash:hash(11)},19),
  event("RelationshipActivated",5,4,{manager,relationshipIdHash:hash(12),scopesHash:hash(13),expiresAt:"9999999999",discoverable:true},20),
];

run("mirrors every contract state transition, replays retained events and exposes searchable evidence",async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  process.env.MEMO_DEPLOYMENT_ID=deploymentId;
  const db=new PlatformDb();await db.init();
  await db.transaction(async c=>{
    await clearProjection(c,deploymentId);
    await c.query("DELETE FROM chain_events WHERE deployment_id=$1",[deploymentId]);
    await c.query("DELETE FROM index_cursor WHERE deployment_id=$1",[deploymentId]);
  });
  try{
    await db.transaction(async c=>{
      for(const item of examples){
        await c.query("INSERT INTO chain_events(deployment_id,block_hash,tx_hash,log_index,block_number,agent_did,event) VALUES($1,$2,$3,$4,$5,$6,$7)",[deploymentId,item.blockHash,item.txHash,item.logIndex,item.blockNumber,item.agentDid,item]);
        await applyChainEvent(c,item);
      }
      await c.query("INSERT INTO index_cursor(deployment_id,block_number,block_hash) VALUES($1,20,$2)",[deploymentId,hash(20)]);
      await c.query("INSERT INTO chain_projection_checkpoint(deployment_id,block_number,block_hash,finalized_block_number,finalized_block_hash) VALUES($1,20,$2,19,$3)",[deploymentId,hash(20),hash(19)]);
    });
    const chain={adapter:async()=>({
      readBlock:async(n:number)=>({blockNumber:n,blockHash:hash(n)}),
      readIdentity:async()=>({status:"ACTIVE",revision:"6",nonce:"6",identityPublicKeyHash:hash(1),documentHash:hash(5),profileHash:hash(4),source:{blockNumber:20}}),
      readRelationship:async()=>({manager,relationshipIdHash:hash(12),scopesHash:hash(13),expiresAt:"9999999999",discoverable:true,ended:false,revision:"5",nonce:"5",source:{blockNumber:20}}),
    })} as unknown as ChainService;
    const service=new ChainMirrorService(db,chain);
    const before=await service.agent(agentDid);
    expect(before.identity).toMatchObject({status:"ACTIVE",revision:"6",nonce:"6",profileHash:hash(4),documentHash:hash(5)});
    expect(before.relationship).toMatchObject({manager,revision:"5",nonce:"5",ended:false,live:true});
    expect(before.revokedCredentials).toHaveLength(1);
    expect((await service.agents({manager,status:"ACTIVE"})).items).toHaveLength(1);
    expect((await service.agents({manager:nextManager})).items).toHaveLength(0);
    expect((await service.agents({manager})).items).toHaveLength(1);
    expect((await service.events({agentDid,eventType:"RelationshipEnded"})).items).toHaveLength(1);
    expect((await service.status()).counts).toMatchObject({events:11,agents:1,relationships:1,revokedCredentials:1});
    expect((await service.verify(agentDid)).differences).toEqual([]);
    await db.transaction(async c=>{
      await rebuildProjection(c,deploymentId);
      await c.query("INSERT INTO chain_projection_checkpoint(deployment_id,block_number,block_hash,finalized_block_number,finalized_block_hash) VALUES($1,20,$2,19,$3)",[deploymentId,hash(20),hash(19)]);
    });
    const after=await service.agent(agentDid);
    expect(after.identity).toEqual(before.identity);
    expect(after.relationship).toEqual(before.relationship);
    await expect(db.transaction(async c=>applyChainEvent(c,event("ProfileUpdated",8,6,{profileHash:hash(30)},21)))).rejects.toThrow("MIRROR_EVENT_GAP");
    expect((await service.agent(agentDid)).identity?.revision).toBe("6");
    const incomplete=event("ProfileUpdated",8,6,{profileHash:hash(30)},21);
    await expect(db.transaction(async c=>{
      await c.query("INSERT INTO chain_events(deployment_id,block_hash,tx_hash,log_index,block_number,agent_did,event) VALUES($1,$2,$3,$4,$5,$6,$7)",[deploymentId,incomplete.blockHash,incomplete.txHash,incomplete.logIndex,incomplete.blockNumber,incomplete.agentDid,incomplete]);
      await applyChainEvent(c,incomplete);
      await c.query("UPDATE index_cursor SET block_number=21,block_hash=$2 WHERE deployment_id=$1",[deploymentId,hash(21)]);
    })).rejects.toThrow("MIRROR_EVENT_GAP");
    expect((await service.status()).indexedBlockNumber).toBe(20);
    expect((await service.status()).counts?.events).toBe(11);
    await db.transaction(async c=>{await clearProjection(c,deploymentId);await c.query("DELETE FROM chain_events WHERE deployment_id=$1",[deploymentId]);await c.query("DELETE FROM index_cursor WHERE deployment_id=$1",[deploymentId]);});
    expect((await service.status()).state).toBe("NOT_INDEXED");
  }finally{await db.close();}
});
