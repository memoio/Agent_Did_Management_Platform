import { Controller, Get } from "@nestjs/common";
import { ChainService } from "./chain.service.js";

@Controller("api/v1")
export class ApiController {
  constructor(private readonly chain: ChainService) {}
  @Get("health")
  health() {
    return { service: "agent-did-management-platform", processAlive: true };
  }

  @Get("integration/status")
  integrationStatus() {
    return this.chain.status();
  }

  @Get("ready")
  ready() {
    return this.chain.ready();
  }

  @Get("chain/config")
  chainConfig() {
    return this.chain.publicConfig();
  }
}
