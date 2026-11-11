import { mkdir, open, readFile, readdir, rename } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { ChainError, requireChain } from "./errors.js";

export interface Submission {
  submissionId: string;
  requestId: string;
  deploymentId: string;
  digest: string;
  txHash: string;
  rawTransaction: string;
  acceptedAt: string;
  registry: string;
  agent: string;
}
export interface SubmissionJournal {
  get(id: string): Promise<Submission | null>;
  put(value: Submission): Promise<void>;
  entries(): Promise<Submission[]>;
  exclusive<T>(run: () => Promise<T>): Promise<T>;
  health?(): Promise<void>;
}
/** Single relayer, local durable volume. Contains broadcastable raw transactions: server-only, never log/export. */
export class FileSubmissionJournal implements SubmissionJournal {
  constructor(private readonly directory: string) {}
  async health(): Promise<void> {
    await mkdir(this.directory, {recursive:true,mode:0o700});
    const probe=path.join(this.directory,`.health-${randomUUID()}`);
    const handle=await open(probe,"wx",0o600);
    try { await handle.writeFile("ok"); await handle.sync(); }
    finally { await handle.close(); const {unlink}=await import("node:fs/promises"); await unlink(probe); }
  }
  private filename(id: string) {
    requireChain(/^[0-9a-f]{64}$/.test(id));
    return path.join(this.directory, `${id}.json`);
  }
  async get(id: string): Promise<Submission | null> {
    try {
      return JSON.parse(await readFile(this.filename(id), "utf8"));
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new ChainError("CHAIN_STATE_UNCERTAIN", true);
    }
  }
  async put(value: Submission): Promise<void> {
    const destination = this.filename(value.submissionId);
    requireChain(!(await this.get(value.submissionId)), "NONCE_CONFLICT");
    const temp = `${destination}.${randomUUID()}.tmp`;
    const handle = await open(temp, "wx", 0o600);
    try {
      await handle.writeFile(JSON.stringify(value));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await rename(temp, destination);
    // POSIX directory fsync makes the rename durable. Windows does not support directory handles here.
    if (process.platform !== "win32") {
      const dir = await open(this.directory, "r");
      try {
        await dir.sync();
      } finally {
        await dir.close();
      }
    }
  }
  async entries(): Promise<Submission[]> {
    const names = await readdir(this.directory);
    const values = await Promise.all(
      names
        .filter((n) => /^[0-9a-f]{64}\.json$/.test(n))
        .map((n) => this.get(n.slice(0, -5))),
    );
    return values.filter((v): v is Submission => v !== null);
  }
  async exclusive<T>(run: () => Promise<T>): Promise<T> {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    let handle;
    try {
      handle = await open(
        path.join(this.directory, "relayer.lock"),
        "wx",
        0o600,
      );
    } catch {
      throw new ChainError("CHAIN_STATE_UNCERTAIN", true);
    }
    try {
      return await run();
    } finally {
      await handle.close();
      const { unlink } = await import("node:fs/promises");
      await unlink(path.join(this.directory, "relayer.lock"));
    }
  }
}
