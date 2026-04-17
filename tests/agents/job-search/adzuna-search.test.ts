import { describe, test, expect, afterEach } from 'bun:test'
import { mock } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import type { Pool } from 'pg'
import { AdzunaSearch } from '../../../src/agents/job-search/adzuna-search'
import { MessageQueue } from '../../../src/agents/queue'
import {
  AgentRole,
  MessageType,
  type AdzunaSearchDispatchPayload,
  type AdzunaSearchResultPayload,
} from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-adzuna-search.db'

const MOCK_ADZUNA_JOBS = [
  {
    title: 'Security Engineer',
    company: { display_name: 'Acme Corp' },
    redirect_url: 'https://example.com/job/1',
  },
  {
    title: 'Sr. Security Engineer',
    company: { display_name: 'Beta Inc' },
    redirect_url: 'https://example.com/job/2',
  },
]

function makePool(): Pool {
  return {
    query: mock(async () => ({ rows: [], rowCount: 0 })),
  } as unknown as Pool
}

function makeMockFetch(jobs: object[]): typeof fetch {
  return mock(async () =>
    new Response(JSON.stringify({ results: jobs }), { status: 200 })
  ) as unknown as typeof fetch
}

describe('AdzunaSearch', () => {
  let queue: MessageQueue
  let agent: AdzunaSearch

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('writes jobs to PostgreSQL and sends result to JobSearchLead', async () => {
    const pool = makePool()
    queue = new MessageQueue(TEST_DB)
    agent = new AdzunaSearch(
      queue,
      new Anthropic({ apiKey: 'test-key' }),
      pool,
      makeMockFetch(MOCK_ADZUNA_JOBS),
      'test-app-id',
      'test-app-key',
    )

    queue.send(AgentRole.JOB_SEARCH_LEAD, AgentRole.ADZUNA_SEARCH, MessageType.DISPATCH, {
      sessionId: 'az-1',
      targetTitles: ['Security Engineer'],
    } satisfies AdzunaSearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const result = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.ADZUNA_SEARCH)
    expect(result!.type).toBe(MessageType.RESULT)
    const payload = result!.payload as AdzunaSearchResultPayload
    expect(payload.sessionId).toBe('az-1')
    expect(typeof payload.jobsFound).toBe('number')
  })

  test('calls Adzuna API once per target title', async () => {
    let fetchCallCount = 0
    const mockFetch = mock(async () => {
      fetchCallCount++
      return new Response(JSON.stringify({ results: [] }), { status: 200 })
    }) as unknown as typeof fetch

    queue = new MessageQueue(TEST_DB)
    agent = new AdzunaSearch(
      queue,
      new Anthropic({ apiKey: 'test-key' }),
      makePool(),
      mockFetch,
      'test-app-id',
      'test-app-key',
    )

    queue.send(AgentRole.JOB_SEARCH_LEAD, AgentRole.ADZUNA_SEARCH, MessageType.DISPATCH, {
      sessionId: 'az-2',
      targetTitles: ['Security Engineer', 'Cloud Security Engineer'],
    } satisfies AdzunaSearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    expect(fetchCallCount).toBe(2)
  })

  test('throws if appId or appKey is empty', () => {
    const q = new MessageQueue(TEST_DB)
    try {
      expect(() => new AdzunaSearch(
        q,
        new Anthropic({ apiKey: 'test-key' }),
        makePool(),
        makeMockFetch([]),
        '',
        'some-key',
      )).toThrow('ADZUNA_APP_ID and ADZUNA_APP_KEY must be set')
    } finally {
      q.close()
    }
  })

  test('deduplicates jobs by redirect_url before writing', async () => {
    const duplicateJobs = [
      { title: 'Security Engineer', company: { display_name: 'Acme' }, redirect_url: 'https://example.com/job/1' },
      { title: 'Security Engineer', company: { display_name: 'Acme' }, redirect_url: 'https://example.com/job/1' },
    ]

    const insertQueries: string[] = []
    const pool = {
      query: mock(async (sql: string) => {
        if (sql.includes('INSERT')) insertQueries.push(sql)
        return { rows: [], rowCount: 0 }
      }),
    } as unknown as Pool

    queue = new MessageQueue(TEST_DB)
    agent = new AdzunaSearch(
      queue,
      new Anthropic({ apiKey: 'test-key' }),
      pool,
      makeMockFetch(duplicateJobs),
      'test-app-id',
      'test-app-key',
    )

    queue.send(AgentRole.JOB_SEARCH_LEAD, AgentRole.ADZUNA_SEARCH, MessageType.DISPATCH, {
      sessionId: 'az-3',
      targetTitles: ['Security Engineer'],
    } satisfies AdzunaSearchDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    expect(insertQueries.length).toBe(1)
  })
})
