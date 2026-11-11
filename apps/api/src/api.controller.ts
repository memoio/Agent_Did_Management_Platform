import { Body, Controller, Delete, Get, Headers, HttpCode, Param, Post, Query } from "@nestjs/common";
import { ChainService } from "./chain.service.js";
import { PlatformService } from "./platform.service.js";
import { PlatformDb } from "./db.js";
import { PairingService } from "./pairing.service.js";
import { ChainMirrorService } from "./chain-mirror.service.js";
import type { ActionType } from "../../../packages/chain-adapter/src/index.js";

@Controller("api/v1")
export class ApiController {
  constructor(private readonly chain:ChainService,private readonly platform:PlatformService,private readonly db:PlatformDb,private readonly pairing:PairingService,private readonly mirror:ChainMirrorService){}

  @Get("health") health(){return {service:"agent-did-management-platform",processAlive:true};}
  @Get("integration/status") integrationStatus(){return this.chain.status();}
  @Get("ready") async ready(){const chain=await this.chain.ready();await this.db.query("SELECT 1");return {...chain,databaseReady:true};}
  @Get("chain/config") chainConfig(){return this.chain.publicConfig();}

  @Post("agent-sessions/challenges") agentChallenge(@Body() body:{address:string}){return this.platform.challenge("agent",body.address);}
  @Post("agent-sessions") agentSession(@Body() body:{challengeId:string;signature:string}){return this.platform.session("agent",body);}
  @Post("wallet-login-intents") walletChallenge(@Body() body:{address:string}){return this.platform.challenge("manager",body.address);}
  @Post("wallet-sessions") walletSession(@Body() body:{challengeId:string;signature:string}){return this.platform.session("manager",body);}
  @Get("wallet-session") currentWallet(@Headers("authorization") auth:string){return this.platform.walletSession(auth);}
  @Delete("wallet-session") endWallet(@Headers("authorization") auth:string){return this.platform.endWalletSession(auth);}

  @Post("registration-intents") registrationIntent(@Headers("authorization") auth:string,@Body() body:{identityAccount:string;identityPublicKey:string;profile:Record<string,unknown>;document:Record<string,unknown>}){return this.platform.registrationIntent(auth,body);}
  @Post("agent-dids") @HttpCode(202) register(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{intentId:string;signature:string}){return this.platform.submitRegistration(auth,body,key);}
  @Post("management-intents") managementIntent(@Headers("authorization") auth:string,@Body() body:{agentDid:string;scopes:string[];termSeconds:number;discoverable:boolean}){return this.platform.managementIntent(auth,body);}
  @Post("management-action-intents") managementActionIntent(@Headers("authorization") auth:string,@Body() body:{actionType:ActionType;agentDid:string;scopes?:string[];termSeconds?:number;discoverable?:boolean;newManager?:string;reason?:string}){return this.platform.managementActionIntent(auth,body);}
  @Post("registry-action-intents") registryActionIntent(@Headers("authorization") auth:string,@Body() body:{actionType:ActionType;profile?:Record<string,unknown>;document?:Record<string,unknown>;credentialId?:string}){return this.platform.registryActionIntent(auth,body);}
  @Post("registry-actions") @HttpCode(202) registryAction(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{intentId:string;signature:string}){return this.platform.submitRegistryAction(auth,body,key);}
  @Get("management-intents/pending") pendingManagement(@Headers("authorization") auth:string){return this.platform.pendingManagement(auth);}
  @Get("management-intents/:id") getManagementIntent(@Headers("authorization") auth:string,@Param("id") id:string){return this.platform.getManagementIntentDetails(auth,id);}
  @Get("management-intents/:id/operation") managementIntentOperation(@Headers("authorization") auth:string,@Param("id") id:string){return this.platform.intentOperation(auth,id);}
  @Post("management-intents/:id/signatures") addManagementSignature(@Headers("authorization") auth:string,@Param("id") id:string,@Body() body:{role:string;address:string;signature:string}){return this.platform.addSignature(auth,id,body);}
  @Post("management-actions") @HttpCode(202) submitManagement(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{intentId:string}){return this.platform.submitManagement(auth,body,key);}
  @Get("operations/:id") operation(@Headers("authorization") auth:string,@Param("id") id:string){return this.platform.operation(auth,id);}
  @Get("agent-dids/:did") resolve(@Param("did") did:string){return this.platform.resolve(did);}
  @Get("management/:did") relationship(@Param("did") did:string){return this.platform.relationship(did);}
  @Get("dashboard") dashboard(@Headers("authorization") auth:string){return this.platform.dashboard(auth);}
  @Get("dashboard/agents/:did") agentDetail(@Headers("authorization") auth:string,@Param("did") did:string){return this.platform.agentDetail(auth,did);}
  @Get("audit-events") audit(@Headers("authorization") auth:string){return this.platform.audit(auth);}
  @Post("agent-instances") publishInstance(@Headers("authorization") auth:string,@Body() body:{schema:string;agentDid:string;instanceId:string;name:string;publicKey:string;expiresAt:number;identityRevision:number;signature:string}){return this.platform.publishInstance(auth,body);}
  @Get("agent-instances") instances(@Headers("authorization") auth:string){return this.platform.instances(auth);}
  @Get("chain/blocks/latest") async latestBlock(){return(await this.chain.adapter()).readBlock();}
  @Get("chain-mirror/status") mirrorStatus(){return this.mirror.status();}
  @Get("chain-mirror/agents") mirrorAgents(@Query() query:{did?:string;status?:string;manager?:string;limit?:string;after?:string}){return this.mirror.agents(query);}
  @Get("chain-mirror/agents/:did") mirrorAgent(@Param("did") did:string){return this.mirror.agent(did);}
  @Get("chain-mirror/agents/:did/verify") mirrorVerify(@Param("did") did:string){return this.mirror.verify(did);}
  @Get("chain-mirror/events") mirrorEvents(@Query() query:{agentDid?:string;eventType?:string;txHash?:string;limit?:string;beforeBlock?:string;beforeLogIndex?:string}){return this.mirror.events(query);}

  @Post("pairing-invitations") invitation(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{handleHash:string;maxScopes:string[];maxTermSeconds:number;ttlSeconds:number;discoverable?:boolean}){return this.pairing.invitation(auth,body,key);}
  @Post("pairing-invitations/inspect") inspectInvitation(@Headers("authorization") auth:string,@Body() body:{exchangeId:string;handle:string}){return this.pairing.inspectInvitation(auth,body);}
  @Post("pairing-invitations/:id/claim") claimInvitation(@Headers("authorization") auth:string,@Param("id") id:string,@Body() body:{handle:string}){return this.pairing.claimInvitation(auth,id,body.handle);}
  @Post("pairing-invitations/:id/complete") completeInvitation(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.completeInvitation(auth,id);}
  @Post("pairing-offers") offer(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{handleHash:string;maxScopes:string[];maxTermSeconds:number;ttlSeconds:number;discoverable?:boolean}){return this.pairing.offer(auth,body,key);}
  @Post("pairing-offers/inspect") inspectOffer(@Headers("authorization") auth:string,@Body() body:{exchangeId:string;handle:string}){return this.pairing.inspectOffer(auth,body);}
  @Post("pairing-offers/:id/redeem") redeemOffer(@Headers("authorization") auth:string,@Param("id") id:string,@Body() body:{handle:string;requestedScopes:string[];requestedTermSeconds:number;discoverable:boolean}){return this.pairing.redeemOffer(auth,id,body);}
  @Get("pairing-exchanges/:id") exchange(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.exchange(auth,id);}
  @Post("pairing-exchanges/:id/cancel") cancelExchange(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.cancel(auth,id);}
  @Get("pairings") bindings(@Headers("authorization") auth:string){return this.pairing.bindings(auth);}
  @Post("pairings/:id/end") endBinding(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.endBinding(auth,id);}
  @Post("management-drafts/:id/intent") draftIntent(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.createDraftIntent(auth,id);}
  @Post("management-drafts/:id/wallet-signature") draftSignature(@Headers("authorization") auth:string,@Param("id") id:string,@Body() body:{intentId:string;managerSignature:string}){return this.pairing.signDraft(auth,id,body.intentId,body.managerSignature);}
  @Post("management-drafts/:id/retry") retryFrozenDraft(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.retryFrozenDraft(auth,id);}
  @Get("binding-requests/next") nextRequest(@Headers("authorization") auth:string){return this.pairing.nextRequest(auth);}
  @Get("binding-requests/:id") bindingRequest(@Headers("authorization") auth:string,@Param("id") id:string){return this.pairing.request(auth,id);}
  @Post("binding-requests/:id/decision") decideRequest(@Headers("authorization") auth:string,@Param("id") id:string,@Body() body:{decision:string;signature?:string;reason?:string}){return this.pairing.decide(auth,id,body);}
}
