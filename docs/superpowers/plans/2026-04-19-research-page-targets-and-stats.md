# Research Page Targets + Stats Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move "pick target titles" from Resume page to Research page, and surface average salary + openings count per title (sourced from Adzuna).

**Architecture:** New `awaiting_title_selection` orchestrator stage between `researching` and `building_resume`. Two new HTTP endpoints replace the single `/approve`: `/select-titles` (titles → resume build) and `/approve-resume` (resume looks good → job search). `JobTitleResult` gains optional `avgSalaryUsd` + `openingsCount` populated inline by `ResearchLead` via per-title Adzuna `/jobs/us/search` calls.

**Tech Stack:** Bun + TypeScript, Hono routes, Postgres (existing JSONB session tables from A1), Vite/React frontend, Zustand store, vitest + bun:test.

---

## File Structure

**New:**
- `tests/web/research-route.test.tsx` — Research page component test

**Modified — backend:**
- `src/agents/types.ts` — add optional `avgSalaryUsd`/`openingsCount` to `JobTitleResult`; add `SelectTitlesPayload`; simplify `ApproveResumePayload`
- `src/agents/events.ts` — add `'awaiting_title_selection'` to `OrchestratorStage`
- `src/agents/orchestrator.ts` — stop at `awaiting_title_selection` after research; new SelectTitles branch; simplified ApproveResume branch; `targetTitles` on `SessionState`
- `src/agents/research/research-lead.ts` — inline `fetchTitleStats` after job-title-research returns; constructor gains adzuna creds + fetcher
- `src/main.ts` — pass adzuna env into ResearchLead constructor
- `src/http/schemas.ts` — `selectTitlesBody` + `approveResumeBody` (replace `approveBody`)
- `src/http/routes/sessions.ts` — replace `/approve` with `/select-titles` + `/approve-resume`

**Modified — frontend:**
- `src/web/routes/Research.tsx` — full rewrite: per-title rows with checkboxes, stats, inline skills, approve button
- `src/web/routes/Resume.tsx` — strip target-picker UI; "Approve resume → start job search" button
- `src/web/api.ts` — `selectTitles` + `approveResume` (replace `approve`)

**Modified — tests:**
- `tests/agents/orchestrator.test.ts` — update existing assertions; add SelectTitles tests
- `tests/agents/research/research-lead.test.ts` — inject Adzuna constructor params; add stats tests
- `tests/integration/full-flow.test.ts` — update flow assertions for new stage gate
- (no `tests/http/routes.test.ts` change needed — file currently has no `/approve` tests; new tests added in dedicated step)

---

## Task 1: Backend types + new stage value

**Files:**
- Modify: `src/agents/types.ts`
- Modify: `src/agents/events.ts`

Pure type-level changes; nothing else compiles against them yet so no test loop required for this task.

- [ ] **Step 1: Update `src/agents/events.ts`**

Replace the existing `OrchestratorStage` type:

```ts
export type OrchestratorStage =
  | 'idle'
  | 'intake'
  | 'researching'
  | 'awaiting_title_selection'
  | 'building_resume'
  | 'awaiting_resume_approval'
  | 'searching_jobs'
  | 'interview_prep'
```

- [ ] **Step 2: Update `src/agents/types.ts`**

Locate the `JobTitleResult` interface (around line 43) and replace it:

```ts
export interface JobTitleResult {
  title: string
  description: string
  relevanceReason: string
  avgSalaryUsd?: number
  openingsCount?: number
}
```

Locate the `ApproveResumePayload` interface (around line 83) and replace it:

```ts
// Sent after user approves resume in UI; triggers job search using stored targetTitles
export interface ApproveResumePayload {
  sessionId: string
}
```

Add a new `SelectTitlesPayload` interface immediately below it:

```ts
// Sent after user picks target titles on Research page; triggers resume build
export interface SelectTitlesPayload {
  sessionId: string
  targetTitles: string[]
}
```

- [ ] **Step 3: Verify everything still compiles via tests**

Run: `bun test tests/agents/session-store.test.ts`
Expected: still 6 pass.

Existing call sites that reference `ApproveResumePayload.targetTitles` (in orchestrator + tests + schemas) WILL fail to compile or will produce wrong runtime behavior. That's fine — Tasks 3 and 4 fix them. We don't run the broken suites yet.

- [ ] **Step 4: Commit**

```bash
git add src/agents/types.ts src/agents/events.ts
git commit -m "feat(types): add awaiting_title_selection stage + SelectTitlesPayload + JobTitleResult stats fields"
```

---

## Task 2: ResearchLead inline Adzuna stats

**Files:**
- Modify: `src/agents/research/research-lead.ts`
- Modify: `tests/agents/research/research-lead.test.ts`

ResearchLead constructor gains `adzunaAppId`, `adzunaAppKey`, `fetcher` parameters with env-defaulted fallbacks (mirroring `JobTitleResearch`'s pattern). After job-title-research returns, fetch per-title stats from Adzuna and decorate the in-memory `session.jobTitles` before dispatching `SkillsMarketResearch`.

- [ ] **Step 1: Write the new tests**

Edit `tests/agents/research/research-lead.test.ts`. Add at the top of the existing imports block:

```ts
import type { JobTitleResult } from '../../../src/agents/types'
```

Update the `agent = new ResearchLead(...)` lines in `beforeEach` to pass the new constructor args. Currently:

```ts
agent = new ResearchLead(queue, new Anthropic({ apiKey: 'test-key' }), store)
```

Change to:

```ts
agent = new ResearchLead(
  queue,
  new Anthropic({ apiKey: 'test-key' }),
  store,
  'test-app-id',
  'test-app-key',
  globalThis.fetch,
)
```

Then add two new tests at the bottom of the `describe` block (just before the closing `})`):

```ts
test('attaches Adzuna stats to each title before dispatching SkillsMarketResearch', async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    const what = decodeURIComponent(new URL(url).searchParams.get('what') ?? '')
    if (what === 'Security Engineer') {
      return new Response(JSON.stringify({
        count: 1234,
        results: [
          { salary_min: 120000, salary_max: 160000 },
          { salary_min: 100000, salary_max: 140000 },
        ],
      }), { status: 200 })
    }
    return new Response(JSON.stringify({ count: 50, results: [] }), { status: 200 })
  }

  agent = new ResearchLead(queue, new Anthropic({ apiKey: 'test-key' }), store, 'id', 'key', fakeFetch)

  queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
    sessionId: 'rl-stats-1',
    profile: { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null },
  } satisfies ResearchDispatchPayload)

  // Drain JobTitleResearch dispatch noise
  const runPromise = agent.run()
  await Bun.sleep(100)

  // Send the JobTitleResearch result back into the queue
  queue.send(AgentRole.JOB_TITLE_RESEARCH, AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
    sessionId: 'rl-stats-1',
    jobTitles: [
      { title: 'Security Engineer', description: 'd', relevanceReason: 'r' },
      { title: 'DevOps Engineer', description: 'd2', relevanceReason: 'r2' },
    ],
  } satisfies JobTitleResearchResultPayload)

  await Bun.sleep(200)
  await agent.stop()
  await runPromise

  // Inspect what was dispatched to SkillsMarketResearch
  const skillsDispatch = queue.receive(AgentRole.SKILLS_MARKET_RESEARCH)
  expect(skillsDispatch).not.toBeNull()
  const payload = skillsDispatch!.payload as { jobTitles: JobTitleResult[] }
  const sec = payload.jobTitles.find(t => t.title === 'Security Engineer')!
  expect(sec.openingsCount).toBe(1234)
  expect(sec.avgSalaryUsd).toBe(130000) // mean of (140000, 120000)
  const dev = payload.jobTitles.find(t => t.title === 'DevOps Engineer')!
  expect(dev.openingsCount).toBe(50)
  expect(dev.avgSalaryUsd).toBeUndefined()
})

test('gracefully degrades when Adzuna call for a title returns 422', async () => {
  const fakeFetch: typeof fetch = async (input) => {
    const url = String(input)
    const what = decodeURIComponent(new URL(url).searchParams.get('what') ?? '')
    if (what === 'Security Engineer') {
      return new Response('Unprocessable', { status: 422 })
    }
    return new Response(JSON.stringify({ count: 99, results: [{ salary_min: 80000, salary_max: 120000 }] }), { status: 200 })
  }

  agent = new ResearchLead(queue, new Anthropic({ apiKey: 'test-key' }), store, 'id', 'key', fakeFetch)

  queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
    sessionId: 'rl-stats-2',
    profile: { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null },
  } satisfies ResearchDispatchPayload)

  const runPromise = agent.run()
  await Bun.sleep(100)

  queue.send(AgentRole.JOB_TITLE_RESEARCH, AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
    sessionId: 'rl-stats-2',
    jobTitles: [
      { title: 'Security Engineer', description: 'd', relevanceReason: 'r' },
      { title: 'Backend Engineer', description: 'd2', relevanceReason: 'r2' },
    ],
  } satisfies JobTitleResearchResultPayload)

  await Bun.sleep(200)
  await agent.stop()
  await runPromise

  const skillsDispatch = queue.receive(AgentRole.SKILLS_MARKET_RESEARCH)
  const payload = skillsDispatch!.payload as { jobTitles: JobTitleResult[] }
  const sec = payload.jobTitles.find(t => t.title === 'Security Engineer')!
  expect(sec.avgSalaryUsd).toBeUndefined()
  expect(sec.openingsCount).toBeUndefined()
  const back = payload.jobTitles.find(t => t.title === 'Backend Engineer')!
  expect(back.openingsCount).toBe(99)
  expect(back.avgSalaryUsd).toBe(100000)
})
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test tests/agents/research/research-lead.test.ts`
Expected: the new two tests fail (constructor doesn't accept extra args; stats not present). Existing tests fail too because the new constructor signature isn't supported yet. That's expected.

- [ ] **Step 3: Modify `ResearchLead` to add stats fetch + new constructor params**

Edit `src/agents/research/research-lead.ts`. Replace the constructor (currently lines 33-39):

```ts
constructor(
  queue: MessageQueue,
  anthropic: Anthropic,
  private readonly store: SessionStore<ResearchSession>,
  private readonly adzunaAppId: string = process.env.ADZUNA_APP_ID ?? '',
  private readonly adzunaAppKey: string = process.env.ADZUNA_APP_KEY ?? '',
  private readonly fetcher: typeof fetch = globalThis.fetch,
) {
  super(queue, anthropic)
}
```

Add a private helper method just below `run()` and above `handleMessage`:

```ts
private async fetchTitleStats(titles: JobTitleResult[]): Promise<JobTitleResult[]> {
  return Promise.all(titles.map(async (jt) => {
    if (!this.adzunaAppId || !this.adzunaAppKey) return jt
    try {
      const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${this.adzunaAppId}&app_key=${this.adzunaAppKey}&what=${encodeURIComponent(jt.title)}&results_per_page=10`
      const res = await this.fetcher(url, { headers: { Accept: 'application/json' } })
      if (!res.ok) {
        console.warn(`[RESEARCH_LEAD] Adzuna stats ${res.status} for "${jt.title}"`)
        return jt
      }
      const data = await res.json() as {
        count?: number
        results?: { salary_min?: number; salary_max?: number }[]
      }
      const salaried = (data.results ?? []).filter(j => typeof j.salary_min === 'number' && typeof j.salary_max === 'number')
      const avgSalaryUsd = salaried.length > 0
        ? Math.round(salaried.reduce((sum, j) => sum + ((j.salary_min! + j.salary_max!) / 2), 0) / salaried.length)
        : undefined
      return { ...jt, openingsCount: data.count, avgSalaryUsd }
    } catch (err) {
      console.warn(`[RESEARCH_LEAD] Adzuna stats fetch error for "${jt.title}":`, err)
      return jt
    }
  }))
}
```

Modify the `awaiting_titles` branch in `handleMessage` (currently lines 72-82). Replace it with:

```ts
if (session.stage === 'awaiting_titles') {
  const result = message.payload as JobTitleResearchResultPayload
  const enriched = await this.fetchTitleStats(result.jobTitles)
  session.jobTitles = enriched
  session.stage = 'awaiting_skills'
  await this.store.save(p.sessionId, session)
  this.send(AgentRole.SKILLS_MARKET_RESEARCH, MessageType.DISPATCH, {
    sessionId: result.sessionId,
    profile: session.profile,
    jobTitles: enriched,
  } satisfies SkillsMarketResearchDispatchPayload)
  return
}
```

- [ ] **Step 4: Run tests to confirm they pass**

Run: `bun test tests/agents/research/research-lead.test.ts`
Expected: all tests pass (3 existing + 2 new = 5). If a test asserts something the new code doesn't satisfy, debug — don't mutate the assertions.

- [ ] **Step 5: Commit**

```bash
git add src/agents/research/research-lead.ts tests/agents/research/research-lead.test.ts
git commit -m "feat(research-lead): fetch per-title Adzuna salary + openings stats"
```

---

## Task 3: Orchestrator — new stage gate + SelectTitles + simplified ApproveResume

**Files:**
- Modify: `src/agents/orchestrator.ts`
- Modify: `tests/agents/orchestrator.test.ts`

Two concrete behavior changes:
1. RESEARCH_LEAD result no longer auto-dispatches RESUME_LEAD. It transitions to `awaiting_title_selection` and stops.
2. New DISPATCH branch: `SelectTitlesPayload` (has `targetTitles`, no `goals`, no `selectedTopic`) → save `targetTitles` to session, transition to `building_resume`, dispatch RESUME_LEAD.
3. Existing `ApproveResumePayload` branch: payload no longer carries `targetTitles`. Use `session.targetTitles`. Trigger JOB_SEARCH_LEAD with stored titles.

`SessionState` gains `targetTitles?: string[]`.

- [ ] **Step 1: Write/update tests first**

Edit `tests/agents/orchestrator.test.ts`.

Add to imports at the top:
```ts
import type { SelectTitlesPayload } from '../../src/agents/types'
```

Replace the existing test "routes research lead RESULT to ResumeLead" (currently around lines 100-123). The new behavior is "stops at awaiting_title_selection." Rename and rewrite:

```ts
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
```

Replace the existing "routes approve-resume dispatch to JobSearchLead" test (currently around lines 125-149). The new payload has no `targetTitles`. Rewrite:

```ts
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
```

- [ ] **Step 2: Run the tests to confirm they fail**

Run: `bun test tests/agents/orchestrator.test.ts`
Expected: the three new/updated tests fail. Other existing tests should still pass.

- [ ] **Step 3: Modify `Orchestrator`**

Edit `src/agents/orchestrator.ts`.

Update the `SessionState` interface:

```ts
export interface SessionState {
  stage: OrchestratorStage
  profile?: UserProfile
  research?: ResearchResultPayload
  resume?: ResumeResultPayload
  targetTitles?: string[]
}
```

Add `SelectTitlesPayload` to the imports from './types':
```ts
import {
  AgentRole,
  MessageType,
  type Message,
  type IntakeDispatchPayload,
  type ApproveResumePayload,
  type SelectTitlesPayload,  // ADD
  type StartInterviewPayload,
  // ... rest stays
}
```

In `handleMessage`, the DISPATCH branch — REPLACE the entire block of three `if` branches (intake / approve / interview). Currently lines 56-99. New version:

```ts
if (message.type === MessageType.DISPATCH) {
  const p = message.payload as Record<string, unknown>

  if (typeof p.goals === 'string') {
    const payload = p as unknown as IntakeDispatchPayload
    this.sessions.set(payload.sessionId, { stage: 'intake' })
    await this.store.save(payload.sessionId, { stage: 'intake' }, 'intake')
    this.emitStatus(payload.sessionId, 'intake')
    this.send(AgentRole.INTAKE_LEAD, MessageType.DISPATCH, payload)
    return
  }

  if (Array.isArray(p.targetTitles) && !('selectedTopic' in p)) {
    // SelectTitles - happens at awaiting_title_selection; advances to building_resume
    const payload = p as unknown as SelectTitlesPayload
    const session = this.sessions.get(payload.sessionId)
    if (!session) {
      this.emitUnknownSessionError(payload.sessionId)
      return
    }
    if (session.stage !== 'awaiting_title_selection') {
      console.warn(`[ORCHESTRATOR] SelectTitles for ${payload.sessionId} in wrong stage ${session.stage}; ignoring`)
      return
    }
    if (!session.research || !session.profile) {
      console.error(`[ORCHESTRATOR] missing research/profile for ${payload.sessionId} at SelectTitles`)
      return
    }
    session.targetTitles = payload.targetTitles
    session.stage = 'building_resume'
    await this.store.save(payload.sessionId, session, 'building_resume')
    this.emitStatus(payload.sessionId, 'building_resume')
    this.send(AgentRole.RESUME_LEAD, MessageType.DISPATCH, {
      sessionId: payload.sessionId,
      profile: session.profile,
      jobTitles: session.research.jobTitles,
      skillsByTitle: session.research.skillsByTitle,
      targetTitles: payload.targetTitles,
    } satisfies ResumeDispatchPayload)
    return
  }

  if ('sessionId' in p && Object.keys(p).length === 1) {
    // ApproveResume - empty body besides sessionId; happens at awaiting_resume_approval
    const payload = p as unknown as ApproveResumePayload
    const session = this.sessions.get(payload.sessionId)
    if (!session) {
      this.emitUnknownSessionError(payload.sessionId)
      return
    }
    if (session.stage !== 'awaiting_resume_approval') {
      console.warn(`[ORCHESTRATOR] ApproveResume for ${payload.sessionId} in wrong stage ${session.stage}; ignoring`)
      return
    }
    if (!session.targetTitles || session.targetTitles.length === 0) {
      console.error(`[ORCHESTRATOR] no targetTitles stored for ${payload.sessionId} at ApproveResume`)
      return
    }
    session.stage = 'searching_jobs'
    await this.store.save(payload.sessionId, session, 'searching_jobs')
    this.emitStatus(payload.sessionId, 'searching_jobs')
    this.send(AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, {
      sessionId: payload.sessionId,
      targetTitles: session.targetTitles,
    } satisfies JobSearchDispatchPayload)
    return
  }

  if (typeof p.selectedTopic === 'string') {
    const payload = p as unknown as StartInterviewPayload
    const session = this.sessions.get(payload.sessionId)
    if (!session) {
      this.emitUnknownSessionError(payload.sessionId)
      return
    }
    session.stage = 'interview_prep'
    await this.store.save(payload.sessionId, session, 'interview_prep')
    this.emitStatus(payload.sessionId, 'interview_prep')
    this.send(AgentRole.INTERVIEW_PREP_LEAD, MessageType.DISPATCH, {
      sessionId: payload.sessionId,
      resumeSections: payload.resumeSections,
      selectedTopic: payload.selectedTopic,
      userAnswer: payload.userAnswer,
    } satisfies InterviewDispatchPayload)
    return
  }
}
```

In the RESULT switch, modify the `RESEARCH_LEAD` case — STOP at `awaiting_title_selection` instead of dispatching RESUME_LEAD. Replace the existing case body (currently around lines 118-138):

```ts
case AgentRole.RESEARCH_LEAD: {
  const result = message.payload as ResearchResultPayload
  const session = this.sessions.get(result.sessionId)
  if (!session) return
  session.research = result
  session.stage = 'awaiting_title_selection'
  await this.store.save(result.sessionId, session, 'awaiting_title_selection')
  this.emitStatus(result.sessionId, 'awaiting_title_selection')
  this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
  break
}
```

- [ ] **Step 4: Run orchestrator tests**

Run: `bun test tests/agents/orchestrator.test.ts`
Expected: all tests pass.

- [ ] **Step 5: Run full agent suite to catch any cross-effects**

Run: `bun test tests/agents`
Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/agents/orchestrator.ts tests/agents/orchestrator.test.ts
git commit -m "feat(orchestrator): stop at awaiting_title_selection; route SelectTitles + simplified ApproveResume"
```

---

## Task 4: HTTP routes — replace /approve with /select-titles + /approve-resume

**Files:**
- Modify: `src/http/schemas.ts`
- Modify: `src/http/routes/sessions.ts`
- Modify: `tests/http/routes.test.ts` (if it tests session routes — see Step 5)

- [ ] **Step 1: Replace the schemas**

Edit `src/http/schemas.ts`. Replace the `approveBody` block (currently lines 17-22) with:

```ts
import type { IntakeDispatchPayload, SelectTitlesPayload, ApproveResumePayload, StartInterviewPayload } from '../agents/types'
```

(Update the existing import line to include `SelectTitlesPayload`.)

```ts
export const selectTitlesBody = z.object({
  targetTitles: z.array(z.string()).min(1),
})
export type SelectTitlesBody = z.infer<typeof selectTitlesBody>
const _selectTitlesCheck: Omit<SelectTitlesPayload, 'sessionId'> = {} as SelectTitlesBody
void _selectTitlesCheck

export const approveResumeBody = z.object({})
export type ApproveResumeBody = z.infer<typeof approveResumeBody>
const _approveResumeCheck: Omit<ApproveResumePayload, 'sessionId'> = {} as ApproveResumeBody
void _approveResumeCheck
```

(The old `approveBody` export is removed.)

- [ ] **Step 2: Replace the route**

Edit `src/http/routes/sessions.ts`.

Update the import line (currently line 4):
```ts
import { intakeBody, selectTitlesBody, approveResumeBody, interviewBody } from '../schemas'
```

Replace the existing `app.post('/sessions/:id/approve', ...)` block (currently lines 24-31) with two routes:

```ts
app.post('/sessions/:id/select-titles', async (c) => {
  const sessionId = c.req.param('id')
  const raw = await c.req.json().catch(() => null)
  const parsed = selectTitlesBody.safeParse(raw)
  if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
  agent.sendCommand(sessionId, { sessionId, ...parsed.data })
  return c.json({ ok: true })
})

app.post('/sessions/:id/approve-resume', async (c) => {
  const sessionId = c.req.param('id')
  const raw = await c.req.json().catch(() => ({}))
  const parsed = approveResumeBody.safeParse(raw ?? {})
  if (!parsed.success) return c.json({ error: 'invalid body', details: parsed.error.flatten() }, 400)
  agent.sendCommand(sessionId, { sessionId })
  return c.json({ ok: true })
})
```

- [ ] **Step 3: Add HTTP route tests**

Edit `tests/http/routes.test.ts`. Add this test inside the existing top-level `describe` block (look at where existing route tests are; add at the bottom):

```ts
test('POST /sessions/:id/select-titles enqueues SelectTitles to ORCHESTRATOR', async () => {
  const queue = new MessageQueue(TEST_DB)
  const anthropic = new Anthropic({ apiKey: 'test-key' })
  const httpApiAgent = new HttpApiAgent(queue, anthropic)
  const app = createApp({ httpApiAgent, token: TOKEN })

  const res = await app.request('/sessions/abc-123/select-titles', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetTitles: ['Security Engineer'] }),
  })
  expect(res.status).toBe(200)

  const msg = queue.receive(AgentRole.ORCHESTRATOR)
  expect(msg).not.toBeNull()
  const payload = msg!.payload as { sessionId: string; targetTitles: string[] }
  expect(payload.sessionId).toBe('abc-123')
  expect(payload.targetTitles).toEqual(['Security Engineer'])

  queue.close()
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
})

test('POST /sessions/:id/select-titles with empty array returns 400', async () => {
  const queue = new MessageQueue(TEST_DB)
  const anthropic = new Anthropic({ apiKey: 'test-key' })
  const httpApiAgent = new HttpApiAgent(queue, anthropic)
  const app = createApp({ httpApiAgent, token: TOKEN })

  const res = await app.request('/sessions/abc-123/select-titles', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetTitles: [] }),
  })
  expect(res.status).toBe(400)

  queue.close()
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
})

test('POST /sessions/:id/approve-resume enqueues ApproveResume to ORCHESTRATOR', async () => {
  const queue = new MessageQueue(TEST_DB)
  const anthropic = new Anthropic({ apiKey: 'test-key' })
  const httpApiAgent = new HttpApiAgent(queue, anthropic)
  const app = createApp({ httpApiAgent, token: TOKEN })

  const res = await app.request('/sessions/xyz-456/approve-resume', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({}),
  })
  expect(res.status).toBe(200)

  const msg = queue.receive(AgentRole.ORCHESTRATOR)
  expect(msg).not.toBeNull()
  const payload = msg!.payload as { sessionId: string }
  expect(payload.sessionId).toBe('xyz-456')

  queue.close()
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
})

test('POST /sessions/:id/approve (deprecated) returns 404', async () => {
  const queue = new MessageQueue(TEST_DB)
  const anthropic = new Anthropic({ apiKey: 'test-key' })
  const httpApiAgent = new HttpApiAgent(queue, anthropic)
  const app = createApp({ httpApiAgent, token: TOKEN })

  const res = await app.request('/sessions/abc-123/approve', {
    method: 'POST',
    headers: { Authorization: `Bearer ${TOKEN}`, 'content-type': 'application/json' },
    body: JSON.stringify({ targetTitles: ['x'] }),
  })
  expect(res.status).toBe(404)

  queue.close()
  if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
})
```

(If `tests/http/routes.test.ts` doesn't already import `MessageQueue`, `Anthropic`, `HttpApiAgent`, `createApp`, `AgentRole`, `existsSync`/`unlinkSync`, `TOKEN`, `TEST_DB` — add the imports/constants by mirroring how other test files in this project set them up. Check `tests/integration/full-flow.test.ts` for a working pattern.)

- [ ] **Step 4: Run HTTP tests**

Run: `bun test tests/http`
Expected: all pass (existing + 4 new).

- [ ] **Step 5: Commit**

```bash
git add src/http/schemas.ts src/http/routes/sessions.ts tests/http/routes.test.ts
git commit -m "feat(http): replace /approve with /select-titles + /approve-resume"
```

---

## Task 5: Frontend api wrappers

**Files:**
- Modify: `src/web/api.ts`

- [ ] **Step 1: Update `src/web/api.ts`**

Open `src/web/api.ts`. Replace the existing `approve` method on the `api` object with two methods:

```ts
selectTitles(sessionId: string, targetTitles: string[]) {
  return req<{ ok: true }>(`/sessions/${sessionId}/select-titles`, {
    method: 'POST',
    body: JSON.stringify({ targetTitles }),
  })
},
approveResume(sessionId: string) {
  return req<{ ok: true }>(`/sessions/${sessionId}/approve-resume`, {
    method: 'POST',
    body: JSON.stringify({}),
  })
},
```

(The old `approve(sessionId: string, targetTitles: string[])` method is REMOVED entirely. Other methods on the `api` object stay unchanged.)

- [ ] **Step 2: Verify typecheck**

Run: `bunx tsc -p tsconfig.web.json --noEmit`
Expected: errors in `src/web/routes/Resume.tsx` (it still calls `api.approve`). Those are intentional — Tasks 6 and 7 fix them. No errors in `src/web/api.ts` itself.

- [ ] **Step 3: Commit**

```bash
git add src/web/api.ts
git commit -m "feat(web/api): replace approve() with selectTitles() + approveResume()"
```

---

## Task 6: Frontend Research route — full rewrite

**Files:**
- Modify: `src/web/routes/Research.tsx`
- Create: `tests/web/research-route.test.tsx`

- [ ] **Step 1: Write the failing component test**

Create `tests/web/research-route.test.tsx`:

```tsx
import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Research } from '../../src/web/routes/Research'
import { useSessionStore } from '../../src/web/state/session'

vi.mock('../../src/web/api', () => ({
  api: {
    selectTitles: vi.fn(async () => ({ ok: true as const })),
  },
}))

import { api } from '../../src/web/api'

describe('Research route', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
    vi.clearAllMocks()
  })

  test('shows working-on-it placeholder when jobTitles undefined', () => {
    useSessionStore.setState({ sessionId: 's1', stage: 'researching' })
    render(<MemoryRouter><Research /></MemoryRouter>)
    expect(screen.getByText(/Working on it/)).toBeInTheDocument()
  })

  test('renders title rows with salary and openings when present', () => {
    useSessionStore.setState({
      sessionId: 's1',
      stage: 'awaiting_title_selection',
      jobTitles: [
        { title: 'Security Engineer', description: 'd', relevanceReason: 'r', avgSalaryUsd: 135000, openingsCount: 1247 },
      ],
      skillsByTitle: [{ jobTitle: 'Security Engineer', requiredSkills: ['AWS'], niceToHaveSkills: ['Go'] }],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    expect(screen.getByText('Security Engineer')).toBeInTheDocument()
    expect(screen.getByText(/~\$135k avg/)).toBeInTheDocument()
    expect(screen.getByText(/1,247 openings/)).toBeInTheDocument()
    expect(screen.getByText(/AWS/)).toBeInTheDocument()
  })

  test('renders fallbacks when stats are absent', () => {
    useSessionStore.setState({
      sessionId: 's1',
      stage: 'awaiting_title_selection',
      jobTitles: [{ title: 'A', description: 'd', relevanceReason: 'r' }],
      skillsByTitle: [],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    expect(screen.getByText(/Salary not reported/)).toBeInTheDocument()
  })

  test('approve button is disabled until at least one checkbox is checked', () => {
    useSessionStore.setState({
      sessionId: 's1',
      stage: 'awaiting_title_selection',
      jobTitles: [{ title: 'A', description: 'd', relevanceReason: 'r' }],
      skillsByTitle: [],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Approve titles/ })
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(button).toBeEnabled()
  })

  test('approve click POSTs selected titles', async () => {
    useSessionStore.setState({
      sessionId: 'sess-x',
      stage: 'awaiting_title_selection',
      jobTitles: [
        { title: 'A', description: 'd', relevanceReason: 'r' },
        { title: 'B', description: 'd', relevanceReason: 'r' },
      ],
      skillsByTitle: [],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: /Approve titles/ }))
    await waitFor(() => {
      expect(api.selectTitles).toHaveBeenCalledWith('sess-x', ['B'])
    })
  })
})
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `bun run test:web`
Expected: FAIL — current `Research.tsx` doesn't render checkboxes, doesn't render the "~$135k avg" text, etc.

- [ ] **Step 3: Replace `src/web/routes/Research.tsx`**

```tsx
import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useSessionStore } from '../state/session'

function formatSalary(avg?: number): string {
  if (!avg) return 'Salary not reported'
  return `~$${Math.round(avg / 1000)}k avg`
}

function formatOpenings(count?: number): string {
  if (count === undefined) return '—'
  return `${new Intl.NumberFormat('en-US').format(count)} openings`
}

export function Research() {
  const nav = useNavigate()
  const { sessionId, jobTitles, skillsByTitle, stage } = useSessionStore()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  if (!jobTitles) {
    return <div><h2>Research</h2><p>Working on it... (stage: {stage})</p></div>
  }

  function toggle(title: string) {
    const next = new Set(checked)
    if (next.has(title)) next.delete(title)
    else next.add(title)
    setChecked(next)
  }

  async function approve() {
    if (!sessionId || checked.size === 0) return
    setSubmitting(true)
    try {
      await api.selectTitles(sessionId, Array.from(checked))
      nav('/resume')
    } finally { setSubmitting(false) }
  }

  return (
    <div>
      <h2>Research</h2>
      {jobTitles.map((jt) => {
        const skills = skillsByTitle?.find(s => s.jobTitle === jt.title)
        return (
          <div key={jt.title} style={{ border: '1px solid #333', borderRadius: 6, padding: 12, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={checked.has(jt.title)}
                onChange={() => toggle(jt.title)}
                style={{ marginTop: 4 }}
              />
              <div style={{ flex: 1 }}>
                <strong>{jt.title}</strong>
                <div style={{ fontSize: 14, marginTop: 4 }}>{jt.description}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{jt.relevanceReason}</div>
                <div style={{ fontSize: 12, marginTop: 8 }}>
                  <span>{formatSalary(jt.avgSalaryUsd)}</span>
                  <span style={{ marginLeft: 12 }}>{formatOpenings(jt.openingsCount)}</span>
                </div>
                {skills ? (
                  <div style={{ fontSize: 12, marginTop: 8 }}>
                    <div>Required: {skills.requiredSkills.join(', ')}</div>
                    <div>Nice-to-have: {skills.niceToHaveSkills.join(', ')}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)' }}>Skills loading...</div>
                )}
              </div>
            </label>
          </div>
        )
      })}
      <button onClick={approve} disabled={submitting || checked.size === 0}>
        {submitting ? 'Sending...' : 'Approve titles & build resume'}
      </button>
    </div>
  )
}
```

- [ ] **Step 4: Run web tests**

Run: `bun run test:web`
Expected: all pass (existing + 5 new in research-route.test.tsx).

- [ ] **Step 5: Commit**

```bash
git add src/web/routes/Research.tsx tests/web/research-route.test.tsx
git commit -m "feat(web/research): per-title rows with salary, openings, checkboxes, approve button"
```

---

## Task 7: Frontend Resume route — strip target picker, add approve-resume button

**Files:**
- Modify: `src/web/routes/Resume.tsx`

- [ ] **Step 1: Replace `src/web/routes/Resume.tsx`**

```tsx
import { useState } from 'react'
import { api } from '../api'
import { useSessionStore } from '../state/session'
import { useNavigate } from 'react-router-dom'
import type { BulletItem, ResumeSection } from '../../agents/types'

function renderContent(content: string | BulletItem[]) {
  if (typeof content === 'string') return <p>{content}</p>
  return <ul>{content.map((b, i) => <li key={i}>{b.text}</li>)}</ul>
}

export function Resume() {
  const nav = useNavigate()
  const { sessionId, resumeSections } = useSessionStore()
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [localSections, setLocalSections] = useState<ResumeSection[] | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!resumeSections) return <p>No resume yet. (Still building.)</p>
  const sections = localSections ?? resumeSections

  async function approveResume() {
    if (!sessionId) return
    setSubmitting(true)
    try {
      await api.approveResume(sessionId)
      nav('/jobs')
    } finally {
      setSubmitting(false)
    }
  }

  if (mode === 'preview') {
    return (
      <div>
        <button onClick={() => setMode('edit')}>Edit</button>
        <div style={{ background: '#f5f2ec', color: '#222', padding: 40, fontFamily: 'Georgia, serif', maxWidth: 720, margin: '16px 0' }}>
          {sections.map((s, i) => (
            <section key={i}>
              <h3 style={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: 12, marginTop: 18 }}>{s.title}</h3>
              {renderContent(s.content)}
            </section>
          ))}
        </div>
        <button onClick={approveResume} disabled={submitting}>
          {submitting ? 'Sending...' : 'Approve resume → start job search'}
        </button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={() => setMode('preview')}>Preview</button>
      {sections.map((s, i) => (
        <div key={i} style={{ margin: '16px 0' }}>
          <input
            value={s.title}
            onChange={(e) => {
              const next = [...sections]
              next[i] = { ...next[i], title: e.target.value }
              setLocalSections(next)
            }}
            style={{ width: '100%', fontWeight: 'bold' }}
          />
          <textarea
            value={typeof s.content === 'string' ? s.content : s.content.map(b => '- ' + b.text).join('\n')}
            onChange={(e) => {
              const next = [...sections]
              next[i] = { ...next[i], content: e.target.value }
              setLocalSections(next)
            }}
            rows={5}
            style={{ width: '100%' }}
          />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Run web tests + typecheck**

Run: `bun run test:web && bunx tsc -p tsconfig.web.json --noEmit`
Expected: all tests pass and typecheck is clean.

- [ ] **Step 3: Commit**

```bash
git add src/web/routes/Resume.tsx
git commit -m "feat(web/resume): strip target picker; add approve-resume button"
```

---

## Task 8: Wire Adzuna creds in main.ts

**Files:**
- Modify: `src/main.ts`

- [ ] **Step 1: Update the `ResearchLead` instantiation**

Open `src/main.ts`. Find the line:

```ts
new ResearchLead(queue, anthropic, researchStore),
```

Replace with:

```ts
new ResearchLead(
  queue,
  anthropic,
  researchStore,
  process.env.ADZUNA_APP_ID ?? '',
  process.env.ADZUNA_APP_KEY ?? '',
),
```

(The default fetcher is `globalThis.fetch` — no need to pass it explicitly.)

- [ ] **Step 2: Smoke test boot**

Run: `bun run dev` in a terminal. Watch for "Server ready". Stop with Ctrl+C.
Expected: clean boot, no errors.

- [ ] **Step 3: Commit**

```bash
git add src/main.ts
git commit -m "feat(main): pass Adzuna creds into ResearchLead"
```

---

## Task 9: Update full-flow integration test

**Files:**
- Modify: `tests/integration/full-flow.test.ts`

- [ ] **Step 1: Inspect current assertions**

The current test asserts the orchestrator emits a `'intake'` STATUS after a POST `/sessions`. With B1+B2 the early flow is unchanged — only what happens AFTER research changes. The existing assertion stays valid. We don't need to extend it for this plan; the orchestrator unit tests cover the new branches end-to-end.

- [ ] **Step 2: Run the test**

Run: `bun test tests/integration/full-flow.test.ts`
Expected: PASS (no change required, but confirm the type changes from Task 1 didn't break anything).

- [ ] **Step 3: Commit only if changes were necessary**

If the test required no changes, skip this commit. If it did need changes (e.g., type imports broke):

```bash
git add tests/integration/full-flow.test.ts
git commit -m "test(integration): update full-flow for new stage flow"
```

---

## Task 10: Final full-suite run + manual smoke test

- [ ] **Step 1: Run everything**

Run: `bun test tests/agents tests/db tests/http tests/integration && bun run test:web`
Expected: all pass on a healthy Postgres.

- [ ] **Step 2: Manual smoke**

Run: `bun run build:web && bun run dev`. Open the printed URL with `?token=...`. Walk:

1. New intake form. Submit.
2. Wait for Research page to populate.
3. Confirm each title row shows description, relevance reason, salary line (`~$Xk avg` or "Salary not reported"), openings count or `—`, required + nice-to-have skills.
4. Check 1-2 titles. Click "Approve titles & build resume". Should navigate to /resume and show the resume preview as it builds.
5. On Resume: confirm there's no title-picker UI and only the "Approve resume → start job search" button.
6. Click that button. Should navigate to /jobs and trigger Adzuna search.

- [ ] **Step 3: No commit; this is a manual gate.**

---

## Self-Review

**Spec coverage:**
- "Move pick titles from Resume to Research" → Tasks 3 (orchestrator stops at awaiting_title_selection), 6 (Research has checkboxes + approve), 7 (Resume strips picker)
- "Each title shows avg salary + openings" → Task 2 (backend fetches), Task 6 (frontend renders)
- "Resume page is preview/edit/approve checkpoint" → Task 7
- "Additive at type/DB level" → Tasks 1 (additive enum + optional fields), no migration changes (JSONB blob accepts new shape automatically)
- "New stage `awaiting_title_selection`" → Task 1 (type), Task 3 (orchestrator transition)
- "Two endpoints, deprecated `/approve` removed" → Task 4
- "ResearchLead fetches stats inline (no new agent)" → Task 2
- "Failure: per-title Adzuna failure leaves stats undefined" → Task 2 (test included)
- "Failure: server restart mid-flow recovers via A1 store" → out of scope (A1 already handles this; the new `awaiting_title_selection` stage is just another value the JSONB store treats as opaque)
- All test items in spec → Tasks 2, 3, 4, 6 (no separate frontend store test added since the spec said "existing tests still pass" for store; the new shape is just additive optional fields)

**Placeholder scan:** none.

**Type consistency:**
- `JobTitleResult.avgSalaryUsd?: number` and `JobTitleResult.openingsCount?: number` — same names everywhere (Task 1 type, Task 2 fetcher writes them, Task 6 reads them).
- `SelectTitlesPayload { sessionId, targetTitles: string[] }` — matches Task 1, Task 3 (orchestrator), Task 4 (schema), Task 5 (api), Task 6 (caller).
- `ApproveResumePayload { sessionId }` only (no targetTitles) — Task 1, Task 3, Task 4, Task 5, Task 7.
- New stage `'awaiting_title_selection'` — Task 1 (events.ts), Task 3 (orchestrator transitions + tests).

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-19-research-page-targets-and-stats.md`. Two execution options:

1. **Subagent-Driven (recommended)** — fresh subagent per task, two-stage review between
2. **Inline Execution** — execute tasks in this session via executing-plans, batch with checkpoints

Which approach?
