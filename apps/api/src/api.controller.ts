import { Body, Controller, Get, Headers, HttpCode, Param, Post } from "@nestjs/common";
import { ChainService } from "./chain.service.js";
import { PlatformService } from "./platform.service.js";
import { PlatformDb } from "./db.js";

@Controller("api/v1")
export class ApiController {
  constructor(private readonly chain:ChainService,private readonly platform:PlatformService,private readonly db:PlatformDb){}

  @Get("health") health(){return {service:"agent-did-management-platform",processAlive:true};}
  @Get("integration/status") integrationStatus(){return this.chain.status();}
  @Get("ready") async ready(){const chain=await this.chain.ready();await this.db.query("SELECT 1");return {...chain,databaseReady:true};}
  @Get("chain/config") chainConfig(){return this.chain.publicConfig();}

  @Post("agent-sessions/challenges") agentChallenge(@Body() body:{address:string}){return this.platform.challenge("agent",body.address);}
  @Post("agent-sessions") agentSession(@Body() body:{challengeId:string;signature:string}){return this.platform.session("agent",body);}
  @Post("wallet-login-intents") walletChallenge(@Body() body:{address:string}){return this.platform.challenge("manager",body.address);}
  @Post("wallet-sessions") walletSession(@Body() body:{challengeId:string;signature:string}){return this.platform.session("manager",body);}

  @Post("registration-intents") registrationIntent(@Headers("authorization") auth:string,@Body() body:{identityAccount:string;identityPublicKey:string;profile:Record<string,unknown>;document:Record<string,unknown>}){return this.platform.registrationIntent(auth,body);}
  @Post("agent-dids") @HttpCode(202) register(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{intentId:string;signature:string}){return this.platform.submitRegistration(auth,body,key);}
  @Post("management-intents") managementIntent(@Headers("authorization") auth:string,@Body() body:{agentDid:string;scopes:string[];termSeconds:number;discoverable:boolean}){return this.platform.managementIntent(auth,body);}
  @Get("management-intents/pending") pendingManagement(@Headers("authorization") auth:string){return this.platform.pendingManagement(auth);}
  @Get("management-intents/:id") getManagementIntent(@Headers("authorization") auth:string,@Param("id") id:string){return this.platform.getManagementIntentDetails(auth,id);}
  @Post("management-intents/:id/signatures") addManagementSignature(@Headers("authorization") auth:string,@Param("id") id:string,@Body() body:{role:string;address:string;signature:string}){return this.platform.addSignature(auth,id,body);}
  @Post("management-actions") @HttpCode(202) submitManagement(@Headers("authorization") auth:string,@Headers("idempotency-key") key:string,@Body() body:{intentId:string}){return this.platform.submitManagement(auth,body,key);}
  @Get("operations/:id") operation(@Headers("authorization") auth:string,@Param("id") id:string){return this.platform.operation(auth,id);}
  @Get("agent-dids/:did") resolve(@Param("did") did:string){return this.platform.resolve(did);}
  @Get("management/:did") relationship(@Param("did") did:string){return this.platform.relationship(did);}
}
