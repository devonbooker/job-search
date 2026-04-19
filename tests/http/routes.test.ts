import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { MessageQueue } from '../../src/agents/queue'
import { HttpApiAgent } from '../../src/http/http-api-agent'
import { createApp } from '../../src/http/server'
import { existsSync, unlinkSync } from 'fs'

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
