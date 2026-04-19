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

describe('HttpApiAgent.startSession / sendCommand / subscribe', () => {
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

  test('startSession enqueues DISPATCH to ORCHESTRATOR with HTTP_API as from_agent', () => {
    agent.startSession({
      sessionId: 's1',
      goals: 'g',
      experience: 'e',
      preferences: 'p',
    })
    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.HTTP_API)
    expect(msg!.type).toBe(MessageType.DISPATCH)
    expect((msg!.payload as { goals: string }).goals).toBe('g')
  })

  test('sendCommand forwards arbitrary payload to ORCHESTRATOR', () => {
    agent.sendCommand('s1', { sessionId: 's1', targetTitles: ['Security Engineer'] })
    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect((msg!.payload as { targetTitles: string[] }).targetTitles).toEqual(['Security Engineer'])
  })

  test('subscribe replays buffered events from lastEventId+1 then streams live', async () => {
    for (let i = 0; i < 3; i++) {
      await agent.handleMessage({
        id: `m${i}`,
        from_agent: AgentRole.ORCHESTRATOR,
        to_agent: AgentRole.HTTP_API,
        type: MessageType.STATUS,
        payload: { sessionId: 's1', stage: 'intake', message: String(i) },
        created_at: Date.now(),
        acked_at: null,
      })
    }

    const collected: number[] = []
    const iter = agent.subscribe('s1', 1)
    const consumer = (async () => {
      for await (const evt of iter) {
        collected.push(evt.id)
        if (collected.length === 3) break
      }
    })()

    await Bun.sleep(20)
    await agent.handleMessage({
      id: 'm-live',
      from_agent: AgentRole.ORCHESTRATOR,
      to_agent: AgentRole.HTTP_API,
      type: MessageType.STATUS,
      payload: { sessionId: 's1', stage: 'researching', message: 'live' },
      created_at: Date.now(),
      acked_at: null,
    })

    await consumer
    expect(collected).toEqual([2, 3, 4])
  })
})

describe('HttpApiAgent.purge', () => {
  test('drops sessions with no subscribers and stale lastActivityAt', () => {
    const queue = new MessageQueue(TEST_DB)
    const agent = new HttpApiAgent(queue, new Anthropic({ apiKey: 'test-key' }))

    agent.startSession({ sessionId: 's1', goals: 'g', experience: 'e', preferences: 'p' })
    expect(agent.getSnapshot('s1')).not.toBeNull()

    agent.purgeStaleSessions(Date.now() + 2 * 60 * 60 * 1000)
    expect(agent.getSnapshot('s1')).toBeNull()

    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })
})
