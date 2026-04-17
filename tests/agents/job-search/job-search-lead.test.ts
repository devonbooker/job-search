import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { JobSearchLead } from '../../../src/agents/job-search/job-search-lead'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type JobSearchDispatchPayload,
  type AdzunaSearchResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-job-search-lead.db'

describe('JobSearchLead', () => {
  let queue: MessageQueue
  let agent: JobSearchLead

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    agent = new JobSearchLead(queue, new Anthropic({ apiKey: 'test-key' }))
  })

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('forwards job search dispatch to AdzunaSearch', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, {
      sessionId: 'jsl-1',
      targetTitles: ['Security Engineer'],
    } satisfies JobSearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.ADZUNA_SEARCH)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.JOB_SEARCH_LEAD)
    expect(msg!.type).toBe(MessageType.DISPATCH)
  })

  test('forwards AdzunaSearch result to Orchestrator', async () => {
    queue.send(AgentRole.ADZUNA_SEARCH, AgentRole.JOB_SEARCH_LEAD, MessageType.RESULT, {
      sessionId: 'jsl-2',
      jobsFound: 15,
    } satisfies AdzunaSearchResultPayload)

    const runPromise = agent.run()
    await Bun.sleep(200)
    await agent.stop()
    await runPromise

    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.JOB_SEARCH_LEAD)
    expect(msg!.type).toBe(MessageType.RESULT)
    expect((msg!.payload as { jobsFound: number }).jobsFound).toBe(15)
  })
})
