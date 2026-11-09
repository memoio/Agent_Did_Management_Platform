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
      CREATE INDEX IF NOT EXISTS operations_state_idx ON operations(state,updated_at);
      CREATE INDEX IF NOT EXISTS intents_agent_idx ON intents(agent_did,created_at);
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
