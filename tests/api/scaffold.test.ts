import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ApiController } from "../../apps/api/src/api.controller.js";
import { ChainService } from "../../apps/api/src/chain.service.js";
import type { PlatformService } from "../../apps/api/src/platform.service.js";

describe("unconfigured platform", () => {
  const api = new ApiController(new ChainService(), {} as PlatformService, {} as never, {} as never, {} as never);

  it("reports that chain writes are disabled", () => {
    expect(api.health()).toMatchObject({processAlive:true});
  });

  it("fails closed for readiness and public chain configuration", async () => {
    for (const operation of [() => api.ready(), () => api.chainConfig()]) {
      await expect(operation()).rejects.toMatchObject({status:503,response:{code:"CHAIN_NOT_CONFIGURED"}});
    }
  });

  it("exposes registration and management routes", () => {
    const routes = Object.getOwnPropertyNames(ApiController.prototype)
      .map((name) => Reflect.getMetadata("path", ApiController.prototype[name as keyof ApiController]))
      .filter((path): path is string => typeof path === "string");
    expect(routes).toContain("agent-dids");
    expect(routes).toContain("management-actions");
    expect(routes).toContain("binding-requests/next");
  });
});
