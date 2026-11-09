import { Injectable, ServiceUnavailableException, type OnModuleDestroy } from "@nestjs/common";
import { Pool, type PoolClient, type QueryResultRow } from "pg";

@Injectable()
export class PlatformDb implements OnModuleDestroy {
  private pool?: Pool;
  private initialized?: Promise<void>;

  private connection(): Pool {
    if (!process.env.DATABASE_URL) throw new ServiceUnavailableException({code:"DATABASE_NOT_CONFIGURED",message:"PostgreSQL is required"});
    this.pool ??= new Pool({ connectionString: process.env.DATABASE_URL, max: 8, connectionTimeoutMillis: 5000 });
    return this.pool;
  }

  async init(): Promise<void> {
    this.initialized ??= this.connection().query(`
      CREATE TABLE IF NOT EXISTS schema_migrations (version integer PRIMARY KEY, name text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS challenges (id uuid PRIMARY KEY, role text NOT NULL, address text NOT NULL, message text NOT NULL, expires_at timestamptz NOT NULL, used_at timestamptz);
      CREATE TABLE IF NOT EXISTS sessions (token_hash text PRIMARY KEY, role text NOT NULL, address text NOT NULL, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS operations (id uuid PRIMARY KEY, intent_id uuid UNIQUE NOT NULL, agent_did text NOT NULL, action_type text NOT NULL, action_digest text NOT NULL, state text NOT NULL, request_id uuid UNIQUE NOT NULL, submission_id text, tx_hash text, block_number bigint, block_hash text, confirmations integer NOT NULL DEFAULT 0, finality_source text, error_code text, idempotency_subject text, idempotency_key text, idempotency_body_hash text, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(), UNIQUE(idempotency_subject,idempotency_key));
      CREATE TABLE IF NOT EXISTS intents (id uuid PRIMARY KEY, agent_did text NOT NULL, action_type text NOT NULL, intent jsonb NOT NULL, profile jsonb, document jsonb, context jsonb, created_by text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE intents ADD COLUMN IF NOT EXISTS context jsonb;
      CREATE TABLE IF NOT EXISTS intent_signatures (intent_id uuid NOT NULL REFERENCES intents(id), role text NOT NULL, address text NOT NULL, signature text NOT NULL, PRIMARY KEY(intent_id,role));
      CREATE TABLE IF NOT EXISTS agent_documents (agent_did text PRIMARY KEY, profile jsonb NOT NULL, document jsonb NOT NULL, profile_hash text NOT NULL, document_hash text NOT NULL, updated_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS chain_events (deployment_id text NOT NULL, block_hash text NOT NULL, tx_hash text NOT NULL, log_index integer NOT NULL, block_number bigint NOT NULL, agent_did text NOT NULL, event jsonb NOT NULL, PRIMARY KEY(deployment_id,block_hash,tx_hash,log_index));
      CREATE TABLE IF NOT EXISTS index_cursor (deployment_id text PRIMARY KEY, block_number bigint NOT NULL, block_hash text NOT NULL);
      CREATE TABLE IF NOT EXISTS audit_events (id bigserial PRIMARY KEY, operation_id uuid, intent_id uuid, event_type text NOT NULL, actor text, detail jsonb NOT NULL DEFAULT '{}'::jsonb, created_at timestamptz NOT NULL DEFAULT now());
      CREATE TABLE IF NOT EXISTS pairing_exchanges (id uuid PRIMARY KEY, kind text NOT NULL CHECK(kind IN ('platform-invitation','agent-offer')), handle_hash text NOT NULL UNIQUE, creator text NOT NULL, agent_did text, manager_address text, max_scopes jsonb NOT NULL, max_term_seconds integer NOT NULL, requested_scopes jsonb, requested_term_seconds integer, discoverable boolean NOT NULL DEFAULT false, state text NOT NULL, expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      ALTER TABLE pairing_exchanges ADD COLUMN IF NOT EXISTS completion_expires_at timestamptz;
      CREATE TABLE IF NOT EXISTS pairing_idempotency (subject text NOT NULL, key text NOT NULL, body_hash text NOT NULL, exchange_id uuid NOT NULL REFERENCES pairing_exchanges(id), PRIMARY KEY(subject,key));
      CREATE TABLE IF NOT EXISTS pairing_bindings (id uuid PRIMARY KEY, exchange_id uuid NOT NULL UNIQUE REFERENCES pairing_exchanges(id), agent_did text NOT NULL, manager_address text NOT NULL, max_scopes jsonb NOT NULL, max_term_seconds integer NOT NULL, state text NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
      CREATE UNIQUE INDEX IF NOT EXISTS one_active_pairing_per_agent ON pairing_bindings(agent_did) WHERE state='ACTIVE';
      CREATE TABLE IF NOT EXISTS management_drafts (id uuid PRIMARY KEY, binding_id uuid NOT NULL REFERENCES pairing_bindings(id), agent_did text NOT NULL, manager_address text NOT NULL, scopes jsonb NOT NULL, term_seconds integer NOT NULL, discoverable boolean NOT NULL, state text NOT NULL, intent_id uuid REFERENCES intents(id), operation_id uuid REFERENCES operations(id), expires_at timestamptz NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS management_drafts_agent_idx ON management_drafts(agent_did,state,created_at);
      CREATE TABLE IF NOT EXISTS agent_document_versions (intent_id uuid PRIMARY KEY REFERENCES intents(id), agent_did text NOT NULL, action_type text NOT NULL, profile jsonb, document jsonb, profile_hash text, document_hash text, revision bigint, confirmed_at timestamptz);
      CREATE INDEX IF NOT EXISTS agent_document_versions_did_idx ON agent_document_versions(agent_did,confirmed_at DESC);
      CREATE TABLE IF NOT EXISTS agent_instances (instance_id text PRIMARY KEY, agent_did text NOT NULL, name text NOT NULL, public_key text NOT NULL, credential jsonb NOT NULL, expires_at timestamptz NOT NULL, state text NOT NULL DEFAULT 'ACTIVE', created_at timestamptz NOT NULL DEFAULT now());
      CREATE INDEX IF NOT EXISTS agent_instances_did_idx ON agent_instances(agent_did,created_at DESC);
      CREATE INDEX IF NOT EXISTS operations_state_idx ON operations(state,updated_at);
      CREATE INDEX IF NOT EXISTS intents_agent_idx ON intents(agent_did,created_at);
      INSERT INTO schema_migrations(version,name) VALUES(2,'pairing-and-document-versions') ON CONFLICT(version) DO NOTHING;
    `).then(()=>{}).catch(error=>{ this.initialized=undefined; throw error; });
    await this.initialized;
  }

  async query<T extends QueryResultRow = QueryResultRow>(sql: string, values: unknown[] = []): Promise<T[]> {
    await this.init();
    return (await this.connection().query<T>(sql,values)).rows;
  }

  async transaction<T>(run:(client:PoolClient)=>Promise<T>): Promise<T> {
    await this.init();
    const client=await this.connection().connect();
    try { await client.query("BEGIN"); const result=await run(client); await client.query("COMMIT"); return result; }
    catch(error){ await client.query("ROLLBACK"); throw error; }
    finally { client.release(); }
  }

  async close(){ await this.pool?.end(); }
  async onModuleDestroy(){await this.close();}
}
