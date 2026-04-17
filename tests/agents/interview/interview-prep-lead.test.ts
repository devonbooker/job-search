import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { InterviewPrepLead } from '../../../src/agents/interview/interview-prep-lead'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type InterviewDispatchPayload,
  type TopicDrillResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-interview-prep-lead.db'

describe('InterviewPrepLead', () => {
  let queue: MessageQueue
  let agent: InterviewPrepLead

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new InterviewPrepLead(queue, new Anthropic({ apiKey: 'test-key' }))
  })

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('forwards interview dispatch to TopicDrill', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTERVIEW_PREP_LEAD, MessageType.DISPATCH, {
      sessionId: 'ipl-1',
      resumeSections: [{ title: 'Skills', content: [{ text: 'AWS' }] }],
      selectedTopic: 'AWS',
    } satisfies InterviewDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.TOPIC_DRILL)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.INTERVIEW_PREP_LEAD)
    expect(msg!.type).toBe(MessageType.DISPATCH)
  })

  test('forwards TopicDrill result to Orchestrator', async () => {
    queue.send(AgentRole.TOPIC_DRILL, AgentRole.INTERVIEW_PREP_LEAD, MessageType.RESULT, {
      sessionId: 'ipl-2',
      feedback: {
        question: 'Describe your AWS experience.',
        feedback: 'Clear and specific.',
        clarity: 'strong',
        specificity: 'strong',
      },
    } satisfies TopicDrillResultPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.INTERVIEW_PREP_LEAD)
    expect(msg!.type).toBe(MessageType.RESULT)
  })
})
