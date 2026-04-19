import { Hono } from 'hono'
import { randomUUID } from 'crypto'
import type { HttpApiAgent } from '../http-api-agent'
import { intakeBody, approveBody, interviewBody } from '../schemas'

export function mountSessionRoutes(app: Hono, agent: HttpApiAgent): void {
  app.post('/sessions', async (c) => {
    const raw = await c.req.json().catch(() => null)
    const parsed = intakeBody.safeParse(raw)
    if (!parsed.success) {
      return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
    }
    const sessionId = randomUUID()
    agent.startSession({ sessionId, ...parsed.data })
    return c.json({ sessionId })
  })

  app.get('/sessions/:id', (c) => {
    const snap = agent.getSnapshot(c.req.param('id'))
    if (!snap) return c.json({ error: 'not found' }, 404)
    return c.json(snap)
  })

  app.post('/sessions/:id/approve', async (c) => {
    const sessionId = c.req.param('id')
    const raw = await c.req.json().catch(() => null)
    const parsed = approveBody.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
    agent.sendCommand(sessionId, { sessionId, ...parsed.data })
    return c.json({ ok: true })
  })

  app.post('/sessions/:id/interview', async (c) => {
    const sessionId = c.req.param('id')
    const raw = await c.req.json().catch(() => null)
    const parsed = interviewBody.safeParse(raw)
    if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
    agent.sendCommand(sessionId, { sessionId, ...parsed.data })
    return c.json({ ok: true })
  })
}
