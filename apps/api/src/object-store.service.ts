import { Injectable } from "@nestjs/common";
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { canonicalJson, sha256Canonical } from "../../../packages/protocol/src/index.js";
import { RuntimeConfigService } from "./config.service.js";

@Injectable()
export class ContentAddressedObjectStore {
  private readonly root: string;

  constructor(config: RuntimeConfigService) {
    this.root = resolve(config.value.dataRoot, "objects");
    mkdirSync(this.root, { recursive: true, mode: 0o700 });
  }

  put(value: unknown): string {
    const encoded = canonicalJson(value);
    if (Buffer.byteLength(encoded) > 65_536) throw new Error("CONTENT_OBJECT_TOO_LARGE");
    const hash = sha256Canonical(value);
    const path = resolve(this.root, hash.slice(2));
    if (!existsSync(path)) {
      const temporary = path + "." + process.pid + "." + randomUUID() + ".tmp";
      writeFileSync(temporary, encoded, { mode: 0o600, flag: "wx" });
      renameSync(temporary, path);
      chmodSync(path, 0o600);
    }
    return hash;
  }

  get(hash: string): unknown {
    if (!/^0x[0-9a-f]{64}$/.test(hash)) throw new Error("INVALID_OBJECT_HASH");
    const path = resolve(this.root, hash.slice(2));
    const value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (sha256Canonical(value) !== hash) throw new Error("CONTENT_HASH_MISMATCH");
    return value;
  }
}
