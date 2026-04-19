import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { MessageQueue } from '../../src/agents/queue'
import { HttpApiAgent } from '../../src/http/http-api-agent'
import { AgentRole, MessageType, type Message } from '../../src/agents/types'
import { createApp } from '../../src/http/server'
import { existsSync, unlinkSync } from 'fs'

const TEST_DB = './test-sse.db'
const TOKEN = 'b'.repeat(64)

describe('GET /sessions/:id/events SSE', () => {
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

  test('streams replay + live events', async () => {
    await agent.handleMessage({
      id: 'm1',
      from_agent: AgentRole.ORCHESTRATOR,
      to_agent: AgentRole.HTTP_API,
      type: MessageType.STATUS,
      payload: { sessionId: 's1', stage: 'intake' },
      created_at: Date.now(),
      acked_at: null,
    } as Message)

    const res = await app.request(`/sessions/s1/events?token=${TOKEN}`)
    expect(res.status).toBe(200)
    expect(res.headers.get('content-type')).toContain('text/event-stream')

    const reader = res.body!.getReader()
    const decoder = new TextDecoder()

    // Read first chunk (replay)
    const { value } = await reader.read()
    const chunk = decoder.decode(value)
    expect(chunk).toContain('data:')
    expect(chunk).toContain('"stage":"intake"')

    // Push a live event
    queueMicrotask(() => {
      agent.handleMessage({
        id: 'm2',
        from_agent: AgentRole.RESEARCH_LEAD,
        to_agent: AgentRole.HTTP_API,
        type: MessageType.STATUS,
        payload: { sessionId: 's1', stage: 'researching' },
        created_at: Date.now(),
        acked_at: null,
      } as Message)
    })

    const { value: liveVal } = await reader.read()
    expect(decoder.decode(liveVal)).toContain('"stage":"researching"')

    await reader.cancel()
  })
})
