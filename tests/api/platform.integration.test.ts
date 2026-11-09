import "reflect-metadata";
import { expect, it } from "vitest";
import { Wallet, getAddress, keccak256, recoverAddress } from "ethers";
import { PlatformDb } from "../../apps/api/src/db.js";
import { PlatformService } from "../../apps/api/src/platform.service.js";
import type { ChainService } from "../../apps/api/src/chain.service.js";
import { makeIntent, type ActionSignature, type ActionType, type Intent, type Message } from "../../packages/chain-adapter/src/index.js";

const run=process.env.TEST_DATABASE_URL?it:it.skip;
run("persists challenge sessions, immutable intents, both signatures and idempotent operations",async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  const db=new PlatformDb();await db.init();
  await db.query("TRUNCATE audit_events,intent_signatures,operations,intents,sessions,challenges,agent_documents,chain_events,index_cursor CASCADE");
  const agent=Wallet.createRandom(),manager=Wallet.createRandom();
  const adapter={
    buildIntent:async(actionType:ActionType,payload:Message)=>makeIntent({intentId:crypto.randomUUID(),deploymentId:"offline-test-5611",actionType,domain:{name:actionType==="RegisterAgent"?"MEMO Agent DID Registry":"MEMO Agent DID Management",version:"1",chainId:5611,verifyingContract:actionType==="RegisterAgent"?"0x1111111111111111111111111111111111111111":"0x2222222222222222222222222222222222222222"},message:{...payload,expectedRevision:"0",nonce:"0",deadline:String(Math.floor(Date.now()/1000)+300)},chainSnapshot:{blockNumber:1,blockHash:"0x"+"1".repeat(64),timestamp:Math.floor(Date.now()/1000)}}),
    readIdentity:async()=>({status:"ACTIVE"}),readBlock:async()=>({timestamp:Math.floor(Date.now()/1000)}),
    verifySignedAction:async(intent:Intent,sigs:ActionSignature[])=>{
      if(sigs.length!==intent.requiredSigners.length)throw Error("MISSING_SIGNATURE");
      for(const required of intent.requiredSigners){const s=sigs.find(x=>x.role===required.role);if(!s||getAddress(recoverAddress(intent.digest,s.signature))!==getAddress(required.address))throw Error("INVALID_SIGNATURE");}
      return {valid:true};
    }
  };
  const service=new PlatformService({adapter:async()=>adapter} as unknown as ChainService,db);
  try{
    const agentChallenge=await service.challenge("agent",agent.address);
    const agentSession=await service.session("agent",{challengeId:agentChallenge.challengeId,signature:await agent.signMessage(agentChallenge.message)});
    await expect(service.session("agent",{challengeId:agentChallenge.challengeId,signature:await agent.signMessage(agentChallenge.message)})).rejects.toThrow();
    const managerChallenge=await service.challenge("manager",manager.address);
    const managerSession=await service.session("manager",{challengeId:managerChallenge.challengeId,signature:await manager.signMessage(managerChallenge.message)});
    const profile={name:"Agent 测试"},document={id:`did:memo:agent:5611:${agent.address.toLowerCase()}`};
    const registration=await service.registrationIntent(`Bearer ${agentSession.token}`,{identityAccount:agent.address,identityPublicKey:agent.signingKey.publicKey,profile,document});
    expect(registration.message.identityPublicKeyHash).toBe(keccak256(`0x${agent.signingKey.publicKey.slice(4)}`));
    await expect(service.registrationIntent(`Bearer ${agentSession.token}`,{identityAccount:agent.address,identityPublicKey:manager.signingKey.publicKey,profile,document})).rejects.toThrow();
    const registered=await service.submitRegistration(`Bearer ${agentSession.token}`,{intentId:registration.intentId,signature:await agent.signTypedData(registration.domain,registration.types,registration.message)},"registration-key-1");
    const again=await service.submitRegistration(`Bearer ${agentSession.token}`,{intentId:registration.intentId,signature:await agent.signTypedData(registration.domain,registration.types,registration.message)},"registration-key-1");
    expect(again.operationId).toBe(registered.operationId);
    await db.query("UPDATE operations SET state='CONFIRMED' WHERE id=$1",[registered.operationId]);
    const confirmedRetry=await service.submitRegistration(`Bearer ${agentSession.token}`,{intentId:registration.intentId,signature:await agent.signTypedData(registration.domain,registration.types,registration.message)},"registration-key-1");
    expect(confirmedRetry).toMatchObject({operationId:registered.operationId,state:"CONFIRMED"});
    const management=await service.managementIntent(`Bearer ${managerSession.token}`,{agentDid:document.id,scopes:["agent.read"],termSeconds:86400,discoverable:false});
    const details=await service.getManagementIntentDetails(`Bearer ${agentSession.token}`,management.intentId);
    expect(details.display).toMatchObject({scopes:["agent.read"],termSeconds:86400,discoverable:false});
    expect((await service.pendingManagement(`Bearer ${agentSession.token}`)).some(x=>x.intent.intentId===management.intentId)).toBe(true);
    const managerSig=await manager.signTypedData(management.domain,management.types,management.message);
    await expect(service.addSignature(`Bearer ${managerSession.token}`,management.intentId,{role:"manager",address:manager.address,signature:await agent.signTypedData(management.domain,management.types,management.message)})).rejects.toThrow();
    await service.addSignature(`Bearer ${managerSession.token}`,management.intentId,{role:"manager",address:manager.address,signature:managerSig});
    await expect(service.submitManagement(`Bearer ${managerSession.token}`,{intentId:management.intentId},"management-key-1")).rejects.toThrow();
    const agentSig=await agent.signTypedData(management.domain,management.types,management.message);
    await service.addSignature(`Bearer ${agentSession.token}`,management.intentId,{role:"agent",address:agent.address,signature:agentSig});
    const submitted=await service.submitManagement(`Bearer ${managerSession.token}`,{intentId:management.intentId},"management-key-1");
    expect(submitted.state).toBe("SIGNED");
    expect((await service.pendingManagement(`Bearer ${agentSession.token}`)).some(x=>x.intent.intentId===management.intentId)).toBe(false);
    expect((await service.operation(`Bearer ${agentSession.token}`,submitted.operationId)).state).toBe("SIGNED");
    expect((await db.query("SELECT count(*)::int AS n FROM operations"))[0].n).toBe(2);
    expect((await db.query("SELECT event_type FROM audit_events WHERE operation_id=$1",[submitted.operationId])).map(x=>x.event_type)).toEqual(["INTENT_CREATED","OPERATION_SIGNED"]);
    await expect(db.transaction(async c=>{await c.query("INSERT INTO audit_events(event_type) VALUES('ROLLBACK_PROBE')");throw Error("rollback");})).rejects.toThrow("rollback");
    expect((await db.query("SELECT count(*)::int AS n FROM audit_events WHERE event_type='ROLLBACK_PROBE'"))[0].n).toBe(0);
  }finally{await db.close();}
});
