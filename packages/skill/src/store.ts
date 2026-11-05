import { DatabaseSync } from "node:sqlite";
import { chmodSync, existsSync } from "node:fs";

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA busy_timeout=10000; PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;");
    this.createTables();
    this.migrateInstallations();
    for (const file of [path, `${path}-wal`, `${path}-shm`]) if (existsSync(file)) chmodSync(file, 0o600);
  }

  private createTables(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS installations(
        installation_id TEXT PRIMARY KEY, agent_did TEXT UNIQUE NOT NULL, network TEXT NOT NULL,
        identity_key_handle TEXT NOT NULL, identity_account TEXT NOT NULL, public_key TEXT NOT NULL,
        last_identity_revision INTEGER NOT NULL, state TEXT NOT NULL, profile_hash TEXT,
        registry_address TEXT, management_registry_address TEXT, api_url TEXT,
        key_provider TEXT, default_instance_state TEXT, deployment_environment TEXT,
        local_profile_json TEXT
      );
      CREATE TABLE IF NOT EXISTS instance_keys(
        instance_id TEXT PRIMARY KEY, name TEXT NOT NULL, key_handle TEXT UNIQUE NOT NULL,
        public_key TEXT NOT NULL, credential_json TEXT NOT NULL, state TEXT NOT NULL, expires_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS operations(
        operation_id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, action_type TEXT NOT NULL,
        action_digest TEXT NOT NULL, tx_hash TEXT, block_number INTEGER, block_hash TEXT, state TEXT NOT NULL,
        data_json TEXT NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_grants(
        pairing_grant_id TEXT PRIMARY KEY, token_secret_handle TEXT NOT NULL, token_hash TEXT NOT NULL,
        state TEXT NOT NULL, expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS pairing_exchanges(
        exchange_id TEXT PRIMARY KEY, kind TEXT NOT NULL, secret_handle TEXT NOT NULL,
        package_json TEXT NOT NULL, state TEXT NOT NULL, registration_operation_id TEXT,
        expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS management_requests(
        request_id TEXT PRIMARY KEY, manager_account TEXT NOT NULL, canonical_payload_hash TEXT NOT NULL,
        request_version INTEGER NOT NULL, payload_json TEXT NOT NULL, state TEXT NOT NULL,
        expires_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS management_relationships(
        relationship_id TEXT PRIMARY KEY, request_id TEXT UNIQUE NOT NULL, payload_json TEXT NOT NULL,
        signature TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL
      );
      CREATE TABLE IF NOT EXISTS consumed_challenges(
        issuer TEXT NOT NULL, nonce_hash TEXT NOT NULL, expires_at INTEGER NOT NULL,
        PRIMARY KEY(issuer, nonce_hash)
      );
    `);
  }

  private migrateInstallations(): void {
    const columns = this.db.prepare("PRAGMA table_info(installations)").all() as Array<Record<string, unknown>>;
    if (columns.length === 0) return;
    const names = new Set(columns.map((column) => String(column.name)));
    const needsNullableMigration = columns.some((column) =>
      ["registry_address", "management_registry_address", "api_url"].includes(String(column.name)) && Number(column.notnull) === 1);
    if (needsNullableMigration) {
      this.transaction(() => this.db.exec(`
        ALTER TABLE installations RENAME TO installations_v1_backup;
        CREATE TABLE installations(
          installation_id TEXT PRIMARY KEY, agent_did TEXT UNIQUE NOT NULL, network TEXT NOT NULL,
          identity_key_handle TEXT NOT NULL, identity_account TEXT NOT NULL, public_key TEXT NOT NULL,
          last_identity_revision INTEGER NOT NULL, state TEXT NOT NULL, profile_hash TEXT,
          registry_address TEXT, management_registry_address TEXT, api_url TEXT,
          key_provider TEXT, default_instance_state TEXT, deployment_environment TEXT,
          local_profile_json TEXT
        );
        INSERT INTO installations(installation_id,agent_did,network,identity_key_handle,identity_account,public_key,
          last_identity_revision,state,profile_hash,registry_address,management_registry_address,api_url,key_provider)
        SELECT installation_id,agent_did,network,identity_key_handle,identity_account,public_key,last_identity_revision,
          CASE WHEN state='LOCAL_KEY_CREATED' THEN 'LOCAL_IDENTITY_READY' ELSE state END,
          profile_hash,registry_address,management_registry_address,api_url,'env-master-key'
        FROM installations_v1_backup;
        DROP TABLE installations_v1_backup;
      `));
      return;
    }
    if (!names.has("key_provider")) this.db.exec("ALTER TABLE installations ADD COLUMN key_provider TEXT");
    if (!names.has("default_instance_state")) this.db.exec("ALTER TABLE installations ADD COLUMN default_instance_state TEXT");
    if (!names.has("deployment_environment")) this.db.exec("ALTER TABLE installations ADD COLUMN deployment_environment TEXT");
    if (!names.has("local_profile_json")) this.db.exec("ALTER TABLE installations ADD COLUMN local_profile_json TEXT");
    this.db.exec("UPDATE installations SET state='LOCAL_IDENTITY_READY' WHERE state='LOCAL_KEY_CREATED'");
  }

  transaction<T>(work: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = work();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  close(): void { this.db.close(); }
}
