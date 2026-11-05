import { describe, expect, it } from "vitest";
import { Wallet, getBytes } from "ethers";
import { RemoteKmsDigestSigner } from "../../packages/aa-client/src/index.js";

describe("KMS/HSM UserOperation signer adapter", () => {
  it("accepts only a recoverable signature from the configured owner", async () => {
    const wallet = Wallet.createRandom();
    const digest = "0x" + "42".repeat(32);
    const signer = new RemoteKmsDigestSigner({
      provider: "kms",
      keyId: "test-key",
      address: wallet.address,
      endpoint: "https://kms.internal.example/sign",
      fetcher: async (_input, init) => {
        const request = JSON.parse(String(init?.body)) as { digest: string; algorithm: string };
        expect(request).toMatchObject({ digest, algorithm: "secp256k1-eip191" });
        return new Response(JSON.stringify({ address: wallet.address, signature: await wallet.signMessage(getBytes(request.digest)) }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      },
    });
    await expect(signer.signDigest(digest)).resolves.toMatch(/^0x[0-9a-f]{130}$/);
  });

  it("rejects non-HTTPS signer bridges", () => {
    expect(() => new RemoteKmsDigestSigner({
      provider: "hsm", keyId: "key", address: "0x1000000000000000000000000000000000000001",
      endpoint: "http://kms.internal/sign",
    })).toThrow(/REQUIRES_HTTPS/);
  });
});
