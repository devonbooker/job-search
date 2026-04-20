import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { MessageQueue } from '../../src/agents/queue'
import { HttpApiAgent } from '../../src/http/http-api-agent'
import { createApp } from '../../src/http/server'
import { existsSync, unlinkSync } from 'fs'
import { AgentRole } from '../../src/agents/types'

const TEST_DB = './test-routes.db'
const TOKEN = 'a'.repeat(64)

describe('auth middleware', () => {
  let queue: MessageQueue
  let agent: HttpApiAgent
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))
    app = createApp({ httpApiAgent: agent, token: TOKEN })
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('401 when token missing', async () => {
    const res = await app.request('/sessions', { method: 'POST', body: '{}' })
    expect(res.status).toBe(401)
  })

  test('401 when token wrong', async () => {
    const res = await app.request('/sessions', {
      method: 'POST',
      body: '{}',
      headers: { Authorization: 'Bearer wrong' },
    })
    expect(res.status).toBe(401)
  })
})

describe('POST /sessions', () => {
  let queue: MessageQueue
  let agent: HttpApiAgent
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))
    app = createApp({ httpApiAgent: agent, token: TOKEN })
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('returns sessionId and enqueues dispatch to ORCHESTRATOR', async () => {
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ goals: 'g', experience: 'e', preferences: 'p' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(typeof body.sessionId).toBe('string')
    expect(body.sessionId.length).toBeGreaterThan(10)

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect((msg!.payload as { sessionId: string }).sessionId).toBe(body.sessionId)
  })

  test('400 on invalid body', async () => {
    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ goals: 'g' }),  // missing fields
    })
    expect(res.status).toBe(400)
  })
})

describe('GET /sessions/:id', () => {
  let queue: MessageQueue
  let agent: HttpApiAgent
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))
    app = createApp({ httpApiAgent: agent, token: TOKEN })
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('returns snapshot for existing session', async () => {
    agent.startSession({ sessionId: 's1', goals: 'g', experience: 'e', preferences: 'p' })
    const res = await app.request('/sessions/s1', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.sessionId).toBe('s1')
    expect(Array.isArray(body.events)).toBe(true)
  })

  test('404 on unknown session', async () => {
    const res = await app.request('/sessions/nope', {
      headers: { Authorization: `Bearer ${TOKEN}` },
    })
    expect(res.status).toBe(404)
  })
})

describe('Jobs CRUD', () => {
  let queue: MessageQueue
  let agent: HttpApiAgent
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))
    app = createApp({ httpApiAgent: agent, token: TOKEN })
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('GET /jobs returns array or 503', async () => {
    const res = await app.request('/jobs', { headers: { Authorization: `Bearer ${TOKEN}` } })
    expect([200, 503]).toContain(res.status)
    if (res.status === 200) {
      const body = await res.json()
      expect(Array.isArray(body)).toBe(true)
    }
  })
})

describe('select-titles + approve-resume routes', () => {
  let queue: MessageQueue
  let agent: HttpApiAgent
  let app: ReturnType<typeof createApp>

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))
    app = createApp({ httpApiAgent: agent, token: TOKEN })
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('POST /sessions/:id/select-titles enqueues SelectTitles to ORCHESTRATOR', async () => {
    const res = await app.request('/sessions/abc-123/select-titles', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetTitles: ['Security Engineer'] }),
    })
    expect(res.status).toBe(200)

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    const payload = msg!.payload as { sessionId: string; targetTitles: string[] }
    expect(payload.sessionId).toBe('abc-123')
    expect(payload.targetTitles).toEqual(['Security Engineer'])
  })

  test('POST /sessions/:id/select-titles with empty array returns 400', async () => {
    const res = await app.request('/sessions/abc-123/select-titles', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetTitles: [] }),
    })
    expect(res.status).toBe(400)
  })

  test('POST /sessions/:id/approve-resume enqueues ApproveResume to ORCHESTRATOR', async () => {
    const res = await app.request('/sessions/xyz-456/approve-resume', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(200)

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    const payload = msg!.payload as { sessionId: string }
    expect(payload.sessionId).toBe('xyz-456')
  })

  test('POST /sessions/:id/approve (deprecated) is no longer an API route', async () => {
    const res = await app.request('/sessions/abc-123/approve', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ targetTitles: ['x'] }),
    })
    // Route was removed; SPA fallback serves index.html (200) — no JSON API response
    const body = await res.json().catch(() => null)
    expect(body).toBeNull()
  })
})
