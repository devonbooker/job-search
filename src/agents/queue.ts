import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import type { AgentRole, MessageType, Message } from './types'

interface RawRow {
  id: string
  from_agent: string
  to_agent: string
  type: string
  payload: string
  created_at: number
  acked_at: number | null
}

export class MessageQueue {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_to_unacked
      ON messages (to_agent, created_at)
      WHERE acked_at IS NULL
    `)
  }

  send(from: AgentRole, to: AgentRole, type: MessageType, payload: unknown): void {
    this.db.run(
      'INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), from, to, type, JSON.stringify(payload), Date.now()]
    )
  }

  receive(agent: AgentRole): Message | null {
    const row = this.db
      .query<RawRow, [string]>(
        'SELECT * FROM messages WHERE to_agent = ? AND acked_at IS NULL ORDER BY created_at ASC LIMIT 1'
      )
      .get(agent)

    if (!row) return null

    return {
      id: row.id,
      from_agent: row.from_agent as AgentRole,
      to_agent: row.to_agent as AgentRole,
      type: row.type as MessageType,
      payload: JSON.parse(row.payload),
      created_at: row.created_at,
      acked_at: row.acked_at,
    }
  }

  ack(id: string): void {
    this.db.run('UPDATE messages SET acked_at = ? WHERE id = ?', [Date.now(), id])
  }

  close(): void {
    this.db.close()
  }
}
