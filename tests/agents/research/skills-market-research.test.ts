import { describe, test, expect, afterEach } from 'bun:test'
import { mock } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { SkillsMarketResearch } from '../../../src/agents/research/skills-market-research'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type SkillsMarketResearchDispatchPayload,
  type SkillsMarketResearchResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-skills-market.db'

const MOCK_SKILLS = [
  {
    jobTitle: 'Security Engineer',
    requiredSkills: ['AWS', 'Kubernetes', 'Python'],
    niceToHaveSkills: ['Terraform', 'Go'],
  },
]

function makeAnthropic(skills: object[]): Anthropic {
  return {
    messages: {
      create: mock(async () => ({
        content: [{ type: 'text', text: JSON.stringify(skills) }],
      })),
    },
  } as unknown as Anthropic
}

function makeMockFetch(): typeof fetch {
  return mock(async () =>
    new Response(JSON.stringify({ web: { results: [{ description: 'Security Engineer requires AWS, Kubernetes, Python' }] } }), { status: 200 })
  ) as unknown as typeof fetch
}

describe('SkillsMarketResearch', () => {
  let queue: MessageQueue
  let agent: SkillsMarketResearch

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('sends SkillsMarketResearchResultPayload with skills back to ResearchLead', async () => {
    queue = new MessageQueue(TEST_DB)
    agent = new SkillsMarketResearch(queue, makeAnthropic(MOCK_SKILLS), makeMockFetch(), 'test-brave-key')

    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.SKILLS_MARKET_RESEARCH, MessageType.DISPATCH, {
      sessionId: 'smr-1',
      profile: { goals: 'security', experience: '3 years', preferences: 'remote', resumeRaw: null },
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
    } satisfies SkillsMarketResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const result = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.SKILLS_MARKET_RESEARCH)
    const payload = result!.payload as SkillsMarketResearchResultPayload
    expect(payload.sessionId).toBe('smr-1')
    expect(Array.isArray(payload.skillsByTitle)).toBe(true)
    expect(payload.skillsByTitle[0].requiredSkills).toContain('AWS')
  })

  test('calls Brave Search once per job title', async () => {
    let fetchCallCount = 0
    const mockFetch = mock(async () => {
      fetchCallCount++
      return new Response(JSON.stringify({ web: { results: [{ description: 'skills required' }] } }), { status: 200 })
    }) as unknown as typeof fetch

    queue = new MessageQueue(TEST_DB)
    agent = new SkillsMarketResearch(queue, makeAnthropic(MOCK_SKILLS), mockFetch, 'test-brave-key')

    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.SKILLS_MARKET_RESEARCH, MessageType.DISPATCH, {
      sessionId: 'smr-2',
      profile: { goals: 'security', experience: '3 years', preferences: 'remote', resumeRaw: null },
      jobTitles: [
        { title: 'Security Engineer', description: '', relevanceReason: '' },
        { title: 'Cloud Security Engineer', description: '', relevanceReason: '' },
      ],
    } satisfies SkillsMarketResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(400)
    await agent.stop()
    await runPromise

    expect(fetchCallCount).toBe(2)
  })
})
