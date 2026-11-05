import { describe, expect, it, vi } from "vitest";
import { RpcEndpoint } from "../../packages/aa-client/src/index.js";

describe("RpcEndpoint", () => {
  it("preserves a structured JSON-RPC error returned with a non-2xx status", async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      error: { code: -32500, message: "AA24 signature error", data: { reason: "invalid" } },
    }), {
      status: 500,
      headers: { "content-type": "application/json" },
    }));
    const endpoint = new RpcEndpoint("http://127.0.0.1:4337", fetcher as typeof fetch);

    await expect(endpoint.request("eth_sendUserOperation")).rejects.toMatchObject({
      message: "AA24 signature error",
      code: -32500,
      data: { reason: "invalid" },
    });
  });

  it("reports the HTTP status when the response is not JSON", async () => {
    const fetcher = vi.fn(async () => new Response("upstream unavailable", { status: 502 }));
    const endpoint = new RpcEndpoint("http://127.0.0.1:4337", fetcher as typeof fetch);
    await expect(endpoint.request("eth_chainId")).rejects.toThrow("RPC_HTTP_502");
  });
});
