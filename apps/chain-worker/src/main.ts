import { configuredChain, readNextWindow, type Intent, type ActionSignature } from "../../../packages/chain-adapter/src/index.js";
import { PlatformDb } from "../../api/src/db.js";
import { applyChainEvent, clearProjection, rebuildProjection, type IndexedEvent } from "./projection.js";

const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const db=new PlatformDb();
const indexOnly=process.argv.includes("--index-only");
const once=process.argv.includes("--once");
if(once&&!indexOnly)throw new Error("ONCE_REQUIRES_INDEX_ONLY");
const chain=await configuredChain();
if(!indexOnly&&!chain.writesEnabled) throw new Error("CHAIN_WRITES_DISABLED");
const adapter=chain.adapter;
await db.init();
if(indexOnly)await adapter.verifyDeployment();
else await adapter.readiness();
let running=true;
process.on("SIGTERM",()=>{running=false;});
process.on("SIGINT",()=>{running=false;});

async function submitOne(){
  const rows=await db.query("SELECT o.id,o.request_id,i.intent FROM operations o JOIN intents i ON i.id=o.intent_id WHERE o.state='SIGNED' ORDER BY o.created_at LIMIT 1");
  const r=rows[0];if(!r)return;
  const sigs=await db.query("SELECT role,address,signature FROM intent_signatures WHERE intent_id=$1",[(r.intent as Intent).intentId]);
  try {
    const result=await adapter.submitSignedAction(r.intent as Intent,sigs as ActionSignature[],r.request_id as string);
    await db.transaction(async c=>{
      const updated=await c.query("UPDATE operations SET state='SUBMITTED',submission_id=$2,tx_hash=$3,updated_at=now() WHERE id=$1 AND state='SIGNED' RETURNING id,intent_id",[r.id,result.submissionId,result.txHash]);
      if(updated.rowCount)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,'TRANSACTION_SUBMITTED',$3)",[r.id,updated.rows[0].intent_id,{submissionId:result.submissionId,txHash:result.txHash}]);
    });
  } catch(error){
    const code=(error as {code?:string}).code;
    if(["SUBMISSION_UNKNOWN","CHAIN_UNAVAILABLE","CHAIN_STATE_UNCERTAIN"].includes(code||""))return;
    await db.transaction(async c=>{
      const updated=await c.query("UPDATE operations SET state='FAILED',error_code=$2,updated_at=now() WHERE id=$1 AND state='SIGNED' RETURNING intent_id",[r.id,code||"SUBMISSION_FAILED"]);
      if(updated.rowCount)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,'OPERATION_FAILED',$3)",[r.id,updated.rows[0].intent_id,{code:code||"SUBMISSION_FAILED"}]);
    });
  }
}

async function track(){
  const rows=await db.query("SELECT o.*,i.intent FROM operations o JOIN intents i ON i.id=o.intent_id WHERE o.state IN ('SUBMITTED','INCLUDED') ORDER BY o.updated_at LIMIT 30");
  for(const r of rows){
    if(!r.submission_id)continue;
    try {
      const result=await adapter.getSubmission(r.submission_id as string);
      if(result.state==="REVERTED"){
        const block=await adapter.readBlock(result.blockNumber);
        if(block.blockHash!==result.blockHash)continue;
        const expired=BigInt(block.timestamp)>BigInt((r.intent as Intent).message.deadline as string);
        const errorCode=expired?"ACTION_EXPIRED":"CONTRACT_REVERT";
        await db.transaction(async c=>{
          const updated=await c.query("UPDATE operations SET state='FAILED',error_code=$2,block_number=$3,block_hash=$4,updated_at=now() WHERE id=$1 AND state IN ('SUBMITTED','INCLUDED') RETURNING intent_id",[r.id,errorCode,result.blockNumber,result.blockHash]);
          if(updated.rowCount)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,'OPERATION_FAILED',$3)",[r.id,updated.rows[0].intent_id,{code:errorCode,blockHash:result.blockHash}]);
        });
      }else if(result.state==="INCLUDED"){
        const state=result.confirmed?"CONFIRMED":"INCLUDED";
        await db.transaction(async c=>{
          const updated=await c.query("UPDATE operations SET state=$2,block_number=$3,block_hash=$4,confirmations=greatest(confirmations,$5),finality_source=$6,updated_at=now() WHERE id=$1 AND state IN ('SUBMITTED','INCLUDED') RETURNING intent_id",[r.id,state,result.blockNumber,result.blockHash,result.confirmations,result.finalitySource]);
          if(!updated.rowCount)return;
          if(r.state!==state)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,$3,$4)",[r.id,updated.rows[0].intent_id,state==="CONFIRMED"?"OPERATION_CONFIRMED":"TRANSACTION_INCLUDED",{txHash:result.txHash,blockNumber:result.blockNumber,blockHash:result.blockHash,finalitySource:result.finalitySource}]);
          if(state==="CONFIRMED" && ["RegisterAgent","UpdateProfile","UpdateDocument"].includes(r.action_type)){
            await c.query("UPDATE agent_document_versions SET confirmed_at=now() WHERE intent_id=$1",[r.intent_id]);
          }
          if(state==="CONFIRMED" && r.action_type==="RevokeInstanceCredential"){
            const record=(await c.query("SELECT context FROM intents WHERE id=$1",[r.intent_id])).rows[0];
            const instanceId=record?.context?.credentialId;
            if(instanceId)await c.query("UPDATE agent_instances SET state='REVOKED' WHERE instance_id=$1 AND agent_did=$2",[instanceId,r.agent_did]);
          }
          if(state==="CONFIRMED" && r.action_type==="ActivateRelationship")await c.query("UPDATE management_drafts SET state='CONFIRMED',updated_at=now() WHERE operation_id=$1 AND state='SUBMITTED'",[r.id]);
        });
      }
    }catch(error){
      const code=(error as {code?:string}).code;
      if(code==="CHAIN_STATE_UNCERTAIN" && r.block_number && r.block_hash){
        try {
          const canonical=await adapter.readBlock(Number(r.block_number));
          if(canonical.blockHash!==r.block_hash)await db.transaction(async c=>{
            const updated=await c.query("UPDATE operations SET state='REORGED',error_code='CHAIN_REORG',updated_at=now() WHERE id=$1 AND state IN ('SUBMITTED','INCLUDED') RETURNING intent_id",[r.id]);
            if(updated.rowCount)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,'OPERATION_REORGED',$3)",[r.id,updated.rows[0].intent_id,{previousBlockHash:r.block_hash,canonicalBlockHash:canonical.blockHash}]);
          });
        }catch{/* keep prior evidence until both RPCs agree */}
      }
    }
  }
}

async function index():Promise<boolean>{
  const id=adapter.manifest.deploymentId;
  const earliest=Math.min(adapter.manifest.contracts.didRegistry.deploymentBlockNumber,adapter.manifest.contracts.managementRegistry.deploymentBlockNumber);
  let rows=await db.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1",[id]);
  if(!rows[0]){
    const start=await adapter.readBlock(earliest-1);
    await db.query("INSERT INTO index_cursor(deployment_id,block_number,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[id,start.blockNumber,start.blockHash]);
    rows=await db.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1",[id]);
  }
  let next:Awaited<ReturnType<typeof readNextWindow>>;
  // A remote testnet can advance thousands of blocks while the Worker is offline.
  // The adapter still splits this bounded window into small dual-RPC log requests.
  try{next=await readNextWindow(adapter,{blockNumber:Number(rows[0].block_number),blockHash:rows[0].block_hash as string},2000);}
  catch(error){
    if((error as {code?:string}).code!=="CHAIN_STATE_UNCERTAIN")throw error;
    // A transient RPC failure leaves the cursor untouched. Rewind only after both RPCs
    // agree that the stored cursor block has a different canonical hash.
    const canonical=await adapter.readBlock(Number(rows[0].block_number));
    if(canonical.blockHash===rows[0].block_hash)throw error;
    const affected=await db.query("SELECT id,intent_id,agent_did,action_type,block_number,block_hash,state FROM operations WHERE block_number IS NOT NULL AND state IN ('INCLUDED','CONFIRMED')");
    const orphaned:typeof affected=[];
    for(const operation of affected){
      const block=await adapter.readBlock(Number(operation.block_number));
      if(block.blockHash!==operation.block_hash){
        if(Number(rows[0].block_number)-Number(operation.block_number)>adapter.manifest.finality.maxReorgDepth)throw Error("REORG_DEPTH_EXCEEDED");
        orphaned.push(operation);
      }
    }
    const start=await adapter.readBlock(earliest-1);
    await db.transaction(async c=>{
      const locked=(await c.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1 FOR UPDATE",[id])).rows[0];
      if(Number(locked.block_number)!==Number(rows[0].block_number)||locked.block_hash!==rows[0].block_hash)throw Error("CURSOR_CONFLICT");
      await c.query("DELETE FROM chain_events WHERE deployment_id=$1",[id]);
      await clearProjection(c,id);
      await c.query("UPDATE index_cursor SET block_number=$2,block_hash=$3,updated_at=now() WHERE deployment_id=$1",[id,start.blockNumber,start.blockHash]);
      for(const operation of orphaned){
        await c.query("UPDATE operations SET state='REORGED',error_code='CHAIN_REORG',updated_at=now() WHERE id=$1 AND state IN ('INCLUDED','CONFIRMED')",[operation.id]);
        await c.query("UPDATE agent_document_versions SET confirmed_at=NULL WHERE intent_id=$1",[operation.intent_id]);
        await c.query("UPDATE management_drafts SET state='FROZEN_REORG',updated_at=now() WHERE operation_id=$1",[operation.id]);
        if(operation.action_type==="RegisterAgent")await c.query("UPDATE management_drafts SET state='FROZEN_REORG',updated_at=now() WHERE agent_did=$1 AND state IN ('AWAITING_WALLET_SIGNATURE','WAITING_AGENT','SUBMITTED')",[operation.agent_did]);
        await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,'OPERATION_REORGED',$3)",[operation.id,operation.intent_id,{previousBlockHash:operation.block_hash}]);
      }
      await c.query("INSERT INTO audit_events(event_type,detail) VALUES('INDEXER_REWOUND',$1)",[{deploymentId:id,previousBlockNumber:rows[0].block_number,restartBlockNumber:start.blockNumber}]);
    });
    return false;
  }
  const finalized=await adapter.readBlock("finalized");
  await db.transaction(async c=>{
    const current=(await c.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1 FOR UPDATE",[id])).rows[0];
    if(Number(current.block_number)!==Number(rows[0].block_number) || current.block_hash!==rows[0].block_hash)throw Error("CURSOR_CONFLICT");
    const checkpoint=(await c.query("SELECT block_number,block_hash FROM chain_projection_checkpoint WHERE deployment_id=$1",[id])).rows[0];
    // Existing installations already have an event cursor. Replay their retained events once.
    if(!checkpoint || Number(checkpoint.block_number)!==Number(current.block_number) || checkpoint.block_hash!==current.block_hash)await rebuildProjection(c,id);
    for(const event of next.events){
      const inserted=await c.query("INSERT INTO chain_events(deployment_id,block_hash,tx_hash,log_index,block_number,agent_did,event) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING 1",[id,event.blockHash,event.txHash,event.logIndex,event.blockNumber,event.agentDid,event]);
      if(inserted.rowCount)await applyChainEvent(c,event as IndexedEvent);
    }
    if(!next.idle)await c.query("UPDATE index_cursor SET block_number=$2,block_hash=$3,updated_at=now() WHERE deployment_id=$1",[id,next.cursor.blockNumber,next.cursor.blockHash]);
    await c.query(`INSERT INTO chain_projection_checkpoint(deployment_id,block_number,block_hash,finalized_block_number,finalized_block_hash) VALUES($1,$2,$3,$4,$5)
      ON CONFLICT(deployment_id) DO UPDATE SET block_number=excluded.block_number,block_hash=excluded.block_hash,finalized_block_number=excluded.finalized_block_number,finalized_block_hash=excluded.finalized_block_hash,updated_at=now()`,[id,next.cursor.blockNumber,next.cursor.blockHash,finalized.blockNumber,finalized.blockHash]);
  });
  return next.idle;
}

try {
  while(running){
    try {
      if(!indexOnly){await submitOne();await track();}
      const idle=await index();
      if(indexOnly&&once)break;
      if(indexOnly&&!idle)continue;
    }
    catch(error){
      console.error(JSON.stringify({event:"worker_retry",code:(error as {code?:string}).code||"WORKER_ERROR"}));
      if(once)throw error;
    }
    await pause(3000);
  }
} finally {await db.close();chain.close();}
