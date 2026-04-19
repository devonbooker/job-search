import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import type { AgentEvent, Snapshot } from '../../src/agents/events'
import { AgentRole } from '../../src/agents/types'
import Anthropic from '@anthropic-ai/sdk'
import { MessageQueue } from '../../src/agents/queue'
import { MessageType, type Message } from '../../src/agents/types'
import { HttpApiAgent } from '../../src/http/http-api-agent'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-http-api-agent.db'

describe('AgentEvent / Snapshot types', () => {
  test('AgentEvent carries id, type, from, payload, timestamp', () => {
    const evt: AgentEvent = {
      id: 1,
      type: 'status',
      from: AgentRole.ORCHESTRATOR,
      payload: { sessionId: 's1', stage: 'intake' },
      timestamp: Date.now(),
    }
    expect(evt.id).toBe(1)
  })

  test('Snapshot aggregates stage + buffered events + optional payloads', () => {
    const snap: Snapshot = {
      sessionId: 's1',
      stage: 'intake',
      events: [],
    }
    expect(snap.sessionId).toBe('s1')
  })
})

describe('HttpApiAgent.handleMessage', () => {
  let queue: MessageQueue
  let agent: HttpApiAgent

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('creates session meta on first event for sessionId', async () => {
    const msg: Message = {
      id: 'm1',
      from_agent: AgentRole.ORCHESTRATOR,
      to_agent: AgentRole.HTTP_API,
      type: MessageType.STATUS,
      payload: { sessionId: 's1', stage: 'intake', agent: AgentRole.ORCHESTRATOR, message: 'starting' },
      created_at: Date.now(),
      acked_at: null,
    }
    await agent.handleMessage(msg)
    const snap = agent.getSnapshot('s1')
    expect(snap).not.toBeNull()
    expect(snap!.stage).toBe('intake')
    expect(snap!.events).toHaveLength(1)
    expect(snap!.events[0].type).toBe('status')
    expect(snap!.events[0].id).toBe(1)
  })

  test('assigns monotonic ids per session', async () => {
    for (let i = 0; i < 3; i++) {
      await agent.handleMessage({
        id: `m${i}`,
        from_agent: AgentRole.ORCHESTRATOR,
        to_agent: AgentRole.HTTP_API,
        type: MessageType.STATUS,
        payload: { sessionId: 's1', stage: 'intake', agent: AgentRole.ORCHESTRATOR, message: String(i) },
        created_at: Date.now(),
        acked_at: null,
      })
    }
    const snap = agent.getSnapshot('s1')!
    expect(snap.events.map(e => e.id)).toEqual([1, 2, 3])
  })

  test('buffer caps at 200, drops oldest', async () => {
    for (let i = 0; i < 250; i++) {
      await agent.handleMessage({
        id: `m${i}`,
        from_agent: AgentRole.ORCHESTRATOR,
        to_agent: AgentRole.HTTP_API,
        type: MessageType.STATUS,
        payload: { sessionId: 's1', stage: 'intake', agent: AgentRole.ORCHESTRATOR, message: String(i) },
        created_at: Date.now(),
        acked_at: null,
      })
    }
    const snap = agent.getSnapshot('s1')!
    expect(snap.events).toHaveLength(200)
    expect(snap.events[0].id).toBe(51)
    expect(snap.events[199].id).toBe(250)
  })

  test('RESULT from RESUME_LEAD populates resumeSections in snapshot', async () => {
    await agent.handleMessage({
      id: 'm1',
      from_agent: AgentRole.RESUME_LEAD,
      to_agent: AgentRole.HTTP_API,
      type: MessageType.RESULT,
      payload: {
        sessionId: 's1',
        sections: [{ title: 'Summary', content: 'Hi' }],
      },
      created_at: Date.now(),
      acked_at: null,
    })
    const snap = agent.getSnapshot('s1')!
    expect(snap.resumeSections).toEqual([{ title: 'Summary', content: 'Hi' }])
  })

  test('ignores messages without sessionId in payload', async () => {
    await agent.handleMessage({
      id: 'm1',
      from_agent: AgentRole.ORCHESTRATOR,
      to_agent: AgentRole.HTTP_API,
      type: MessageType.STATUS,
      payload: { foo: 'bar' },
      created_at: Date.now(),
      acked_at: null,
    })
    expect(agent.getSnapshot('s1')).toBeNull()
  })
})
