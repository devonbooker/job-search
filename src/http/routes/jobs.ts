import type { Hono } from 'hono'
import { z } from 'zod'
import { pool } from '../../db/postgres'

const newJob = z.object({
  job_title: z.string().min(1),
  company: z.string().min(1),
  link: z.string().url().optional(),
  source: z.string().optional(),
  notes: z.string().optional(),
})

const updateJob = z.object({
  stage: z.enum([
    'not_applied', 'applied', 'phone_screening', 'interview',
    'booked', 'offer_received', 'accepted', 'rejected',
  ]).optional(),
  notes: z.string().optional(),
})

type DbResult<T> = { ok: true; value: T } | { ok: false; status: 503 }
async function run<T>(fn: () => Promise<T>): Promise<DbResult<T>> {
  try {
    return { ok: true, value: await fn() }
  } catch (err) {
    console.error('[jobs] postgres error:', err)
    return { ok: false, status: 503 }
  }
}

export function mountJobRoutes(app: Hono): void {
  app.get('/jobs', async (c) => {
    const r = await run(async () => {
      const { rows } = await pool.query('SELECT * FROM jobs ORDER BY updated_at DESC')
      return rows
    })
    if (!r.ok) return c.json({ error: 'db unavailable' }, r.status)
    return c.json(r.value)
  })

  app.post('/jobs', async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = newJob.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
    const r = await run(async () => {
      const { rows } = await pool.query(
        'INSERT INTO jobs (job_title, company, link, source, notes) VALUES ($1,$2,$3,$4,$5) RETURNING *',
        [parsed.data.job_title, parsed.data.company, parsed.data.link ?? null, parsed.data.source ?? null, parsed.data.notes ?? null],
      )
      return rows[0]
    })
    if (!r.ok) return c.json({ error: 'db unavailable' }, r.status)
    return c.json(r.value)
  })

  app.put('/jobs/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const raw = await c.req.json().catch(() => null)
    const parsed = updateJob.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
    const r = await run(async () => {
      const { rows } = await pool.query(
        `UPDATE jobs SET
          stage = COALESCE($2, stage),
          notes = COALESCE($3, notes),
          updated_at = NOW()
        WHERE id = $1
        RETURNING *`,
        [id, parsed.data.stage ?? null, parsed.data.notes ?? null],
      )
      return rows[0]
    })
    if (!r.ok) return c.json({ error: 'db unavailable' }, r.status)
    if (!r.value) return c.json({ error: 'not found' }, 404)
    return c.json(r.value)
  })

  app.delete('/jobs/:id', async (c) => {
    const id = Number(c.req.param('id'))
    const r = await run(() => pool.query('DELETE FROM jobs WHERE id = $1', [id]))
    if (!r.ok) return c.json({ error: 'db unavailable' }, r.status)
    return c.json({ ok: true })
  })
}
