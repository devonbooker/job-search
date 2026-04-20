# Persistent Session State (A1) — Design

**Date:** 2026-04-19
**Status:** Approved (pending user spec review)
**Sub-project of:** Phase 4 backlog (post-MVP browser-tested gaps)

## Problem

`Orchestrator` and `ResearchLead` keep per-session workflow state in in-memory `Map<sessionId, ...>` only. The state is lost on every process restart. During development this turns every code change into a session-killing event ("Unknown session: ..." after each `bun --watch` reload). In production the same happens on any deploy, crash, or manual restart, leaving in-flight workflows orphaned.

## Goals

- A workflow that has reached any non-terminal stage MUST survive a server restart and resume on the next user command.
- No change to the existing handler logic in `Orchestrator` / `ResearchLead` beyond adding write-through persistence at mutation points.
- Tests cover round-trip CRUD, startup restoration, and an end-to-end restart-mid-flow scenario.

## Non-goals

- Long-term session history / "view past resumes." Terminal sessions are still deleted on completion, matching today's `sessions.delete()` behavior. Retention is a separate future feature.
- Persisting per-session state in any agent other than `Orchestrator` and `ResearchLead`. Other agents only hold state across a single LLM call (sub-second window) — restart impact is negligible.
- Schema-level queryability. State is a JSONB blob; we never query into its fields from SQL.

## Architecture

### Storage

Two new Postgres tables, one per agent. Both follow the same shape:

```sql
-- 004_create_orchestrator_sessions.sql
CREATE TABLE IF NOT EXISTS orchestrator_sessions (
  session_id UUID PRIMARY KEY,
  stage TEXT NOT NULL,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- 005_create_research_lead_sessions.sql
CREATE TABLE IF NOT EXISTS research_lead_sessions (
  session_id UUID PRIMARY KEY,
  state JSONB NOT NULL,
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
```

`stage` is broken out as a column on `orchestrator_sessions` because the startup-restoration filter ("load all non-terminal sessions") needs it indexable. `research_lead_sessions` doesn't need a corresponding column — research is always non-terminal until the row is deleted.

Both migrations land in `src/db/migrations/` following the existing `001_*`, `002_*`, `003_*` numbered-file pattern. `runMigrations()` already discovers and runs them idempotently.

### `SessionStore<T>` class

A new generic class wraps a single table with a typed CRUD interface:

```ts
// src/agents/session-store.ts
export interface SessionStoreConfig {
  table: string
  pool: Pool
  /** Stages whose presence in DB means "still in flight"; empty = all rows are non-terminal */
  nonTerminalStages?: string[]
}

export class SessionStore<T> {
  constructor(private config: SessionStoreConfig) {}
  async load(sessionId: string): Promise<T | undefined>
  async save(sessionId: string, state: T, stage?: string): Promise<void>  // upsert
  async delete(sessionId: string): Promise<void>
  async loadAll(): Promise<Map<string, T>>  // filtered by nonTerminalStages if provided
}
```

Two instances at runtime, both built in `main.ts`:

- `new SessionStore<SessionState>({ table: 'orchestrator_sessions', pool, nonTerminalStages: ALL_NON_TERMINAL_ORCHESTRATOR_STAGES })`
- `new SessionStore<ResearchSession>({ table: 'research_lead_sessions', pool })`

### Wiring into agents

`Orchestrator` and `ResearchLead` constructors gain a `SessionStore<...>` parameter:

```ts
constructor(queue: MessageQueue, anthropic: Anthropic, store: SessionStore<SessionState>) { ... }
```

Inside each agent:

- `run()` override calls `await this.store.loadAll()` and seeds `this.sessions` before delegating to `super.run()`.
- Every `this.sessions.set(id, x)` is followed by `await this.store.save(id, x, x.stage)` (write-through).
- Every `this.sessions.delete(id)` is followed by `await this.store.delete(id)`.

Handler logic is otherwise unchanged. The `Map` stays — it remains the source of truth for reads inside the loop, the DB is just the durability layer.

### Startup sequence in `main.ts`

```
runMigrations()
  → creates session tables if absent
const orchestratorStore = new SessionStore<SessionState>({ ... })
const researchStore = new SessionStore<ResearchSession>({ ... })
const orchestrator = new Orchestrator(queue, anthropic, orchestratorStore)
const researchLead = new ResearchLead(queue, anthropic, researchStore)
  // their run() will await loadAll() before starting the message loop
```

### Failure modes

- **DB unreachable at boot:** `runMigrations()` already throws — main.ts already crashes. No change.
- **DB unreachable mid-handler on `save`:** the write-through `await` rejects, `BaseAgent.loop`'s catch fires, message gets acked + ERROR emitted (matches existing behavior for any thrown handler error). The in-memory state is now ahead of DB; next restart will lose that one transition. Acceptable for v1.
- **DB unreachable on `loadAll` at boot:** agent crashes loudly. Acceptable.
- **Race between save and a concurrent ack of a stale message:** N/A — each agent's loop is single-threaded over its own queue.

## Tests

### Unit: `SessionStore`
- Round-trip: save → load returns same blob.
- Upsert: save twice with different state, second wins.
- Delete: save, delete, load returns undefined.
- `loadAll` with `nonTerminalStages` filter: insert rows with mixed stages, confirm only non-terminal ones come back.

### Unit: `Orchestrator` and `ResearchLead`
- Existing tests gain a `new SessionStore(...)` against a real test DB connection (the test suite already runs migrations against the same Postgres). No mocks — test the real durability path.
- Add one test per agent that simulates restart: instantiate agent A, run a handler that mutates session state, stop A, instantiate agent B with a fresh in-memory `Map`, confirm `B.sessions` contains the saved state after `loadAll`.

### Integration
- Drive a session through intake → research RESULT → orchestrator transitions to `building_resume`. Stop the orchestrator. Spin up a fresh orchestrator. Send the resume RESULT. Confirm orchestrator finds the session, transitions to `awaiting_resume_approval`, and emits the right STATUS instead of `Unknown session`.

## Files

**New:**
- `src/agents/session-store.ts` — the `SessionStore<T>` class
- `src/db/migrations/004_create_orchestrator_sessions.sql`
- `src/db/migrations/005_create_research_lead_sessions.sql`
- `tests/agents/session-store.test.ts`
- `tests/integration/orchestrator-restart.test.ts`

**Modified:**
- `src/agents/orchestrator.ts` — constructor param, `run()` override, write-through on `set`/`delete`
- `src/agents/research/research-lead.ts` — same pattern
- `src/main.ts` — instantiate stores, pass to agents
- `tests/agents/orchestrator.test.ts` — wire stores into existing tests
- `tests/agents/research/research-lead.test.ts` — same

## Self-Review

- Placeholder scan: none.
- Internal consistency: tables match the wiring; migration filenames match existing pattern; `nonTerminalStages` filter on `loadAll` is honored only by orchestrator (research is always non-terminal).
- Scope: bounded — single feature, ~10 files, clear stop point.
- Ambiguity: `nonTerminalStages` parameter is opt-in; if omitted, `loadAll` returns every row in the table. The orchestrator MUST pass the explicit list (defined as a const next to `OrchestratorStage`).
