import { configuredChain, readNextWindow, type Intent, type ActionSignature } from "../../../packages/chain-adapter/src/index.js";
import { PlatformDb } from "../../api/src/db.js";

const pause=(ms:number)=>new Promise(r=>setTimeout(r,ms));
const db=new PlatformDb();
const chain=await configuredChain();
if(!chain.writesEnabled) throw new Error("CHAIN_WRITES_DISABLED");
const adapter=chain.adapter;
await db.init();
await adapter.readiness();
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
  const rows=await db.query("SELECT * FROM operations WHERE state IN ('SUBMITTED','INCLUDED') ORDER BY updated_at LIMIT 30");
  for(const r of rows){
    if(!r.submission_id)continue;
    try {
      const result=await adapter.getSubmission(r.submission_id as string);
      if(result.state==="REVERTED"){
        await db.transaction(async c=>{
          const updated=await c.query("UPDATE operations SET state='FAILED',error_code='CONTRACT_REVERT',block_number=$2,block_hash=$3,updated_at=now() WHERE id=$1 AND state IN ('SUBMITTED','INCLUDED') RETURNING intent_id",[r.id,result.blockNumber,result.blockHash]);
          if(updated.rowCount)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,'OPERATION_FAILED',$3)",[r.id,updated.rows[0].intent_id,{code:"CONTRACT_REVERT",blockHash:result.blockHash}]);
        });
      }else if(result.state==="INCLUDED"){
        const state=result.confirmed?"CONFIRMED":"INCLUDED";
        await db.transaction(async c=>{
          const updated=await c.query("UPDATE operations SET state=$2,block_number=$3,block_hash=$4,confirmations=greatest(confirmations,$5),finality_source=$6,updated_at=now() WHERE id=$1 AND state IN ('SUBMITTED','INCLUDED') RETURNING intent_id",[r.id,state,result.blockNumber,result.blockHash,result.confirmations,result.finalitySource]);
          if(!updated.rowCount)return;
          if(r.state!==state)await c.query("INSERT INTO audit_events(operation_id,intent_id,event_type,detail) VALUES($1,$2,$3,$4)",[r.id,updated.rows[0].intent_id,state==="CONFIRMED"?"OPERATION_CONFIRMED":"TRANSACTION_INCLUDED",{txHash:result.txHash,blockNumber:result.blockNumber,blockHash:result.blockHash,finalitySource:result.finalitySource}]);
          if(state==="CONFIRMED" && r.action_type==="RegisterAgent"){
            const record=(await c.query("SELECT profile,document,intent,agent_did FROM intents WHERE id=$1",[r.intent_id])).rows[0];
            const message=(record.intent as Intent).message;
            await c.query("INSERT INTO agent_documents(agent_did,profile,document,profile_hash,document_hash) VALUES($1,$2,$3,$4,$5) ON CONFLICT(agent_did) DO UPDATE SET profile=excluded.profile,document=excluded.document,profile_hash=excluded.profile_hash,document_hash=excluded.document_hash,updated_at=now()",[record.agent_did,record.profile,record.document,message.profileHash,message.documentHash]);
          }
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

async function index(){
  const id=adapter.manifest.deploymentId;
  const earliest=Math.min(adapter.manifest.contracts.didRegistry.deploymentBlockNumber,adapter.manifest.contracts.managementRegistry.deploymentBlockNumber);
  let rows=await db.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1",[id]);
  if(!rows[0]){
    const start=await adapter.readBlock(earliest-1);
    await db.query("INSERT INTO index_cursor(deployment_id,block_number,block_hash) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",[id,start.blockNumber,start.blockHash]);
    rows=await db.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1",[id]);
  }
  const next=await readNextWindow(adapter,{blockNumber:Number(rows[0].block_number),blockHash:rows[0].block_hash as string},100);
  if(next.idle)return;
  await db.transaction(async c=>{
    const current=(await c.query("SELECT block_number,block_hash FROM index_cursor WHERE deployment_id=$1 FOR UPDATE",[id])).rows[0];
    if(Number(current.block_number)!==Number(rows[0].block_number) || current.block_hash!==rows[0].block_hash)throw Error("CURSOR_CONFLICT");
    for(const event of next.events)await c.query("INSERT INTO chain_events(deployment_id,block_hash,tx_hash,log_index,block_number,agent_did,event) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING",[id,event.blockHash,event.txHash,event.logIndex,event.blockNumber,event.agentDid,event]);
    await c.query("UPDATE index_cursor SET block_number=$2,block_hash=$3 WHERE deployment_id=$1",[id,next.cursor.blockNumber,next.cursor.blockHash]);
  });
}

try {
  while(running){
    try {await submitOne();await track();await index();}
    catch(error){console.error(JSON.stringify({event:"worker_retry",code:(error as {code?:string}).code||"WORKER_ERROR"}));}
    await pause(3000);
  }
} finally {await db.close();chain.close();}
