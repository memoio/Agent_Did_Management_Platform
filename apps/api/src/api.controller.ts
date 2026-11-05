import { Controller, Get, ServiceUnavailableException } from "@nestjs/common";

export const INTEGRATION_STATUS = {
  state: "AWAITING_BLOCKCHAIN_IMPLEMENTATION",
  chainConnected: false,
  writesEnabled: false,
} as const;

@Controller("api/v1")
export class ApiController {
  @Get("health")
  health() {
    return { service: "agent-did-management-platform", ...INTEGRATION_STATUS };
  }

  @Get("integration/status")
  integrationStatus() {
    return INTEGRATION_STATUS;
  }

  @Get("ready")
  ready(): never {
    throw unavailable();
  }

  @Get("chain/config")
  chainConfig(): never {
    throw unavailable();
  }
}

function unavailable(): ServiceUnavailableException {
  return new ServiceUnavailableException({
    code: "BLOCKCHAIN_NOT_IMPLEMENTED",
    message: "The blockchain integration has not been implemented or verified",
  });
}
