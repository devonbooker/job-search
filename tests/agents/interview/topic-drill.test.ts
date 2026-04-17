import { describe, test, expect, afterEach } from 'bun:test'
import { mock } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { TopicDrill } from '../../../src/agents/interview/topic-drill'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type TopicDrillDispatchPayload,
  type TopicDrillResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-topic-drill.db'

const MOCK_FEEDBACK = {
  question: 'Tell me about a time you handled a security incident.',
  feedback: 'Good structure, but missing specific metrics.',
  clarity: 'strong' as const,
  specificity: 'adequate' as const,
}

function makeAnthropic(feedback: object): Anthropic {
  return {
    messages: {
      create: mock(async () => ({
        content: [{ type: 'text', text: JSON.stringify(feedback) }],
      })),
    },
  } as unknown as Anthropic
}

describe('TopicDrill', () => {
  let queue: MessageQueue
  let agent: TopicDrill

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('sends TopicDrillResultPayload with feedback to InterviewPrepLead', async () => {
    queue = new MessageQueue(TEST_DB)
    agent = new TopicDrill(queue, makeAnthropic(MOCK_FEEDBACK))

    queue.send(AgentRole.INTERVIEW_PREP_LEAD, AgentRole.TOPIC_DRILL, MessageType.DISPATCH, {
      sessionId: 'td-1',
      resumeSections: [{ title: 'Skills', content: [{ text: 'AWS' }] }],
      selectedTopic: 'AWS',
      userAnswer: 'I built an S3-based logging pipeline that reduced costs by 30%.',
    } satisfies TopicDrillDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const result = queue.receive(AgentRole.INTERVIEW_PREP_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.TOPIC_DRILL)
    expect(result!.type).toBe(MessageType.RESULT)
    const payload = result!.payload as TopicDrillResultPayload
    expect(payload.sessionId).toBe('td-1')
    expect(payload.feedback.clarity).toBe('strong')
    expect(payload.feedback.question).toBeTruthy()
  })

  test('generates question when no userAnswer provided', async () => {
    let capturedPrompt = ''
    const anthropic = {
      messages: {
        create: mock(async (params: { messages: { content: string }[] }) => {
          capturedPrompt = params.messages[0]?.content ?? ''
          return { content: [{ type: 'text', text: JSON.stringify(MOCK_FEEDBACK) }] }
        }),
      },
    } as unknown as Anthropic

    queue = new MessageQueue(TEST_DB)
    agent = new TopicDrill(queue, anthropic)

    queue.send(AgentRole.INTERVIEW_PREP_LEAD, AgentRole.TOPIC_DRILL, MessageType.DISPATCH, {
      sessionId: 'td-2',
      resumeSections: [{ title: 'Skills', content: [{ text: 'Kubernetes' }] }],
      selectedTopic: 'Kubernetes',
    } satisfies TopicDrillDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    expect(capturedPrompt).toContain('generate')
    expect(capturedPrompt).not.toContain('evaluate')
  })

  test('evaluates answer when userAnswer is provided', async () => {
    let capturedPrompt = ''
    const anthropic = {
      messages: {
        create: mock(async (params: { messages: { content: string }[] }) => {
          capturedPrompt = params.messages[0]?.content ?? ''
          return { content: [{ type: 'text', text: JSON.stringify(MOCK_FEEDBACK) }] }
        }),
      },
    } as unknown as Anthropic

    queue = new MessageQueue(TEST_DB)
    agent = new TopicDrill(queue, anthropic)

    queue.send(AgentRole.INTERVIEW_PREP_LEAD, AgentRole.TOPIC_DRILL, MessageType.DISPATCH, {
      sessionId: 'td-3',
      resumeSections: [{ title: 'Skills', content: [{ text: 'Kubernetes' }] }],
      selectedTopic: 'Kubernetes',
      userAnswer: 'I managed a 50-node cluster on EKS with custom networking.',
    } satisfies TopicDrillDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    expect(capturedPrompt).toContain('evaluate')
    expect(capturedPrompt).toContain('I managed a 50-node cluster')

    const result = queue.receive(AgentRole.INTERVIEW_PREP_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.TOPIC_DRILL)
    expect(result!.type).toBe(MessageType.RESULT)
  })
})
