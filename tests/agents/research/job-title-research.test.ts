import { describe, test, expect, afterEach } from 'bun:test'
import { mock } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { JobTitleResearch } from '../../../src/agents/research/job-title-research'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type JobTitleResearchDispatchPayload,
  type JobTitleResearchResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-job-title-research.db'

const MOCK_JOB_TITLES = [
  { title: 'Security Engineer', description: 'Secures infrastructure', relevanceReason: 'Matches security goals' },
  { title: 'Cloud Security Engineer', description: 'Cloud-focused security', relevanceReason: 'Matches AWS skills' },
]

function makeMockFetch(): typeof fetch {
  return mock(async () =>
    new Response(JSON.stringify({ web: { results: [{ description: 'Security roles require cloud skills and Kubernetes' }] } }), { status: 200 })
  ) as unknown as typeof fetch
}

function makeAnthropic(jobTitles: object[]): Anthropic {
  return {
    messages: {
      create: mock(async () => ({
        content: [{ type: 'text', text: JSON.stringify(jobTitles) }],
      })),
    },
  } as unknown as Anthropic
}

describe('JobTitleResearch', () => {
  let queue: MessageQueue
  let agent: JobTitleResearch

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('sends JobTitleResearchResultPayload with job titles back to ResearchLead', async () => {
    queue = new MessageQueue(TEST_DB)
    agent = new JobTitleResearch(queue, makeAnthropic(MOCK_JOB_TITLES), makeMockFetch(), 'test-brave-key')

    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.JOB_TITLE_RESEARCH, MessageType.DISPATCH, {
      sessionId: 'jtr-1',
      profile: { goals: 'security engineer', experience: '5 years', preferences: 'remote', resumeRaw: null },
    } satisfies JobTitleResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const result = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.JOB_TITLE_RESEARCH)
    expect(result!.type).toBe(MessageType.RESULT)
    const payload = result!.payload as JobTitleResearchResultPayload
    expect(payload.sessionId).toBe('jtr-1')
    expect(Array.isArray(payload.jobTitles)).toBe(true)
    expect(payload.jobTitles.length).toBe(2)
    expect(payload.jobTitles[0].title).toBe('Security Engineer')
  })

  test('calls Brave Search with profile goals', async () => {
    let capturedUrl = ''
    const mockFetch = mock(async (url: string | URL | Request) => {
      capturedUrl = url.toString()
      return new Response(JSON.stringify({ web: { results: [{ description: 'Security jobs 2024' }] } }), { status: 200 })
    }) as unknown as typeof fetch

    queue = new MessageQueue(TEST_DB)
    agent = new JobTitleResearch(queue, makeAnthropic(MOCK_JOB_TITLES), mockFetch, 'test-brave-key')

    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.JOB_TITLE_RESEARCH, MessageType.DISPATCH, {
      sessionId: 'jtr-2',
      profile: { goals: 'cloud security engineer', experience: '3 years', preferences: 'SF', resumeRaw: null },
    } satisfies JobTitleResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    expect(capturedUrl).toContain('search.brave.com')
    expect(capturedUrl).toContain('cloud')
  })
})
