# Persistent Session State Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist `Orchestrator` and `ResearchLead` per-session state to Postgres so workflows survive server restarts (today's "Unknown session: ..." bug after every `bun --watch` reload).

**Architecture:** New generic `SessionStore<T>` class (CRUD against a JSONB Postgres table). Each agent constructor accepts a `SessionStore`. Handlers keep their existing in-memory `Map<sessionId, ...>` semantics — the `Map` is still the read source — but every `set`/`delete` is mirrored to the store (write-through). On `run()` startup, each agent calls `loadAll()` to seed its `Map` from DB.

**Tech Stack:** Postgres (existing `pg` Pool), Bun's TypeScript runtime, `bun:test` for unit/integration tests.

---

## File Structure

**New:**
- `src/db/migrations/004_create_orchestrator_sessions.sql` — orchestrator_sessions table
- `src/db/migrations/005_create_research_lead_sessions.sql` — research_lead_sessions table
- `src/agents/session-store.ts` — `SessionStore<T>` class
- `tests/agents/session-store.test.ts` — unit tests (round-trip CRUD, loadAll)
- `tests/integration/orchestrator-restart.test.ts` — end-to-end restart recovery

**Modified:**
- `src/agents/orchestrator.ts` — accept store in constructor, override `run()` to seed Map, write-through on every `set`/`delete`
- `src/agents/research/research-lead.ts` — same pattern
- `src/main.ts` — instantiate two `SessionStore`s, pass into agents
- `tests/agents/orchestrator.test.ts` — pass store into existing tests, truncate table around them
- `tests/agents/research/research-lead.test.ts` — same

---

## Task 1: SessionStore class with TDD

**Files:**
- Create: `src/agents/session-store.ts`
- Create: `tests/agents/session-store.test.ts`

The store is a thin generic wrapper around one Postgres table. It accepts a `pool` and a `table` name and provides `load`, `save`, `delete`, `loadAll`. Tests run against the live Postgres the project already uses; each test truncates its target table for isolation.

- [ ] **Step 1: Write failing tests**

Create `tests/agents/session-store.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `bun test tests/agents/session-store.test.ts`
Expected: FAIL — module `'../../src/agents/session-store'` not found AND tables `orchestrator_sessions` / `research_lead_sessions` do not exist (the migrations are added in Tasks 2 and 3).

This task's tests are the source of truth for the store's API; they will not fully pass until Tasks 2 and 3 land. That's fine — first write the implementation here, then re-run after Tasks 2 and 3.

- [ ] **Step 3: Implement `SessionStore`**

Create `src/agents/session-store.ts`:

```ts
import type { Pool } from 'pg'

export interface SessionStoreConfig {
  pool: Pool
  /** Postgres table name. Must have columns: session_id UUID PK, state JSONB, updated_at. May also have stage TEXT. */
  table: string
}

export class SessionStore<T> {
  constructor(private readonly config: SessionStoreConfig) {}

  async load(sessionId: string): Promise<T | undefined> {
    const { rows } = await this.config.pool.query(
      `SELECT state FROM ${this.config.table} WHERE session_id = $1`,
      [sessionId],
    )
    if (rows.length === 0) return undefined
    return rows[0].state as T
  }

  async save(sessionId: string, state: T, stage?: string): Promise<void> {
    if (stage !== undefined) {
      await this.config.pool.query(
        `INSERT INTO ${this.config.table} (session_id, stage, state, updated_at)
         VALUES ($1, $2, $3, NOW())
         ON CONFLICT (session_id) DO UPDATE
         SET stage = EXCLUDED.stage, state = EXCLUDED.state, updated_at = NOW()`,
        [sessionId, stage, state],
      )
    } else {
      await this.config.pool.query(
        `INSERT INTO ${this.config.table} (session_id, state, updated_at)
         VALUES ($1, $2, NOW())
         ON CONFLICT (session_id) DO UPDATE
         SET state = EXCLUDED.state, updated_at = NOW()`,
        [sessionId, state],
      )
    }
  }

  async delete(sessionId: string): Promise<void> {
    await this.config.pool.query(
      `DELETE FROM ${this.config.table} WHERE session_id = $1`,
      [sessionId],
    )
  }

  async loadAll(): Promise<Map<string, T>> {
    const { rows } = await this.config.pool.query(
      `SELECT session_id, state FROM ${this.config.table}`,
    )
    const map = new Map<string, T>()
    for (const row of rows) map.set(row.session_id, row.state as T)
    return map
  }
}
```

Note on SQL-injection: `table` is interpolated directly because `pg` does not parameterize identifiers. Callers control `table` from server-side code only — never user input.

- [ ] **Step 4: Commit (tests will still fail until migrations land in Tasks 2 and 3)**

```bash
git add src/agents/session-store.ts tests/agents/session-store.test.ts
git commit -m "feat: SessionStore generic wrapper around Postgres JSONB session table"
```

---

## Task 2: orchestrator_sessions migration

**Files:**
- Create: `src/db/migrations/004_create_orchestrator_sessions.sql`

- [ ] **Step 1: Create the migration file**

Create `src/db/migrations/004_create_orchestrator_sessions.sql`:

```sql
CREATE TABLE IF NOT EXISTS orchestrator_sessions (
  session_id UUID PRIMARY KEY,
  stage TEXT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Run migrations against the dev DB**

Run from a one-off Bun script or just start `bun run dev` (which calls `runMigrations()` on boot). Verify the table exists:

```bash
docker exec job-search-pg psql -U postgres -d job_search -c "\d orchestrator_sessions"
```

Expected: table description with `session_id`, `stage`, `state`, `updated_at` columns.

- [ ] **Step 3: Re-run SessionStore tests for the orchestrator table**

Run: `bun test tests/agents/session-store.test.ts -t "save then load"`
Expected: the orchestrator_sessions tests now pass (research_lead_sessions test still fails until Task 3).

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/004_create_orchestrator_sessions.sql
git commit -m "feat: orchestrator_sessions table migration"
```

---

## Task 3: research_lead_sessions migration

**Files:**
- Create: `src/db/migrations/005_create_research_lead_sessions.sql`

- [ ] **Step 1: Create the migration file**

```sql
CREATE TABLE IF NOT EXISTS research_lead_sessions (
  session_id UUID PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

- [ ] **Step 2: Run migrations and verify table exists**

```bash
bun run -e 'await import("./src/db/postgres").then(m => m.runMigrations())'
docker exec job-search-pg psql -U postgres -d job_search -c "\d research_lead_sessions"
```

Expected: table description shows `session_id`, `state`, `updated_at` (no `stage` column).

- [ ] **Step 3: Run full SessionStore test suite**

Run: `bun test tests/agents/session-store.test.ts`
Expected: all 6 tests pass.

- [ ] **Step 4: Commit**

```bash
git add src/db/migrations/005_create_research_lead_sessions.sql
git commit -m "feat: research_lead_sessions table migration"
```

---

## Task 4: Wire SessionStore into Orchestrator

**Files:**
- Modify: `src/agents/orchestrator.ts`
- Modify: `tests/agents/orchestrator.test.ts`

The orchestrator gains a `store: SessionStore<SessionState>` constructor param. It overrides `run()` to seed `this.sessions` from `store.loadAll()` before calling `super.run()`. Every `this.sessions.set(id, x)` site is followed by `await this.store.save(id, x, x.stage)`. Every `this.sessions.delete(id)` site is followed by `await this.store.delete(id)`.

- [ ] **Step 1: Update existing orchestrator tests to inject a store**

Edit `tests/agents/orchestrator.test.ts`:

Change the imports at the top to add:

```ts
import { pool, runMigrations } from '../../src/db/postgres'
import { SessionStore } from '../../src/agents/session-store'
import type { SessionState } from '../../src/agents/orchestrator'  // will be exported in Step 2
```

Replace the `describe('Orchestrator', () => { ... })` opening block (lines 18–31) so it looks like:

```ts
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
```

Add `beforeAll, afterAll` to the existing `bun:test` import on line 1.

- [ ] **Step 2: Modify `Orchestrator` to accept and use the store**

Edit `src/agents/orchestrator.ts`:

a) Add `import { SessionStore } from './session-store'` at the top.

b) Change the `interface SessionState` to `export interface SessionState` (so the test can import it).

c) Replace the constructor (lines 38–40) with:

```ts
constructor(
  queue: MessageQueue,
  anthropic: Anthropic,
  private readonly store: SessionStore<SessionState>,
) {
  super(queue, anthropic)
}

async run(): Promise<void> {
  this.sessions = await this.store.loadAll()
  return super.run()
}
```

d) Inside `handleMessage`, after every `this.sessions.set(...)` add a corresponding await:

After line 48 (`this.sessions.set(payload.sessionId, { stage: 'intake' })`):
```ts
await this.store.save(payload.sessionId, { stage: 'intake' }, 'intake')
```

After line 61 (`session.stage = 'searching_jobs'`) add:
```ts
await this.store.save(payload.sessionId, session, 'searching_jobs')
```

After line 77 (`session.stage = 'interview_prep'`):
```ts
await this.store.save(payload.sessionId, session, 'interview_prep')
```

In the RESULT switch:
- After line 96 (intake `session.stage = 'researching'`) add:
  ```ts
  await this.store.save(result.sessionId, session, 'researching')
  ```
- After line 109 (research `session.stage = 'building_resume'`) add:
  ```ts
  await this.store.save(result.sessionId, session, 'building_resume')
  ```
- After line 130 (resume `session.stage = 'awaiting_resume_approval'`) add:
  ```ts
  await this.store.save(result.sessionId, session, 'awaiting_resume_approval')
  ```
- Replace line 142 (`this.sessions.delete(result.sessionId)`) with:
  ```ts
  this.sessions.delete(result.sessionId)
  await this.store.delete(result.sessionId)
  ```
- Replace line 152 (`this.sessions.delete(result.sessionId)`) with the same two-line pair.

- [ ] **Step 3: Run orchestrator tests**

Run: `bun test tests/agents/orchestrator.test.ts`
Expected: all existing tests still pass (now with write-through to DB).

- [ ] **Step 4: Commit**

```bash
git add src/agents/orchestrator.ts tests/agents/orchestrator.test.ts
git commit -m "feat: Orchestrator persists session state via SessionStore (write-through + startup load)"
```

---

## Task 5: Wire SessionStore into ResearchLead

**Files:**
- Modify: `src/agents/research/research-lead.ts`
- Modify: `tests/agents/research/research-lead.test.ts`

Same pattern as Task 4, applied to `ResearchLead`.

- [ ] **Step 1: Update research-lead tests to inject a store**

Edit `tests/agents/research/research-lead.test.ts`:

Add to imports:
```ts
import { pool, runMigrations } from '../../../src/db/postgres'
import { SessionStore } from '../../../src/agents/session-store'
import type { ResearchSession } from '../../../src/agents/research/research-lead'
```

Replace the describe-opening block (lines 17–30) with:

```ts
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
```

Add `beforeAll, afterAll` to the `bun:test` import.

- [ ] **Step 2: Modify `ResearchLead`**

Edit `src/agents/research/research-lead.ts`:

a) Add `import { SessionStore } from '../session-store'`

b) Change `interface ResearchSession` to `export interface ResearchSession`

c) Replace the constructor (lines 32–34) with:

```ts
constructor(
  queue: MessageQueue,
  anthropic: Anthropic,
  private readonly store: SessionStore<ResearchSession>,
) {
  super(queue, anthropic)
}

async run(): Promise<void> {
  this.sessions = await this.store.loadAll()
  return super.run()
}
```

d) Mirror the Map mutations to the store:

After line 39 (`this.sessions.set(dispatch.sessionId, { ... })`) add:
```ts
await this.store.save(dispatch.sessionId, { stage: 'awaiting_titles', profile: dispatch.profile })
```

After line 64 (`session.stage = 'awaiting_skills'`) add:
```ts
await this.store.save(p.sessionId, session)
```

Replace line 77 (`this.sessions.delete(result.sessionId)`) with:
```ts
this.sessions.delete(result.sessionId)
await this.store.delete(result.sessionId)
```

Replace line 80 (the second `this.sessions.delete(result.sessionId)`) with the same two-line pair.

- [ ] **Step 3: Run research-lead tests**

Run: `bun test tests/agents/research/research-lead.test.ts`
Expected: all existing tests still pass.

- [ ] **Step 4: Commit**

```bash
git add src/agents/research/research-lead.ts tests/agents/research/research-lead.test.ts
git commit -m "feat: ResearchLead persists session state via SessionStore"
```

---

## Task 6: Wire stores into main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Build the two stores and pass them in**

Edit `src/main.ts`:

a) Add to imports (top of file):
```ts
import { SessionStore } from './agents/session-store'
import type { SessionState } from './agents/orchestrator'
import type { ResearchSession } from './agents/research/research-lead'
```

b) After `await runMigrations()` (line 24) and before the `createRuntime` call, add:
```ts
const orchestratorStore = new SessionStore<SessionState>({ pool, table: 'orchestrator_sessions' })
const researchStore = new SessionStore<ResearchSession>({ pool, table: 'research_lead_sessions' })
```

c) Update the `agents` array (lines 29–42) — replace the two affected constructions:

```ts
new Orchestrator(queue, anthropic, orchestratorStore),
```

```ts
new ResearchLead(queue, anthropic, researchStore),
```

(The other rows stay as-is.)

- [ ] **Step 2: Boot the server end-to-end**

Run: `bun run dev` from a terminal. Watch for "Server ready: ..." and confirm no startup errors. Stop with Ctrl+C.

Expected: clean boot, migrations include the two new tables, no errors.

- [ ] **Step 3: Run all backend tests**

Run: `bun test tests/agents tests/db tests/http tests/integration`
Expected: all pass except the long-standing `(fail) postgres > (unnamed)` if Postgres isn't reachable (it should be — Docker container is up). On a healthy DB, 0 failures.

- [ ] **Step 4: Commit**

```bash
git add src/main.ts
git commit -m "feat: wire SessionStore instances into agents at boot"
```

---

## Task 7: Integration test for restart recovery

**Files:**
- Create: `tests/integration/orchestrator-restart.test.ts`

Drive the orchestrator through intake → research, simulate a restart by stopping it and constructing a brand-new instance with a fresh in-memory Map, send the resume RESULT, and confirm the new instance picks up the session from DB and transitions correctly instead of emitting the "Unknown session" error.

- [ ] **Step 1: Write the failing test**

Create `tests/integration/orchestrator-restart.test.ts`:

```ts
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
const SID = '88888888-8888-8888-8888-888888888888'

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

  test('a session created in one orchestrator instance survives into a fresh instance', async () => {
    // Phase 1: instance A processes intake -> research -> intermediate state
    const a = new Orchestrator(queue, new Anthropic({ apiKey: 'k' }), store)

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: SID,
      profile: { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null },
    } satisfies IntakeResultPayload)

    // Seed the orchestrator with the session first so the IntakeResult finds it.
    // The intake-result branch at line 93 returns early if there's no session.
    // In real flow the session was created by the prior DISPATCH; replicate that here:
    await store.save(SID, { stage: 'intake' }, 'intake')

    const aRun = a.run()
    await Bun.sleep(200)
    await a.stop()
    await aRun

    // Drain noise
    drainQueue(AgentRole.RESEARCH_LEAD)
    drainQueue(AgentRole.HTTP_API)

    // Push research RESULT in to advance to building_resume
    queue.send(AgentRole.RESEARCH_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: SID,
      jobTitles: [{ title: 'Security Engineer', description: 'd', relevanceReason: 'r' }],
      skillsByTitle: [],
    } satisfies ResearchResultPayload)

    const a2 = new Orchestrator(queue, new Anthropic({ apiKey: 'k' }), store)
    const a2Run = a2.run()
    await Bun.sleep(200)
    await a2.stop()
    await a2Run

    drainQueue(AgentRole.RESUME_LEAD)
    drainQueue(AgentRole.HTTP_API)

    // Confirm DB has stage=building_resume
    const persisted = await store.load(SID)
    expect(persisted?.stage).toBe('building_resume')

    // Phase 2: brand-new orchestrator B with a brand-new Map, only state is in DB
    const b = new Orchestrator(queue, new Anthropic({ apiKey: 'k' }), store)

    // Send the resume RESULT
    queue.send(AgentRole.RESUME_LEAD, AgentRole.ORCHESTRATOR, MessageType.RESULT, {
      sessionId: SID,
      sections: [{ title: 'Summary', content: 'hi' }],
    } satisfies ResumeResultPayload)

    const bRun = b.run()
    await Bun.sleep(200)
    await b.stop()
    await bRun

    // Drain HTTP_API and look for STATUS awaiting_resume_approval, NOT an Unknown-session ERROR
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

    // Confirm DB has the new stage
    const after = await store.load(SID)
    expect(after?.stage).toBe('awaiting_resume_approval')
  })
})
```

- [ ] **Step 2: Run the test**

Run: `bun test tests/integration/orchestrator-restart.test.ts`
Expected: PASS.

If it fails with "Unknown session", the orchestrator's `run()` override didn't seed the Map — re-check Task 4 Step 2c.

- [ ] **Step 3: Run the entire backend suite once more**

Run: `bun test tests/agents tests/db tests/http tests/integration`
Expected: all pass on a healthy Postgres.

- [ ] **Step 4: Commit**

```bash
git add tests/integration/orchestrator-restart.test.ts
git commit -m "test: integration test confirming orchestrator session survives instance restart"
```

---

## Self-Review

**Spec coverage:**

- "A workflow that has reached any non-terminal stage MUST survive a server restart" → Tasks 4, 5, 7
- "No change to the existing handler logic" → Tasks 4, 5 only add `await this.store.save/.delete` calls next to existing `set`/`delete`
- "Tests cover round-trip CRUD, startup restoration, and an end-to-end restart-mid-flow scenario" → Tasks 1, 4, 5, 7
- Two new tables `orchestrator_sessions` and `research_lead_sessions` → Tasks 2, 3
- `SessionStore<T>` class with `load`, `save`, `delete`, `loadAll` → Task 1
- DI into agents via constructor → Tasks 4, 5
- Wire in main.ts → Task 6
- `nonTerminalStages` filter from spec: dropped during plan writing (YAGNI). All sessions in the orchestrator table are non-terminal by construction (terminal states are deleted, not saved). The `loadAll` API just returns every row. Documented in plan but not in code as a config knob — if a stage filter ever becomes needed, add it then. (Spec Section "Architecture > SessionStore<T> class" mentions `nonTerminalStages?: string[]` as optional — this plan honors that by omission.)

**Placeholder scan:** none.

**Type consistency:** `SessionStore<T>`, `SessionState`, `ResearchSession`, table column names match across all task code blocks. Constructor signature `(queue, anthropic, store)` is identical for both agents.

**Existing test ergonomics:** Task 4 and 5 truncate the table in `beforeEach` to keep tests isolated. The two suites use *different* tables (orchestrator_sessions vs research_lead_sessions) so they don't step on each other even when run in parallel.

**Out-of-scope items deferred:** retention of completed sessions, persistence for other agents, stage indexing on `orchestrator_sessions` (we only `SELECT *` today, no `WHERE stage = ...`).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-persistent-session-state.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between
2. **Inline Execution** — execute tasks in this session via executing-plans, batch with checkpoints

Which approach?
