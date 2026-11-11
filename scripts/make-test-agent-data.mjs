import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { computeAddress, getAddress } from "ethers";

const input = process.argv[2];
if (!input || process.argv.length !== 3) {
  console.error("Usage: node scripts/make-test-agent-data.mjs /absolute/path/identity-result.json");
  process.exitCode = 1;
} else {
  try {
    const file = path.resolve(input);
    const output = JSON.parse(await readFile(file, "utf8"));
    const did = output?.data?.did;
    const publicKey = output?.data?.publicKey;
    if (
      output?.schema !== "memo.agent-opbnb-cli-result/1" ||
      output?.ok !== true ||
      typeof did !== "string" ||
      typeof publicKey !== "string" ||
      !/^did:memo:agent:5611:0x[0-9a-f]{40}$/.test(did) ||
      !/^0x04[0-9a-fA-F]{128}$/.test(publicKey) ||
      computeAddress(publicKey) !== getAddress(did.split(":").at(-1))
    ) {
      throw new Error("IDENTITY_OUTPUT_INVALID");
    }
    const keyId = `${did}#identity-key`;
    const profile = {
      name: `opBNB Test Agent ${did.slice(-8)}`,
      description: "Isolated Agent DID integration test",
    };
    const document = {
      "@context": ["https://www.w3.org/ns/did/v1"],
      id: did,
      verificationMethod: [
        {
          id: keyId,
          type: "EcdsaSecp256k1VerificationKey2019",
          controller: did,
          publicKeyHex: publicKey,
        },
      ],
      authentication: [keyId],
    };
    const directory = path.dirname(file);
    const profilePath = path.join(directory, "profile.json");
    const documentPath = path.join(directory, "document.json");
    await writeFile(profilePath, JSON.stringify(profile, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await writeFile(documentPath, JSON.stringify(document, null, 2) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    console.log(JSON.stringify({ did, profilePath, documentPath }));
  } catch (error) {
    console.error(
      ["EEXIST", "IDENTITY_OUTPUT_INVALID"].includes(error?.code || error?.message)
        ? "TEST_DATA_EXISTS_OR_IDENTITY_INVALID"
        : "TEST_DATA_CREATION_FAILED",
    );
    process.exitCode = 1;
  }
}
