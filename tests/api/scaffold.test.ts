import "reflect-metadata";
import { describe, expect, it } from "vitest";
import { ApiController } from "../../apps/api/src/api.controller.js";

describe("unconfigured platform", () => {
  const api = new ApiController();

  it("reports that chain writes are disabled", () => {
    expect(api.health()).toMatchObject({
      state: "AWAITING_BLOCKCHAIN_IMPLEMENTATION",
      chainConnected: false,
      writesEnabled: false,
    });
  });

  it("fails closed for readiness and public chain configuration", () => {
    for (const operation of [() => api.ready(), () => api.chainConfig()]) {
      try {
        operation();
        throw new Error("EXPECTED_UNAVAILABLE");
      } catch (error) {
        expect(error).toMatchObject({
          status: 503,
          response: { code: "BLOCKCHAIN_NOT_IMPLEMENTED" },
        });
      }
    }
  });

  it("does not expose the old registration or management routes", () => {
    const routes = Object.getOwnPropertyNames(ApiController.prototype)
      .map((name) => Reflect.getMetadata("path", ApiController.prototype[name as keyof ApiController]))
      .filter((path): path is string => typeof path === "string");
    expect(routes).not.toContain("agent-dids");
    expect(routes).not.toContain("registry-actions");
    expect(routes).not.toContain("management-actions");
  });
});
