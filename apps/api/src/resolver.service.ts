import { Injectable } from "@nestjs/common";
import { addressFromDid } from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "./config.service.js";
import { ChainStore } from "./store.service.js";
import { ContentAddressedObjectStore } from "./object-store.service.js";

@Injectable()
export class ResolverService {
  constructor(
    private readonly store: ChainStore,
    private readonly objects: ContentAddressedObjectStore,
    private readonly config: RuntimeConfigService,
  ) {}

  resolve(did: string) {
    addressFromDid(did);
    const row = this.store.identityProjection(did, true);
    if (!row) throw new Error("DID_NOT_CONFIRMED");
    const profileHash = row.profile_hash ? String(row.profile_hash) : undefined;
    const documentHash = row.document_hash ? String(row.document_hash) : undefined;
    const profile = profileHash ? this.objects.get(profileHash) : null;
    const document = documentHash ? this.objects.get(documentHash) : null;
    const blockReference = { number: Number(row.block_number), hash: String(row.block_hash) };
    return {
      did,
      status: String(row.status),
      revision: Number(row.revision),
      nonce: String(row.nonce),
      profile,
      document,
      didDocument: document,
      didResolutionMetadata: {
        verified: true,
        chainId: 985,
        confirmationsSatisfied: true,
        contentHashesVerified: true,
      },
      didDocumentMetadata: {
        state: String(row.status),
        versionId: Number(row.revision),
        blockReference,
      },
      blockReference,
      verified: {
        chainId: 985,
        registry: this.config.value.manifest.didRegistry.address,
        profileHash: profileHash || null,
        documentHash: documentHash || null,
        contentHashesVerified: true,
        confirmationsSatisfied: true,
      },
    };
  }
}
