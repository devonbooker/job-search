import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { IntakeLead } from '../../../src/agents/intake/intake-lead'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type IntakeDispatchPayload,
  type ProfileBuilderResultPayload,
  type Message,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-intake-lead.db'

describe('IntakeLead', () => {
  let queue: MessageQueue
  let agent: IntakeLead

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new IntakeLead(queue, new Anthropic({ apiKey: 'test-key' }))
  })

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('forwards intake dispatch to ProfileBuilder', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, {
      sessionId: 'il-1',
      goals: 'security engineer',
      experience: '5 years',
      preferences: 'remote',
    } satisfies IntakeDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.PROFILE_BUILDER)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.INTAKE_LEAD)
    expect(msg!.type).toBe(MessageType.DISPATCH)
    expect((msg!.payload as { sessionId: string }).sessionId).toBe('il-1')
  })

  test('emits STATUS to HTTP_API on receiving dispatch', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, {
      sessionId: 'ses-lead',
      goals: 'g',
      experience: 'e',
      preferences: 'p',
    } satisfies IntakeDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(100)
    await agent.stop()
    await runPromise

    const msgs: Message[] = []
    let m = queue.receive(AgentRole.HTTP_API)
    while (m) {
      msgs.push(m)
      queue.ack(m.id)
      m = queue.receive(AgentRole.HTTP_API)
    }
    expect(msgs.some(m => m.type === MessageType.STATUS && m.from_agent === AgentRole.INTAKE_LEAD)).toBe(true)
  })

  test('forwards ProfileBuilder result to Orchestrator', async () => {
    queue.send(AgentRole.PROFILE_BUILDER, AgentRole.INTAKE_LEAD, MessageType.RESULT, {
      sessionId: 'il-2',
      profile: { goals: 'security', experience: '5 years', preferences: 'remote', resumeRaw: null },
    } satisfies ProfileBuilderResultPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.INTAKE_LEAD)
    expect(msg!.type).toBe(MessageType.RESULT)
  })
})
