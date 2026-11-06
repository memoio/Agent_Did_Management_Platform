import "reflect-metadata";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ApiController } from "../../apps/api/src/api.controller.js";
import { ChainService } from "../../apps/api/src/chain.service.js";

describe("unconfigured platform", () => {
  const api = new ApiController(new ChainService());
  afterEach(() => vi.unstubAllEnvs());

  it("reports that chain writes are disabled", () => {
    expect(api.health()).toMatchObject({ processAlive: true });
  });

  it("reports missing deployment configuration for readiness and public chain configuration", async () => {
    vi.stubEnv("MEMO_CHAIN_MANIFEST_PATH", "");
    vi.stubEnv("MEMO_CHAIN_MANIFEST_SHA256", "");
    for (const operation of [() => api.ready(), () => api.chainConfig()]) {
      await expect(operation()).rejects.toMatchObject({
        status: 503,
        response: { code: "CHAIN_NOT_CONFIGURED" },
      });
    }
    expect(await api.integrationStatus()).toMatchObject({
      network: { chainId: 5611 },
      chainConnected: false,
      writesEnabled: false,
      errorCode: "CHAIN_NOT_CONFIGURED",
    });
  });

  it("does not expose the old registration or management routes", () => {
    const routes = Object.getOwnPropertyNames(ApiController.prototype)
      .map((name) =>
        Reflect.getMetadata(
          "path",
          ApiController.prototype[name as keyof ApiController],
        ),
      )
      .filter((path): path is string => typeof path === "string");
    expect(routes).not.toContain("agent-dids");
    expect(routes).not.toContain("registry-actions");
    expect(routes).not.toContain("management-actions");
  });
});
