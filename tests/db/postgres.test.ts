import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { pool, runMigrations } from '../../src/db/postgres'

describe('postgres', () => {
  beforeAll(async () => {
    await runMigrations()
  })


  test('migrations table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'migrations'`
    )
    expect(rows.length).toBe(1)
  })

  test('users table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`
    )
    expect(rows.length).toBe(1)
  })

  test('jobs table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'jobs'`
    )
    expect(rows.length).toBe(1)
  })

  test('research_results table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'research_results'`
    )
    expect(rows.length).toBe(1)
  })

  test('runMigrations is idempotent', async () => {
    await expect(runMigrations()).resolves.toBeUndefined()
  })

  test('can insert and retrieve a user', async () => {
    const { rows } = await pool.query(
      `INSERT INTO users (goals) VALUES ($1) RETURNING id, goals`,
      ['become a security engineer']
    )
    expect(rows[0].goals).toBe('become a security engineer')
    await pool.query('DELETE FROM users WHERE id = $1', [rows[0].id])
  })

  test('can insert and retrieve a job with default stage', async () => {
    const { rows } = await pool.query(
      `INSERT INTO jobs (job_title, company, link) VALUES ($1, $2, $3) RETURNING id, stage`,
      ['Security Engineer', 'Acme Corp', 'https://example.com/job/1']
    )
    expect(rows[0].stage).toBe('not_applied')
    await pool.query('DELETE FROM jobs WHERE id = $1', [rows[0].id])
  })
})
