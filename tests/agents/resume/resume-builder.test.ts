import { describe, test, expect, afterEach } from 'bun:test'
import { mock } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { ResumeBuilder } from '../../../src/agents/resume/resume-builder'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type ResumeBuildDispatchPayload,
  type ResumeBuildResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-resume-builder.db'

const MOCK_SECTIONS = [
  { title: 'Summary', content: 'Security engineer with 5 years of backend experience.' },
  { title: 'Skills', content: [{ text: 'AWS' }, { text: 'Kubernetes' }, { text: 'Python' }] },
  { title: 'Experience', content: [{ text: 'Led security infrastructure at Acme Corp (2020-2024)' }] },
]

function makeAnthropic(sections: object[]): Anthropic {
  return {
    messages: {
      create: mock(async () => ({
        content: [{ type: 'text', text: JSON.stringify(sections) }],
      })),
    },
  } as unknown as Anthropic
}

describe('ResumeBuilder', () => {
  let queue: MessageQueue
  let agent: ResumeBuilder

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('sends ResumeBuildResultPayload with sections back to ResumeLead', async () => {
    queue = new MessageQueue(TEST_DB)
    agent = new ResumeBuilder(queue, makeAnthropic(MOCK_SECTIONS))

    queue.send(AgentRole.RESUME_LEAD, AgentRole.RESUME_BUILDER, MessageType.DISPATCH, {
      sessionId: 'rb-1',
      profile: { goals: 'security engineer', experience: '5 years', preferences: 'remote', resumeRaw: null },
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
      skillsByTitle: [{ jobTitle: 'Security Engineer', requiredSkills: ['AWS', 'Kubernetes'], niceToHaveSkills: ['Terraform'] }],
      targetTitles: ['Security Engineer'],
    } satisfies ResumeBuildDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const result = queue.receive(AgentRole.RESUME_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.RESUME_BUILDER)
    expect(result!.type).toBe(MessageType.RESULT)
    const payload = result!.payload as ResumeBuildResultPayload
    expect(payload.sessionId).toBe('rb-1')
    expect(Array.isArray(payload.sections)).toBe(true)
    expect(payload.sections.length).toBe(3)
    expect(payload.sections[0].title).toBe('Summary')
  })

  test('includes target skills in Claude prompt', async () => {
    let capturedContent = ''
    const anthropic = {
      messages: {
        create: mock(async (params: { messages: { content: string }[] }) => {
          capturedContent = params.messages[0]?.content ?? ''
          return { content: [{ type: 'text', text: JSON.stringify(MOCK_SECTIONS) }] }
        }),
      },
    } as unknown as Anthropic

    queue = new MessageQueue(TEST_DB)
    agent = new ResumeBuilder(queue, anthropic)

    queue.send(AgentRole.RESUME_LEAD, AgentRole.RESUME_BUILDER, MessageType.DISPATCH, {
      sessionId: 'rb-2',
      profile: { goals: 'security', experience: '3 years', preferences: 'remote', resumeRaw: null },
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
      skillsByTitle: [{ jobTitle: 'Security Engineer', requiredSkills: ['Kubernetes', 'Terraform'], niceToHaveSkills: [] }],
      targetTitles: ['Security Engineer'],
    } satisfies ResumeBuildDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    expect(capturedContent).toContain('Kubernetes')
    expect(capturedContent).toContain('Terraform')
  })
})
