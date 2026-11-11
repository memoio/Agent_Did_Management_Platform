import { expect, it } from "vitest";
import {
  configuredChain,
  configuredProviders,
  configuredSigner,
} from "../../packages/chain-adapter/src/index.js";

it("provides distinct opBNB HTTPS endpoints and rejects invalid endpoint configuration", () => {
  const providers = configuredProviders({});
  try {
    expect(providers[0]._getConnection().url).toBe(
      "https://opbnb-testnet-rpc.bnbchain.org",
    );
    expect(providers[1]._getConnection().url).toBe(
      "https://opbnb-testnet-rpc.publicnode.com",
    );
    expect(() =>
      configuredProviders({ MEMO_PRIMARY_RPC_URL: "http://example.invalid" }),
    ).toThrow();
    expect(() =>
      configuredProviders({
        MEMO_PRIMARY_RPC_URL: "https://same.invalid",
        MEMO_SECONDARY_RPC_URL: "https://same.invalid/",
      }),
    ).toThrow();
  } finally {
    providers.forEach((provider) => provider.destroy());
  }
});

it("requires a trusted deployment manifest before any chain call", async () => {
  await expect(configuredChain({})).rejects.toMatchObject({
    code: "DEPLOYMENT_MISMATCH",
  });
  await expect(
    configuredChain({
      MEMO_CHAIN_MANIFEST_PATH: "does-not-exist",
      MEMO_CHAIN_MANIFEST_SHA256: "0x" + "1".repeat(64),
    }),
  ).rejects.toMatchObject({ code: "DEPLOYMENT_MISMATCH" });
});

it("sanitizes invalid signing keys and refuses ambiguous signer settings", async () => {
  const providers = configuredProviders({});
  try {
    await expect(
      configuredSigner(providers[0], {
        MEMO_RELAYER_PRIVATE_KEY: "secret-test-invalid",
      }),
    ).rejects.toMatchObject({ message: "CHAIN_STATE_UNCERTAIN" });
    await expect(
      configuredSigner(providers[0], {
        MEMO_RELAYER_PRIVATE_KEY: "secret-test-invalid",
        MEMO_SIGNER_MODULE_PATH: "fake-module",
      }),
    ).rejects.toMatchObject({ message: "CHAIN_STATE_UNCERTAIN" });
  } finally {
    providers.forEach((provider) => provider.destroy());
  }
});
