import { expect, it } from "vitest";
import { TypedDataEncoder, verifyTypedData } from "ethers";
import vectors from "./protocol-vectors.json" with { type: "json" };
import actions from "../../specs/chain-integration-v1/action-types.json" with { type: "json" };
import {
  hashJson,
  hashScopes,
  intentValidator,
} from "../../packages/chain-adapter/src/index.js";

it("recomputes public synthetic vectors for every v1 action and rejects domain/message mutations", () => {
  expect(vectors.vectors.map((v) => v.intent.actionType).sort()).toEqual(
    Object.keys(actions.actions).sort(),
  );
  for (const { intent, signatures } of vectors.vectors) {
    const types = intent.types as unknown as Record<
      string,
      { name: string; type: string }[]
    >;
    expect(intentValidator(intent)).toBe(true);
    expect(TypedDataEncoder.hash(intent.domain, types, intent.message)).toBe(
      intent.digest,
    );
    for (const signed of signatures) {
      expect(
        verifyTypedData(intent.domain, types, intent.message, signed.signature),
      ).toBe(signed.address);
      expect(
        verifyTypedData(
          { ...intent.domain, chainId: 204 },
          types,
          intent.message,
          signed.signature,
        ),
      ).not.toBe(signed.address);
      expect(
        verifyTypedData(
          intent.domain,
          types,
          { ...intent.message, nonce: "99" },
          signed.signature,
        ),
      ).not.toBe(signed.address);
    }
  }
  for (const vector of vectors.hashes) {
    if (vector.input) expect(hashJson(vector.input)).toBe(vector.sha256);
    if (vector.scopes) expect(hashScopes(vector.scopes)).toBe(vector.sha256);
  }
});
