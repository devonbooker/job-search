import { describe, test, expect } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { MessageQueue } from '../../src/agents/queue'
import { Orchestrator } from '../../src/agents/orchestrator'
import { HttpApiAgent } from '../../src/http/http-api-agent'
import { createApp } from '../../src/http/server'
import { existsSync, unlinkSync } from 'fs'

const TEST_DB = './test-integration.db'
const TOKEN = 'c'.repeat(64)

describe('integration: HTTP → HTTP_API → ORCHESTRATOR → HTTP_API', () => {
  test('POST /sessions enqueues to orchestrator; orchestrator STATUS reaches HttpApiAgent snapshot', async () => {
    const queue = new MessageQueue(TEST_DB)
    const anthropic = new Anthropic({ apiKey: 'test-key' })
    const httpApiAgent = new HttpApiAgent(queue, anthropic)
    const orchestrator = new Orchestrator(queue, anthropic)
    const app = createApp({ httpApiAgent, token: TOKEN })

    const run1 = httpApiAgent.run()
    const run2 = orchestrator.run()

    const res = await app.request('/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
      body: JSON.stringify({ goals: 'g', experience: 'e', preferences: 'p' }),
    })
    expect(res.status).toBe(200)
    const { sessionId } = await res.json()

    await Bun.sleep(400)

    const snap = httpApiAgent.getSnapshot(sessionId)
    expect(snap).not.toBeNull()
    expect(snap!.events.some(e => e.type === 'status' && (e.payload as { stage?: string }).stage === 'intake')).toBe(true)

    await orchestrator.stop()
    await httpApiAgent.stop()
    await run1
    await run2
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })
})
