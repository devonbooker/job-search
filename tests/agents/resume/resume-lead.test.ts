import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { ResumeLead } from '../../../src/agents/resume/resume-lead'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type ResumeDispatchPayload,
  type ResumeBuildResultPayload,
  type Message,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-resume-lead.db'

describe('ResumeLead', () => {
  let queue: MessageQueue
  let agent: ResumeLead

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new ResumeLead(queue, new Anthropic({ apiKey: 'test-key' }))
  })

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('forwards resume dispatch to ResumeBuilder', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESUME_LEAD, MessageType.DISPATCH, {
      sessionId: 'rl-1',
      profile: { goals: 'security', experience: '5 years', preferences: 'remote', resumeRaw: null },
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
      skillsByTitle: [],
      targetTitles: ['Security Engineer'],
    } satisfies ResumeDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.RESUME_BUILDER)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.RESUME_LEAD)
    expect(msg!.type).toBe(MessageType.DISPATCH)
  })

  test('emits STATUS to HTTP_API on receiving dispatch', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESUME_LEAD, MessageType.DISPATCH, {
      sessionId: 'ses-lead',
      profile: { goals: 'g', experience: 'e', resumeRaw: null, preferences: 'p' },
      jobTitles: [],
      skillsByTitle: [],
      targetTitles: ['X'],
    } satisfies ResumeDispatchPayload)

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
    expect(msgs.some(m => m.type === MessageType.STATUS && m.from_agent === AgentRole.RESUME_LEAD)).toBe(true)
  })

  test('forwards ResumeBuilder result to Orchestrator', async () => {
    queue.send(AgentRole.RESUME_BUILDER, AgentRole.RESUME_LEAD, MessageType.RESULT, {
      sessionId: 'rl-2',
      sections: [{ title: 'Summary', content: 'Security engineer.' }],
    } satisfies ResumeBuildResultPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.RESUME_LEAD)
    expect(msg!.type).toBe(MessageType.RESULT)
  })
})
