import { describe, test, expect, beforeAll, beforeEach, afterEach, afterAll } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { pool, runMigrations } from '../../src/db/postgres'
import { SessionStore } from '../../src/agents/session-store'
import { Orchestrator, type SessionState } from '../../src/agents/orchestrator'
import { MessageQueue } from '../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type IntakeResultPayload,
  type ResearchResultPayload,
  type ResumeResultPayload,
  type Message,
} from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-orchestrator-restart.db'
const SID = 'restart-test-session-1'

describe('Orchestrator restart recovery', () => {
  let queue: MessageQueue
  let store: SessionStore<SessionState>

  beforeAll(async () => {
    await runMigrations()
    store = new SessionStore<SessionState>({ pool, table: 'orchestrator_sessions' })
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE orchestrator_sessions')
    queue = new MessageQueue(TEST_DB)
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE orchestrator_sessions')
  })

  function drainQueue(role: AgentRole): Message[] {
    const msgs: Message[] = []
    let m = queue.receive(role)
    while (m) { msgs.push(m); queue.ack(m.id); m = queue.receive(role) }
    return msgs
  }

  test('a session reaches building_resume in instance A and can be advanced to awaiting_resume_approval by a fresh instance B', async () => {
    // Seed the session in DB as if instance A had already created it via intake DISPATCH.
    await store.save(SID, { stage: 'intake' }, 'intake')

    // Instance A: handle intake RESULT then research RESULT, advancing the session through DB twice.
    const a = new Orchestrator(queue, new Anthropic({ apiKey: 'k' }), store)

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: SID,
      profile: { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null },
    } satisfies IntakeResultPayload)

    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: SID,
      jobTitles: [{ title: 'Security Engineer', description: 'd', relevanceReason: 'r' }],
      skillsByTitle: [],
    } satisfies ResearchResultPayload)

    const aRun = a.run()
    await Bun.sleep(300)
    await a.stop()
    await aRun

    // Drain noise so it doesn't confuse phase 2's assertions
    drainQueue(AgentRole.RESEARCH_LEAD)
    drainQueue(AgentRole.RESUME_LEAD)
    drainQueue(AgentRole.HTTP_API)

    // Confirm DB has reached building_resume
    const persisted = await store.load(SID)
    expect(persisted?.stage).toBe('building_resume')

    // Phase 2: brand-new orchestrator B with a brand-new in-memory Map. Only the DB carries state.
    const b = new Orchestrator(queue, new Anthropic({ apiKey: 'k' }), store)

    queue.send(AgentRole.RESUME_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: SID,
      sections: [{ title: 'Summary', content: 'hi' }],
    } satisfies ResumeResultPayload)

    const bRun = b.run()
    await Bun.sleep(300)
    await b.stop()
    await bRun

    const httpMsgs = drainQueue(AgentRole.HTTP_API)
    const status = httpMsgs.find(m =>
      m.type === MessageType.STATUS &&
      (m.payload as { stage?: string }).stage === 'awaiting_resume_approval'
    )
    const unknownErr = httpMsgs.find(m =>
      m.type === MessageType.ERROR &&
      typeof (m.payload as { error?: string }).error === 'string' &&
      (m.payload as { error: string }).error.startsWith('Unknown session')
    )

    expect(status).toBeDefined()
    expect(unknownErr).toBeUndefined()

    const after = await store.load(SID)
    expect(after?.stage).toBe('awaiting_resume_approval')
  })
})
