import { Pool } from 'pg'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export async function runMigrations(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const migrationsDir = join(import.meta.dir, 'migrations')
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM migrations WHERE filename = $1',
        [file]
      )
      if (rows.length === 0) {
        const sql = await readFile(join(migrationsDir, file), 'utf-8')
        await client.query(sql)
        await client.query('INSERT INTO migrations (filename) VALUES ($1)', [file])
      }
    }
  } finally {
    client.release()
  }
}
