import type { Pool } from 'pg'

export interface SessionStoreConfig {
  pool: Pool
  /** Postgres table name. Must have columns: session_id UUID PK, state JSONB, updated_at. May also have stage TEXT. */
  table: string
}

export class SessionStore<T> {
  constructor(private readonly config: SessionStoreConfig) {}

  async load(sessionId: string): Promise<T | undefined> {
    const { rows } = await this.config.pool.query(
      `SELECT state FROM ${this.config.table} WHERE session_id = $1`,
      [sessionId],
    )
    if (rows.length === 0) return undefined
    return rows[0].state as T
  }

  async save(sessionId: string, state: T, stage?: string): Promise<void> {
    if (stage !== undefined) {
      await this.config.pool.query(
        `INSERT INTO ${this.config.table} (session_id, stage, state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_id) DO UPDATE
         SET stage = EXCLUDED.stage, state = EXCLUDED.state, updated_at = NOW()`,
        [sessionId, stage, state],
      )
    } else {
      await this.config.pool.query(
        `INSERT INTO ${this.config.table} (session_id, state, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (session_id) DO UPDATE
         SET state = EXCLUDED.state, updated_at = NOW()`,
        [sessionId, state],
      )
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.config.pool.query(
      `DELETE FROM ${this.config.table} WHERE session_id = $1`,
      [sessionId],
    )
  }

  async loadAll(): Promise<Map<string, T>> {
    const { rows } = await this.config.pool.query(
      `SELECT session_id, state FROM ${this.config.table}`,
    )
    const map = new Map<string, T>()
    for (const row of rows) map.set(row.session_id, row.state as T)
    return map
  }
}
