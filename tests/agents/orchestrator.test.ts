import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
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
} from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-orchestrator.db'

describe('Orchestrator', () => {
  let queue: MessageQueue
  let orchestrator: Orchestrator

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    orchestrator = new Orchestrator(queue, new Anthropic({ apiKey: 'test-key' }))
  })

  afterEach(async () => {
    await orchestrator.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
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

  test('routes ResearchLead result to ResumeLead', async () => {
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

    const msg = queue.receive(AgentRole.RESUME_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
  })

  test('routes approve-resume dispatch to JobSearchLead', async () => {
    // Seed session via intake so Orchestrator knows ses-4 exists
    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-4',
      goals: 'security',
      experience: '3 years',
      preferences: 'on-site',
    } satisfies IntakeDispatchPayload)

    const runPromise = orchestrator.run()
    await Bun.sleep(150)

    queue.send(AgentRole.HTTP_API, AgentRole.ORCHESTRATOR, MessageType.DISPATCH, {
      sessionId: 'ses-4',
      targetTitles: ['Security Engineer'],
    } satisfies ApproveResumePayload)

    await Bun.sleep(200)
    await orchestrator.stop()
    await runPromise

    const msg = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
  })
})
