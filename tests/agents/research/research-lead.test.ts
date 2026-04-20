import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { ResearchLead } from '../../../src/agents/research/research-lead'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type ResearchDispatchPayload,
  type JobTitleResearchResultPayload,
  type SkillsMarketResearchResultPayload,
  type Message,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'
import { pool, runMigrations } from '../../../src/db/postgres'
import { SessionStore } from '../../../src/agents/session-store'
import type { ResearchSession } from '../../../src/agents/research/research-lead'

const TEST_DB = './test-research-lead.db'

describe('ResearchLead', () => {
  let queue: MessageQueue
  let agent: ResearchLead
  let store: SessionStore<ResearchSession>

  beforeAll(async () => {
    await runMigrations()
    store = new SessionStore<ResearchSession>({ pool, table: 'research_lead_sessions' })
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE research_lead_sessions')
    queue = new MessageQueue(TEST_DB)
    agent = new ResearchLead(queue, new Anthropic({ apiKey: 'test-key' }), store)
  })

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE research_lead_sessions')
  })

  test('dispatches to JobTitleResearch on incoming research dispatch', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
      sessionId: 'rl-1',
      profile: { goals: 'security', experience: '3 years', preferences: 'remote', resumeRaw: null },
    } satisfies ResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.JOB_TITLE_RESEARCH)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.RESEARCH_LEAD)
  })

  test('emits STATUS to HTTP_API on receiving dispatch', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
      sessionId: 'ses-lead',
      profile: { goals: 'g', experience: 'e', resumeRaw: null, preferences: 'p' },
    } satisfies ResearchDispatchPayload)

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
    expect(msgs.some(m => m.type === MessageType.STATUS && m.from_agent === AgentRole.RESEARCH_LEAD)).toBe(true)
  })

  test('dispatches to SkillsMarketResearch after JobTitleResearch result', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
      sessionId: 'rl-2',
      profile: { goals: 'security', experience: '3 years', preferences: 'remote', resumeRaw: null },
    } satisfies ResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(150)

    queue.send(AgentRole.JOB_TITLE_RESEARCH, AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
      sessionId: 'rl-2',
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
    } satisfies JobTitleResearchResultPayload)

    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.SKILLS_MARKET_RESEARCH)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.RESEARCH_LEAD)
  })

  test('sends ResearchResultPayload to Orchestrator after SkillsMarketResearch result', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
      sessionId: 'rl-3',
      profile: { goals: 'security', experience: '3 years', preferences: 'remote', resumeRaw: null },
    } satisfies ResearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(150)

    queue.send(AgentRole.JOB_TITLE_RESEARCH, AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
      sessionId: 'rl-3',
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
    } satisfies JobTitleResearchResultPayload)

    await Bun.sleep(150)

    queue.send(AgentRole.SKILLS_MARKET_RESEARCH, AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
      sessionId: 'rl-3',
      skillsByTitle: [{ jobTitle: 'Security Engineer', requiredSkills: ['AWS'], niceToHaveSkills: [] }],
    } satisfies SkillsMarketResearchResultPayload)

    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.RESEARCH_LEAD)
    expect(msg!.type).toBe(MessageType.RESULT)
    const payload = msg!.payload as { jobTitles: unknown[]; skillsByTitle: unknown[] }
    expect(payload.jobTitles).toHaveLength(1)
    expect(payload.skillsByTitle).toHaveLength(1)
  })
})
