import "reflect-metadata";
import { expect, it } from "vitest";
import { createHash, randomUUID } from "node:crypto";
import { Wallet, getAddress, recoverAddress } from "ethers";
import { PlatformDb } from "../../apps/api/src/db.js";
import { PlatformService } from "../../apps/api/src/platform.service.js";
import { PairingService } from "../../apps/api/src/pairing.service.js";
import type { ChainService } from "../../apps/api/src/chain.service.js";
import { makeIntent, type ActionSignature, type ActionType, type Intent, type Message } from "../../packages/chain-adapter/src/index.js";

const run=process.env.TEST_DATABASE_URL?it:it.skip;
run("completes invitation and offer journeys without replacing existing operations",async()=>{
  process.env.DATABASE_URL=process.env.TEST_DATABASE_URL;
  const db=new PlatformDb();await db.init();
  await db.query("TRUNCATE pairing_idempotency,management_drafts,pairing_bindings,pairing_exchanges,agent_instances,agent_document_versions,audit_events,intent_signatures,operations,intents,sessions,challenges,agent_documents,chain_events,index_cursor CASCADE");
  const agent=Wallet.createRandom(),other=Wallet.createRandom(),manager=Wallet.createRandom();
  let relationshipLive=false,relationshipManager=manager.address;
  const adapter={
    buildIntent:async(actionType:ActionType,payload:Message)=>{const identity="identityAccount" in payload;return makeIntent({intentId:randomUUID(),deploymentId:"offline-test-5611",actionType,domain:{name:identity?"MEMO Agent DID Registry":"MEMO Agent DID Management",version:"1",chainId:5611,verifyingContract:identity?"0x1111111111111111111111111111111111111111":"0x2222222222222222222222222222222222222222"},message:{...payload,expectedRevision:"0",nonce:"0",deadline:String(Math.floor(Date.now()/1000)+300)},chainSnapshot:{blockNumber:1,blockHash:"0x"+"1".repeat(64),timestamp:Math.floor(Date.now()/1000)}});},
    readIdentity:async()=>({status:"ACTIVE",revision:"1",profileHash:"0x"+"1".repeat(64),documentHash:"0x"+"2".repeat(64),source:{blockNumber:1}}),readRelationship:async()=>({manager:relationshipManager,relationshipIdHash:"0x"+"a".repeat(64),live:relationshipLive,expiresAt:String(Math.floor(Date.now()/1000)+86400),discoverable:false}),readBlock:async()=>({timestamp:Math.floor(Date.now()/1000)}),
    verifySignedAction:async(intent:Intent,sigs:ActionSignature[])=>{
      if(sigs.length!==intent.requiredSigners.length)throw Error("MISSING_SIGNATURE");
      for(const required of intent.requiredSigners){const s=sigs.find(x=>x.role===required.role);if(!s||getAddress(recoverAddress(intent.digest,s.signature))!==getAddress(required.address))throw Error("INVALID_SIGNATURE");}
      return {valid:true};
    },
  };
  const chain={adapter:async()=>adapter} as unknown as ChainService;
  const platform=new PlatformService(chain,db),pairing=new PairingService(db,platform,chain);
  const login=async(role:"agent"|"manager",w:{address:string;signMessage:(message:string)=>Promise<string>})=>{const ch=await platform.challenge(role,w.address);return `Bearer ${(await platform.session(role,{challengeId:ch.challengeId,signature:await w.signMessage(ch.message)})).token}`;};
  try{
    const agentAuth=await login("agent",agent),otherAuth=await login("agent",other),managerAuth=await login("manager",manager);
    const handle="temporary-invitation-"+randomUUID(),handleHash=createHash("sha256").update(handle).digest("hex");
    const invitation=await pairing.invitation(managerAuth,{handleHash,maxScopes:["agent.read"],maxTermSeconds:30*86400,ttlSeconds:900},"invite-key-001");
    expect((await pairing.invitation(managerAuth,{handleHash,maxScopes:["agent.read"],maxTermSeconds:30*86400,ttlSeconds:900},"invite-key-001")).exchangeId).toBe(invitation.exchangeId);
    await expect(pairing.inspectInvitation(agentAuth,{exchangeId:invitation.exchangeId as string,handle:"wrong"})).rejects.toThrow();
    await pairing.inspectInvitation(agentAuth,{exchangeId:invitation.exchangeId as string,handle});
    await pairing.claimInvitation(agentAuth,invitation.exchangeId as string,handle);
    const completed=await pairing.completeInvitation(agentAuth,invitation.exchangeId as string);
    expect(completed.state).toBe("PAIRED");
    expect((await pairing.completeInvitation(agentAuth,invitation.exchangeId as string)).bindingId).toBe(completed.bindingId);
    const draft=await pairing.createDraftIntent(managerAuth,completed.draftId);
    const managerSignature=await manager.signTypedData(draft.intent.domain,draft.intent.types,draft.intent.message);
    await pairing.signDraft(managerAuth,completed.draftId,draft.intent.intentId,managerSignature);
    const request=(await pairing.nextRequest(agentAuth)).request;
    expect(request?.id).toBe(completed.draftId);
    await expect(pairing.decide(otherAuth,completed.draftId,{decision:"approve",signature:"0x"})).rejects.toThrow();
    const agentSignature=await agent.signTypedData(draft.intent.domain,draft.intent.types,draft.intent.message);
    const decision=await pairing.decide(agentAuth,completed.draftId,{decision:"approve",signature:agentSignature});
    expect(decision.operation?.state).toBe("SIGNED");
    expect((await pairing.nextRequest(agentAuth)).request).toBeNull();
    const offerHandle="temporary-offer-"+randomUUID(),offerHash=createHash("sha256").update(offerHandle).digest("hex");
    const offer=await pairing.offer(otherAuth,{handleHash:offerHash,maxScopes:["agent.read","profile.update"],maxTermSeconds:7*86400,ttlSeconds:900},"offer-key-0001");
    await pairing.inspectOffer(managerAuth,{exchangeId:offer.exchangeId as string,handle:offerHandle});
    await expect(pairing.redeemOffer(managerAuth,offer.exchangeId as string,{handle:offerHandle,requestedScopes:["instance.issue"],requestedTermSeconds:86400,discoverable:false})).rejects.toThrow();
    await expect(pairing.redeemOffer(managerAuth,offer.exchangeId as string,{handle:offerHandle,requestedScopes:["agent.read"],requestedTermSeconds:86400,discoverable:true})).rejects.toThrow();
    const redeemed=await pairing.redeemOffer(managerAuth,offer.exchangeId as string,{handle:offerHandle,requestedScopes:["agent.read"],requestedTermSeconds:86400,discoverable:false});
    expect(redeemed.state).toBe("PAIRED");
    const stale=await pairing.createDraftIntent(managerAuth,redeemed.draftId);
    await db.query("UPDATE intents SET expires_at=now()-interval '1 second' WHERE id=$1",[stale.intent.intentId]);
    const refreshed=await pairing.createDraftIntent(managerAuth,redeemed.draftId);
    expect(refreshed.intent.intentId).not.toBe(stale.intent.intentId);
    expect((await pairing.createDraftIntent(managerAuth,redeemed.draftId)).intent.intentId).toBe(refreshed.intent.intentId);
    await pairing.signDraft(managerAuth,redeemed.draftId,refreshed.intent.intentId,await manager.signTypedData(refreshed.intent.domain,refreshed.intent.types,refreshed.intent.message));
    await db.query("UPDATE intents SET expires_at=now()-interval '1 second' WHERE id=$1",[refreshed.intent.intentId]);
    const renewed=await pairing.createDraftIntent(managerAuth,redeemed.draftId);
    expect(renewed.intent.intentId).not.toBe(refreshed.intent.intentId);
    expect((await pairing.draft(managerAuth,redeemed.draftId)).state).toBe("AWAITING_WALLET_SIGNATURE");
    expect((await pairing.redeemOffer(managerAuth,offer.exchangeId as string,{handle:offerHandle,requestedScopes:["agent.read"],requestedTermSeconds:86400,discoverable:false})).bindingId).toBe(redeemed.bindingId);
    expect((await pairing.bindings(managerAuth)).length).toBe(2);
    relationshipLive=true;
    const dashboard=await platform.dashboard(managerAuth);
    expect(dashboard.counts.total).toBe(2);
    expect(dashboard.agents.some(x=>x.identity.agentDid===completed.agentDid&&x.associationSource==="pairing")).toBe(true);
    const registry=await platform.registryActionIntent(agentAuth,{actionType:"UpdateProfile",profile:{name:"Updated Agent"}});
    const registryOp=await platform.submitRegistryAction(agentAuth,{intentId:registry.intentId,signature:await agent.signTypedData(registry.domain,registry.types,registry.message)},"profile-key-01");
    expect(registryOp.state).toBe("SIGNED");
    const renew=await platform.managementActionIntent(managerAuth,{actionType:"RenewRelationship",agentDid:completed.agentDid,scopes:["agent.read"],termSeconds:86400,discoverable:false});
    await platform.addSignature(managerAuth,renew.intentId,{role:"manager",address:manager.address,signature:await manager.signTypedData(renew.domain,renew.types,renew.message)});
    await platform.addSignature(agentAuth,renew.intentId,{role:"agent",address:agent.address,signature:await agent.signTypedData(renew.domain,renew.types,renew.message)});
    expect((await platform.submitManagement(managerAuth,{intentId:renew.intentId},"renew-key-0001")).state).toBe("SIGNED");
    const end=await platform.managementActionIntent(managerAuth,{actionType:"EndRelationship",agentDid:completed.agentDid});
    await platform.addSignature(managerAuth,end.intentId,{role:"actor",address:manager.address,signature:await manager.signTypedData(end.domain,end.types,end.message)});
    expect((await platform.submitManagement(managerAuth,{intentId:end.intentId},"end-key-00001")).state).toBe("SIGNED");
    const transfer=await platform.managementActionIntent(managerAuth,{actionType:"TransferRelationship",agentDid:completed.agentDid,scopes:["agent.read"],termSeconds:86400,discoverable:false,newManager:other.address});
    await platform.addSignature(managerAuth,transfer.intentId,{role:"oldManager",address:manager.address,signature:await manager.signTypedData(transfer.domain,transfer.types,transfer.message)});
    await platform.addSignature(agentAuth,transfer.intentId,{role:"agent",address:agent.address,signature:await agent.signTypedData(transfer.domain,transfer.types,transfer.message)});
    const newManagerAuth=await login("manager",other);
    await platform.addSignature(newManagerAuth,transfer.intentId,{role:"newManager",address:other.address,signature:await other.signTypedData(transfer.domain,transfer.types,transfer.message)});
    const transferred=await platform.submitManagement(managerAuth,{intentId:transfer.intentId},"transfer-key-01");
    expect(transferred.state).toBe("SIGNED");
    await db.query("UPDATE operations SET state='CONFIRMED' WHERE id=$1",[transferred.operationId]);
    relationshipManager=other.address;
    expect((await platform.dashboard(newManagerAuth)).agents.some(x=>x.identity.agentDid===completed.agentDid)).toBe(true);
    expect((await platform.dashboard(managerAuth)).agents.some(x=>x.identity.agentDid===completed.agentDid)).toBe(false);
    const cancelledHandle=randomUUID(),cancelled=await pairing.invitation(managerAuth,{handleHash:createHash("sha256").update(cancelledHandle).digest("hex"),maxScopes:["agent.read"],maxTermSeconds:86400,ttlSeconds:900},"invite-key-002");
    await pairing.cancel(managerAuth,cancelled.exchangeId as string);
    await expect(pairing.inspectInvitation(agentAuth,{exchangeId:cancelled.exchangeId as string,handle:cancelledHandle})).rejects.toThrow();
    expect((await platform.audit(managerAuth)).some(e=>e.event_type==="PAIRING_COMPLETED")).toBe(true);
  }finally{await db.close();}
});
