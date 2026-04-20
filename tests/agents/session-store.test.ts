import { describe, test, expect, beforeAll, beforeEach, afterAll } from 'bun:test'
import { pool, runMigrations } from '../../src/db/postgres'
import { SessionStore } from '../../src/agents/session-store'

interface Foo {
  stage: string
  data: { count: number }
}

describe('SessionStore', () => {
  let store: SessionStore<Foo>

  beforeAll(async () => {
    await runMigrations()
    store = new SessionStore<Foo>({ pool, table: 'orchestrator_sessions' })
  })

  beforeEach(async () => {
    await pool.query('TRUNCATE TABLE orchestrator_sessions')
  })

  afterAll(async () => {
    await pool.query('TRUNCATE TABLE orchestrator_sessions')
  })

  test('save then load returns the same blob', async () => {
    const id = '11111111-1111-1111-1111-111111111111'
    await store.save(id, { stage: 'researching', data: { count: 1 } }, 'researching')
    const loaded = await store.load(id)
    expect(loaded).toEqual({ stage: 'researching', data: { count: 1 } })
  })

  test('save twice with same id upserts (second wins)', async () => {
    const id = '22222222-2222-2222-2222-222222222222'
    await store.save(id, { stage: 'intake', data: { count: 1 } }, 'intake')
    await store.save(id, { stage: 'researching', data: { count: 9 } }, 'researching')
    const loaded = await store.load(id)
    expect(loaded?.stage).toBe('researching')
    expect(loaded?.data.count).toBe(9)
  })

  test('load returns undefined for missing id', async () => {
    const loaded = await store.load('33333333-3333-3333-3333-333333333333')
    expect(loaded).toBeUndefined()
  })

  test('delete removes the row', async () => {
    const id = '44444444-4444-4444-4444-444444444444'
    await store.save(id, { stage: 'idle', data: { count: 0 } }, 'idle')
    await store.delete(id)
    expect(await store.load(id)).toBeUndefined()
  })

  test('loadAll returns every saved row keyed by sessionId', async () => {
    const id1 = '55555555-5555-5555-5555-555555555555'
    const id2 = '66666666-6666-6666-6666-666666666666'
    await store.save(id1, { stage: 'intake', data: { count: 1 } }, 'intake')
    await store.save(id2, { stage: 'researching', data: { count: 2 } }, 'researching')

    const all = await store.loadAll()
    expect(all.size).toBe(2)
    expect(all.get(id1)?.stage).toBe('intake')
    expect(all.get(id2)?.stage).toBe('researching')
  })

  test('loadAll on a table without a stage column omits the stage param', async () => {
    const noStage = new SessionStore<Foo>({ pool, table: 'research_lead_sessions' })
    await pool.query('TRUNCATE TABLE research_lead_sessions')
    const id = '77777777-7777-7777-7777-777777777777'
    await noStage.save(id, { stage: 'awaiting_titles', data: { count: 7 } })
    const all = await noStage.loadAll()
    expect(all.get(id)?.data.count).toBe(7)
    await pool.query('TRUNCATE TABLE research_lead_sessions')
  })
})
