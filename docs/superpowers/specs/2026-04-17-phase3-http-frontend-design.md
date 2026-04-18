# Phase 3 - HTTP Server + Frontend

**Date:** 2026-04-17
**Status:** Approved
**Depends on:** `2026-04-17-job-search-agent-design.md` (Phase 1), `2026-04-17-foundation.md`, `2026-04-17-agents.md`

---

## Overview

Phase 3 adds the HTTP layer and React frontend on top of the existing agent system. The agent hierarchy, SQLite message queue, and Postgres persistence already exist. This phase wires a Hono server into the same Bun process, introduces a new `HttpApiAgent` to bridge the queue and SSE clients, and builds a five-section React UI with a gated side nav.

No changes are made to agent business logic. The orchestrator and leads gain one responsibility: emit `STATUS` / `RESULT` / `ERROR` messages to `AgentRole.HTTP_API` at meaningful checkpoints so the frontend can observe progress.

---

## Design Decisions

| # | Decision | Choice |
|---|---|---|
| 1 | User flow | Dashboard + gated routes - sidebar always visible, locked sections grey until prerequisites land |
| 2 | Auth | Localhost bind + static session token, printed once to stdout on startup |
| 3 | Resume display | Styled document preview with an Edit-mode toggle |
| 4 | Interview prep flow | One-shot Q&A - each round is a fresh dispatch, no continuous session |
| 5 | HTTP↔agent bridge | `HttpApiAgent` extends `BaseAgent` and polls the queue like every other agent |

---

## Architecture

```
Frontend ──HTTP──> Hono ──send(HTTP_API→ORCHESTRATOR, DISPATCH)──> Queue ──> Orchestrator ──> Leads ──> Subs
                     ▲                                                         │
                     │                                                         ▼
                     └── SSE ◄── emitter ◄── HttpApiAgent ◄── Queue ◄── send(HTTP_API, STATUS/RESULT)
```

Both the agent runtime and the Hono server run in the same Bun process. `HttpApiAgent` is registered like any other agent on startup. The Hono server holds a reference to it and uses it both to dispatch commands into the system and to subscribe to per-session event streams.

---

## Backend Components

### `src/http/http-api-agent.ts`

`HttpApiAgent extends BaseAgent` with `role = HTTP_API`, `model = ''` (never calls LLMs).

**Internal state:**
```ts
sessions: Map<sessionId, {
  stage: OrchestratorStage,
  lastEvent: AgentEvent | null,
  emitter: EventEmitter,
  buffer: AgentEvent[],        // capped at 200, drops oldest
  subscriberCount: number,
  lastActivityAt: number,
}>
```

**`handleMessage(msg)`:**
- Extract `sessionId` from `msg.payload`.
- Convert to `AgentEvent { id, type, from, payload, timestamp }` where `type` is `'status' | 'result' | 'error' | 'stage'`. `id` is a per-session monotonic integer assigned by `HttpApiAgent` so `Last-Event-ID` replay is correct.
- Append to session buffer.
- Emit via session emitter.
- Update `lastEvent` and `lastActivityAt`.

**Public methods (called directly by Hono handlers):**
- `startSession(payload: IntakeDispatchPayload): void` - creates session meta, then `this.send(ORCHESTRATOR, DISPATCH, payload)`.
- `sendCommand(sessionId: string, payload: ApproveResumePayload | StartInterviewPayload): void` - forwards to orchestrator.
- `getSnapshot(sessionId: string): Snapshot | null` - `{ stage, events, resumeSections?, jobTitles?, skillsByTitle? }`.
- `subscribe(sessionId, lastEventId?): AsyncIterable<AgentEvent>` - replays buffer from `lastEventId` (or start), then streams live events until the iterator is aborted.

**Purge:** A timer sweeps every 5 min; sessions with `lastActivityAt` older than 1 h and no subscribers are dropped.

### `src/http/server.ts`

Hono app factory. Wires routes to `HttpApiAgent`. Middleware chain (outermost first):
1. Request logger
2. JSON body limit (1 MB)
3. Auth (bearer token on `Authorization` header; query param `token` accepted for SSE only)

### Routes

| Method | Path | Body | Response |
|---|---|---|---|
| `POST` | `/sessions` | `IntakeDispatchPayload` minus `sessionId` | `{ sessionId }` |
| `GET` | `/sessions/:id` | - | `Snapshot` |
| `GET` | `/sessions/:id/events` | - | SSE stream of `AgentEvent` |
| `POST` | `/sessions/:id/approve` | `{ targetTitles: string[] }` | `{ ok: true }` |
| `POST` | `/sessions/:id/interview` | `StartInterviewPayload` minus `sessionId` | `{ ok: true }` |
| `GET` | `/jobs` | - | `Job[]` |
| `POST` | `/jobs` | `NewJob` | `Job` |
| `PUT` | `/jobs/:id` | `Partial<Job>` | `Job` |
| `DELETE` | `/jobs/:id` | - | `{ ok: true }` |
| `GET` | `/config` | - | `{}` |
| `GET` | `/` + `/*` | - | Static files from `dist/` |

All request bodies are validated with zod schemas that `satisfies` the matching interface in `src/agents/types.ts`.

### Auth token flow

- On startup, generate a random 32-byte hex token.
- Print once: `Server ready: http://localhost:<port>?token=<token>`.
- Also write to `.session-token` (gitignored). If the file cannot be written, exit with error.
- Frontend reads `?token=` from URL on first load, stores in `sessionStorage`, strips from URL via `history.replaceState`.
- All fetches send `Authorization: Bearer <token>`. SSE uses the same token as a query param.
- Server binds `127.0.0.1` only. Port is `PORT` env var or `3000` by default.
- Token is not rotatable within a process. Server restart yields a new token.

### Orchestrator emissions

Existing logic is unchanged. Added: in each `case` of `handleMessage`, after updating session state, call `this.send(HTTP_API, STATUS, { sessionId, stage, agent: this.role, message })`. When `RESUME_LEAD` result lands, also send a `RESULT` to `HTTP_API` carrying the full `ResumeResultPayload`. Similar `RESULT` emissions for `JOB_SEARCH_LEAD` (jobs found count) and `INTERVIEW_PREP_LEAD` (feedback). Leads add a single `this.send(HTTP_API, STATUS, { ... })` call at each meaningful checkpoint; sub-agents do not emit to HTTP_API directly (leads represent their progress).

Unknown-session DISPATCH from `HTTP_API` produces an `ERROR` emission back to `HTTP_API` instead of silent drop.

---

## Frontend Components

Stack: React 18, Vite, React Router, plain CSS modules. Built into `dist/`, served by the same Hono server.

### Structure

```
src/web/
  main.tsx              entry
  App.tsx               routes + auth bootstrap
  api.ts                fetch wrapper (bearer token)
  sse.ts                EventSource wrapper, session-scoped
  state/
    session.ts          useSessionStore - Zustand, holds stage + payloads + events
  components/
    Layout.tsx          sidebar + main pane
    ActivityBar.tsx     live status, wired to SSE
    GatedLink.tsx       grey-out + tooltip
  routes/
    Intake.tsx
    Research.tsx
    Resume.tsx          preview-mode ↔ edit-mode toggle
    Jobs.tsx
    Interview.tsx
```

### Session store (Zustand)

```ts
{
  sessionId: string | null
  stage: OrchestratorStage
  profile?: UserProfile
  jobTitles?: JobTitleResult[]
  skillsByTitle?: SkillsResult[]
  resumeSections?: ResumeSection[]
  interviewQuestion?: string
  interviewFeedback?: InterviewFeedback
  events: AgentEvent[]           // rolling feed, capped at 100 in-browser
  setFromSnapshot(snapshot): void
  setFromEvent(event): void
  reset(): void
}
```

`sessionId` is persisted to `sessionStorage`. Refresh recovers it, calls `GET /sessions/:id` to hydrate, then opens SSE.

### Gate rules (for `GatedLink`)

| Route | Unlocked when |
|---|---|
| Intake | always |
| Research | `jobTitles` populated in store |
| Resume | `resumeSections` populated (stage ≥ `awaiting_resume_approval`) |
| Jobs | always (manual entries allowed any time; agent-sourced rows appear after stage ≥ `searching_jobs`) |
| Interview | `resumeSections` populated |

Locked links render greyed, show a tooltip on hover, and click is a no-op.

### Resume screen (decision 3)

Default view: preview mode. Serif typography (Georgia), centered header with name + target title, SECTION headers in small caps, bulleted content. "Edit" button flips to edit mode: each `ResumeSection` becomes an editable title + content pair. "Preview" returns. "Approve targets & continue" renders a checklist of `jobTitles` (multi-select) at the bottom; submit fires `POST /sessions/:id/approve`.

### Interview screen (decision 4)

Topic list on the left (derived client-side from `resumeSections` + `skillsByTitle`). Click a topic → `POST /sessions/:id/interview` with `{ resumeSections, selectedTopic }` (no `userAnswer`). SSE streams back the question; renders. User types answer, clicks Submit. Second `POST` with `{ resumeSections, selectedTopic, userAnswer, question }`. Feedback renders below. "New question" clears local state and returns to the topic list. No running history.

### ActivityBar

Sticky bottom bar. Shows the most recent STATUS event text plus a spinner when an agent is active. Collapses to an icon when idle. Backed by the last 5 events in the store.

---

## Data Flow (End-to-End)

1. **Land on app** - Hono serves `dist/index.html`. Frontend reads `?token=`, strips URL. No `sessionId` → only Intake is navigable.
2. **Intake submit** - `POST /sessions`. Server generates `sessionId`, calls `httpApiAgent.startSession(...)`. HttpApiAgent sends DISPATCH to ORCHESTRATOR. Response returns `sessionId`; frontend stores it and opens SSE.
3. **Agent execution** - Orchestrator and leads emit STATUS to HTTP_API at every stage transition and meaningful checkpoint. On `building_resume` → `awaiting_resume_approval`, orchestrator also emits a RESULT with `ResumeResultPayload`.
4. **Frontend reaction** - `setFromEvent` updates the store. Nav links unlock as payloads arrive. Routes auto-populate if already visited.
5. **Resume approval** - User picks target titles, clicks Approve. `POST /sessions/:id/approve` → `httpApiAgent.sendCommand(...)` → DISPATCH to ORCHESTRATOR (orchestrator's existing `targetTitles && !selectedTopic` branch). Orchestrator dispatches to JOB_SEARCH_LEAD. Jobs route populates from agent-sourced rows plus any manual entries.
6. **Interview round** - User picks a topic. `POST /sessions/:id/interview` (no answer). Orchestrator dispatches to INTERVIEW_PREP_LEAD → TOPIC_DRILL generates a question. Returned as RESULT. User answers; second POST (with `userAnswer` + `question`). Feedback returned as RESULT. Round ends.
7. **Refresh mid-run** - Frontend reads `sessionId` from `sessionStorage`, calls `GET /sessions/:id`, hydrates store, opens SSE.
8. **Disconnect / reconnect** - `EventSource` auto-retries. Client sends `Last-Event-ID`; server replays buffered events strictly after that ID, then streams live events. Purged sessions respond with a terminal `session-expired` event.

---

## Error Handling

**Agent errors:** Orchestrator and leads send `ERROR` to HTTP_API on catch paths that matter (domain failures, not transient polling hiccups). HttpApiAgent converts to `AgentEvent { type: 'error' }`. Frontend renders in ActivityBar with red styling; the affected route shows an inline error banner with a Retry button. Retry re-dispatches the last relevant payload.

**Route errors:**
- Input validation via zod → 400 with `{ error, details }`.
- Missing session → 404.
- Auth failure → 401, no details.
- Unexpected throws → 500 with a request ID logged server-side.

**SSE:**
- 15 s heartbeat (`: ping\n\n`) keeps intermediaries from closing idle connections.
- `Last-Event-ID` on reconnect controls replay cursor.
- Purged session → terminal `session-expired` event, then close.

**Auth hygiene:**
- Token lives in `sessionStorage` (dies with the tab), not `localStorage`.
- URL is stripped of `?token=` immediately on load.
- No rotation within a process. Server restart = new token.

**Postgres failures (Jobs):** Pool errors caught per-handler; return 503 with retry hint. Agent flow is unaffected since persistence is write-only from JOB_SEARCH_LEAD and can be retried.

---

## Testing

**Unit - `tests/http/http-api-agent.test.ts`:**
- Feed synthetic messages into `handleMessage`; assert buffer accumulation and cap behavior, emitter fires correct `AgentEvent`, purge respects fake clock.
- `subscribe` replays buffer then streams live events; honors `Last-Event-ID`.
- `startSession` and `sendCommand` produce the expected queue messages with `from_agent = HTTP_API`.

**Routes - `tests/http/routes.test.ts`:**
- Auth middleware: missing / wrong / correct token paths.
- `POST /sessions` flow: response shape, orchestrator receives the DISPATCH.
- `GET /sessions/:id` snapshot.
- `/approve` and `/interview` produce correct DISPATCH shapes.
- SSE endpoint: connect, receive replayed buffered events, then live events emitted via HttpApiAgent.
- Unknown session → 404 for reads, ERROR event for stale commands.
- Invalid payloads → 400.

**Orchestrator emissions - extend `tests/agents/orchestrator.test.ts`:**
- For each state transition, assert a STATUS to HTTP_API with the right stage.
- RESUME_LEAD RESULT → orchestrator emits RESULT to HTTP_API with `ResumeResultPayload`.
- Unknown-session DISPATCH from HTTP_API → ERROR emission back to HTTP_API.

**Integration - `tests/integration/full-flow.test.ts`:**
- One happy-path test. Real Hono server on an ephemeral port. Anthropic / Brave / Adzuna mocked at existing module boundaries.
- Drive via `fetch`: POST intake, open SSE, assert events arrive in order through `awaiting_resume_approval`, POST approve, assert `searching_jobs` STATUS event arrives.

**Frontend - light:**
- Vitest + React Testing Library for `setFromEvent` unlock rules and `GatedLink` behavior (~5 tests).
- Manual test checklist in PR description: intake happy path, approve resume, jobs populate, interview round-trip, refresh-mid-run recovery.

**Type safety:** All payloads crossing HTTP ↔ agent boundaries reuse types from `src/agents/types.ts`. Server-side zod schemas use `.satisfies<T>()` patterns so drift is caught at compile time.

---

## Out of Scope for Phase 3

- Multi-user auth, login screens, accounts
- Canopy / Mulch integration (Phase 1 spec mentions them; still deferred)
- PDF export of the styled resume
- Playwright / E2E tests
- Token rotation or revocation
- Interview drill loop mode (deferred by decision 4)
- Resume version history / diff
