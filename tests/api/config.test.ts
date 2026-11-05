import { describe, expect, it } from "vitest";
import { loadRuntimeConfig } from "../../apps/api/src/config.service.js";

describe("runtime production gate", () => {
  it("fails closed before a production API or worker can use phase-one persistence", () => {
    expect(() => loadRuntimeConfig({ MEMO_ENVIRONMENT: "production" })).toThrow(
      "PRODUCTION_RUNTIME_REQUIRES_POSTGRES_S3_ADAPTERS",
    );
  });
});
