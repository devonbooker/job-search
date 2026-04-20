import { describe, test, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { Orchestrator } from '../../src/agents/orchestrator'
import { MessageQueue } from '../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type IntakeDispatchPayload,
  type IntakeResultPayload,
  type ResearchResultPayload,
  type ApproveResumePayload,
  type SelectTitlesPayload,
  type StartInterviewPayload,
} from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'
import { pool, runMigrations } from '../../src/db/postgres'
import { SessionStore } from '../../src/agents/session-store'
import type { SessionState } from '../../src/agents/orchestrator'

const TEST_DB = './test-orchestrator.db'

describe('Orchestrator', () => {
  let queue: MessageQueue
  let orchestrator: Orchestrator
  let store: SessionStore<SessionState>

  beforeAll(async () => {
    await runMigrations()
    store = new SessionStore<SessionState>({ pool, table: 'orchestrator_sessions' })
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE orchestrator_sessions')
    queue = new MessageQueue(TEST_DB)
    orchestrator = new Orchestrator(queue, new Anthropic({ apiKey: 'test-key' }), store)
  })

  afterEach(async () => {
    await orchestrator.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE orchestrator_sessions')
  })

  test('routes intake dispatch to IntakeLead', async () => {
    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-1',
      goals: 'security engineer',
      experience: '5 years backend',
      preferences: 'remote SF',
    } satisfies IntakeDispatchPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    const msg = queue.receive(AgentRole.INTAKE_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
    expect(msg!.type).toBe(MessageType.DISPATCH)
  })

  test('routes IntakeLead result to ResearchLead', async () => {
    // Seed intake so Orchestrator has session state
    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-2',
      goals: 'security',
      experience: '3 years',
      preferences: 'on-site',
    } satisfies IntakeDispatchPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(150) // process intake dispatch

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: 'ses-2',
      profile: { goals: 'security', experience: '3 years', preferences: 'on-site', resumeRaw: null },
    } satisfies IntakeResultPayload)

    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    const msg = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
  })

  test('research lead RESULT transitions session to awaiting_title_selection (no resume dispatch)', async () => {
    // Seed session via intake
    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-3',
      goals: 'security',
      experience: '3 years',
      preferences: 'on-site',
    } satisfies IntakeDispatchPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(150)

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: 'ses-3',
      profile: { goals: 'security', experience: '3 years', preferences: 'on-site', resumeRaw: null },
    } satisfies IntakeResultPayload)

    await Bun.sleep(150)

    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: 'ses-3',
      jobTitles: [{ title: 'Security Engineer', description: '', relevanceReason: '' }],
      skillsByTitle: [],
    } satisfies ResearchResultPayload)

    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    expect(queue.receive(AgentRole.RESUME_LEAD)).toBeNull()
    const persisted = await store.load('ses-3')
    expect(persisted?.stage).toBe('awaiting_title_selection')
  })

  test('SelectTitles dispatch transitions to building_resume and dispatches RESUME_LEAD with selected titles only', async () => {
    // Pre-seed a session at awaiting_title_selection
    await store.save('ses-st', {
      stage: 'awaiting_title_selection',
      profile: { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null },
      research: {
        sessionId: 'ses-st',
        jobTitles: [
          { title: 'A', description: '', relevanceReason: '' },
          { title: 'B', description: '', relevanceReason: '' },
          { title: 'C', description: '', relevanceReason: '' },
        ],
        skillsByTitle: [],
      },
    }, 'awaiting_title_selection')

    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-st',
      targetTitles: ['A', 'C'],
    } satisfies SelectTitlesPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    const dispatched = queue.receive(AgentRole.RESUME_LEAD)
    expect(dispatched).not.toBeNull()
    const payload = dispatched!.payload as { targetTitles: string[] }
    expect(payload.targetTitles).toEqual(['A', 'C'])

    const persisted = await store.load('ses-st')
    expect(persisted?.stage).toBe('building_resume')
    expect(persisted?.targetTitles).toEqual(['A', 'C'])
  })

  test('ApproveResume dispatch (no targetTitles in payload) dispatches JOB_SEARCH_LEAD with stored titles', async () => {
    // Pre-seed session at awaiting_resume_approval with stored targetTitles
    await store.save('ses-4', {
      stage: 'awaiting_resume_approval',
      profile: { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null },
      targetTitles: ['Security Engineer', 'DevOps Engineer'],
    }, 'awaiting_resume_approval')

    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-4',
    } satisfies ApproveResumePayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    const dispatched = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    expect(dispatched).not.toBeNull()
    const payload = dispatched!.payload as { targetTitles: string[] }
    expect(payload.targetTitles).toEqual(['Security Engineer', 'DevOps Engineer'])
  })

  test('routes start-interview dispatch to InterviewPrepLead', async () => {
    // Seed session first
    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-5',
      goals: 'security',
      experience: '3 years',
      preferences: 'remote',
    } satisfies IntakeDispatchPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(150)

    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-5',
      resumeSections: [{ title: 'Skills', content: [{ text: 'AWS' }] }],
      selectedTopic: 'AWS',
    } satisfies StartInterviewPayload)

    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    const msg = queue.receive(AgentRole.INTERVIEW_PREP_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
  })

  test('emits STATUS to HTTP_API when transitioning stages', async () => {
    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-status',
      goals: 'g',
      experience: 'e',
      preferences: 'p',
    } satisfies IntakeDispatchPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    // Drain all HTTP_API messages
    const httpMsgs = []
    let m = queue.receive(AgentRole.HTTP_API)
    while (m) {
      httpMsgs.push(m)
      queue.ack(m.id)
      m = queue.receive(AgentRole.HTTP_API)
    }

    expect(httpMsgs.some(
      m => m.type === MessageType.STATUS &&
           (m.payload as { stage: string }).stage === 'intake'
    )).toBe(true)
  })
})
