# Research Page: Title Selection + Salary/Openings Stats (B1+B2) — Design

**Date:** 2026-04-19
**Status:** Approved (pending user spec review)
**Sub-project of:** Phase 4 backlog (post-MVP browser-tested gaps)
**Builds on:** A1 persistent session state (`docs/superpowers/specs/2026-04-19-persistent-session-state-design.md`)

## Problem

Two coupled issues with the current Research → Resume flow:

1. **B1 — wrong place to pick titles.** The Resume page currently hosts the "pick target titles" checkboxes. By the time the user sees them there, the orchestrator has already auto-built a resume against ALL job titles. The user's selection only affects the downstream job search, not the resume itself. The Research page is where the title decision should land — it's where the data informs the choice.

2. **B2 — missing market context for picking titles.** Titles render with description and "relevance reason" but no salary or openings count. The user has no signal for which titles are realistic targets vs aspirational vs dead.

## Goals

- Move "pick target titles" from Resume to Research. Resume gets built only AFTER user selects titles, using only the selected ones.
- Each job title on the Research page shows average salary (USD) and openings count, sourced from Adzuna.
- Resume page remains as a preview/edit/approve checkpoint before the job search runs.
- All changes are additive at the type/database level so existing in-flight sessions still load (additive `OrchestratorStage` value, optional new fields on `JobTitleResult`).

## Non-goals

- Salary distribution histograms / percentiles. Just an average.
- Per-title geographic filtering. Use the project's default `us` Adzuna region.
- Live re-fetching of salary stats. They're computed once during research and persisted with the rest of the session.
- A new dedicated `TitleMarketStats` agent. The Adzuna stats fetch lives inline in `ResearchLead` (small enough to not warrant its own dispatch envelope).

## Architecture

### Backend: workflow stage change

`OrchestratorStage` (`src/agents/events.ts`) gains one new value:

```ts
export type OrchestratorStage =
  | 'idle'
  | 'intake'
  | 'researching'
  | 'awaiting_title_selection'  // NEW
  | 'building_resume'
  | 'awaiting_resume_approval'
  | 'searching_jobs'
  | 'interview_prep'
```

Stage-by-stage routing change in `Orchestrator.handleMessage`:

| Trigger | Old behavior | New behavior |
|---|---|---|
| `RESEARCH_LEAD` returns RESULT | Save research → set stage `building_resume` → dispatch RESUME_LEAD with all jobTitles as targets | Save research → set stage `awaiting_title_selection`. Stop. Do NOT dispatch RESUME_LEAD. |
| User POSTs `select-titles` (new) | (didn't exist) | Stage must be `awaiting_title_selection`. Save `targetTitles` to session. Set stage `building_resume`. Dispatch RESUME_LEAD with selected titles only. |
| User POSTs `approve-resume` (renamed) | Took `targetTitles`, dispatched JOB_SEARCH_LEAD | Empty body. Stage must be `awaiting_resume_approval`. Dispatch JOB_SEARCH_LEAD using `session.targetTitles`. |

`SessionState` gains `targetTitles?: string[]`.

### Backend: payloads + endpoints

`src/agents/types.ts`:
```ts
export interface SelectTitlesPayload {
  sessionId: string
  targetTitles: string[]
}

export interface ApproveResumePayload {
  sessionId: string
  // (no targetTitles - use stored)
}
```

`src/http/routes/sessions.ts` — replace existing `POST /sessions/:id/approve` with two routes:

- `POST /sessions/:id/select-titles` — body `{ targetTitles: string[] }`. Validates non-empty array. Forwards `SelectTitlesPayload` to ORCHESTRATOR.
- `POST /sessions/:id/approve-resume` — body `{}`. Forwards `ApproveResumePayload` to ORCHESTRATOR.

The deprecated `/approve` route is removed (this is a single-user dev project; no clients other than our own frontend).

### Backend: salary + openings stats

`JobTitleResult` (`src/agents/types.ts`) gains two optional fields:

```ts
export interface JobTitleResult {
  title: string
  description: string
  relevanceReason: string
  avgSalaryUsd?: number       // average of (salary_min+salary_max)/2 over jobs that report salary
  openingsCount?: number      // Adzuna's top-level `count` field
}
```

In `ResearchLead.handleMessage`, after `JobTitleResearch` returns and BEFORE dispatching `SkillsMarketResearch`:

```ts
session.jobTitles = await fetchTitleStats(result.jobTitles, this.adzunaAppId, this.adzunaAppKey, this.fetcher)
```

`fetchTitleStats(titles, appId, appKey, fetcher)`: `Promise.all` over titles. For each:
1. GET `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=...&app_key=...&what=<encoded title>&results_per_page=10`
2. On non-2xx or fetch error: log a warning, return the title unchanged (no stats fields).
3. On success: `openingsCount = data.count`. `avgSalaryUsd = mean of (j.salary_min + j.salary_max)/2 across jobs where both are present`. If no jobs report salary, leave `avgSalaryUsd` undefined.

ResearchLead constructor gains `adzunaAppId`, `adzunaAppKey`, `fetcher` parameters with defaults pulled from env (mirroring how `JobTitleResearch` already does it).

### Frontend: Research page

Replace `src/web/routes/Research.tsx` content. Components conceptually:

- `<TitleRow>` per `JobTitleResult`: checkbox, title, description, relevance reason, salary line (`~$135k avg` or `Salary not reported`), openings line (`1,247 openings` or `—`), per-title required-skills + nice-to-have-skills (looked up from `skillsByTitle` by `jt.title`).
- Bottom action bar: "Approve titles & build resume" button. Disabled until at least one checkbox selected. On click: `await api.selectTitles(sessionId, Array.from(checked))` then `nav('/resume')`.

Loading states:
- `!jobTitles` → "Working on it... (stage: {stage})" (existing)
- `jobTitles && !skillsByTitle` → render titles with stats + skills section showing "Skills loading..." inline

Salary formatting: `Math.round(avgSalaryUsd / 1000)` to nearest thousand, prefixed with `~$` and suffixed with `k avg`. e.g. `~$135k avg`. `openingsCount` formatted with `Intl.NumberFormat('en-US')`.

### Frontend: Resume page

`src/web/routes/Resume.tsx`:
- DELETE the `<h3>Pick target titles</h3>` block, the `targets` Set state, the per-title checkbox renderer.
- DELETE the existing `approve` function that takes `Array.from(targets)`.
- ADD a single `approveResume` function: `await api.approveResume(sessionId); nav('/jobs')`.
- The preview/edit toggle stays unchanged.
- "Approve resume → start job search" button at the bottom of the preview pane.

### Frontend: API wrappers

`src/web/api.ts`:
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
// existing `approve(sessionId, targetTitles)` removed
```

### Frontend: Layout gating

No code changes — current rules already produce the right behavior:

- `awaiting_title_selection` stage: `jobTitles` is set so Research is unlocked. `resumeSections` is undefined so Resume stays locked.
- After user selects titles, RESUME_LEAD builds and emits result → `resumeSections` populates → Resume unlocks.

### Frontend: store

No store schema change required. The shape of `JobTitleResult` is wider but the store passes payloads through verbatim.

## Tests

### Backend

`tests/agents/orchestrator.test.ts`:
- Update existing test that asserted "after RESEARCH_LEAD result, dispatches RESUME_LEAD" → now asserts "after RESEARCH_LEAD result, stage transitions to `awaiting_title_selection` and NO RESUME_LEAD dispatch."
- New test: `routes select-titles to RESUME_LEAD with only the selected titles` — seed session at `awaiting_title_selection` with research + 3 jobTitles, send SelectTitles with 2 of 3 titles, assert RESUME_LEAD dispatched with `targetTitles` matching the 2 selected.
- New test: `routes approve-resume to JOB_SEARCH_LEAD using stored targetTitles` — seed session at `awaiting_resume_approval` with `targetTitles: ['A','B']`, send ApproveResume, assert JOB_SEARCH_LEAD dispatched with those titles.
- New test: `select-titles in wrong stage emits Unknown-stage error or no-op` — seed at `intake`, send SelectTitles, assert no RESUME_LEAD dispatch.

`tests/agents/research/research-lead.test.ts`:
- New test: `attaches Adzuna stats to each title before dispatching SkillsMarketResearch` — mock fetcher returning Adzuna-shaped JSON with `count` and salary-bearing jobs; dispatch research; receive SkillsMarketResearch dispatch and inspect that the inflight session's jobTitles have `avgSalaryUsd` and `openingsCount` populated.
- New test: `gracefully degrades when Adzuna call for a title returns 422` — mock fetcher returning 422 for one title and 200 for others; assert that title's `avgSalaryUsd`/`openingsCount` are undefined and others are populated; flow continues.

`tests/http/sessions.test.ts` (or wherever session route tests live):
- POST `/sessions/:id/select-titles` with valid body returns 200 and enqueues SelectTitles to ORCHESTRATOR.
- POST `/sessions/:id/select-titles` with empty array returns 400.
- POST `/sessions/:id/approve-resume` with empty body returns 200 and enqueues ApproveResume to ORCHESTRATOR.
- POST `/sessions/:id/approve` (deprecated) returns 404.

### Frontend

`tests/web/research-route.test.tsx` (new):
- Renders title rows with salary + openings when present.
- Renders "Salary not reported" when avgSalaryUsd undefined.
- Approve button is disabled until at least one checkbox is checked.
- Approve click POSTs to `/sessions/:id/select-titles` with the checked titles.

`tests/web/session-store.test.ts`: existing tests still pass (the new optional fields don't break existing reducer behavior).

### Integration

`tests/integration/full-flow.test.ts` (existing): update the assertion path so it stops at `awaiting_title_selection` instead of `building_resume`. Add a follow-up assertion that posting SelectTitles advances to `building_resume`.

## Files

**New:**
- `tests/web/research-route.test.tsx` — frontend Research route component test

**Modified:**
- `src/agents/types.ts` — add `avgSalaryUsd`/`openingsCount` to `JobTitleResult`; add `SelectTitlesPayload`; simplify `ApproveResumePayload`
- `src/agents/events.ts` — add `'awaiting_title_selection'` to `OrchestratorStage`
- `src/agents/orchestrator.ts` — new branch for SelectTitles, new branch for ApproveResume (sessionId-only), don't auto-dispatch RESUME_LEAD on research result
- `src/agents/research/research-lead.ts` — inline `fetchTitleStats` after job-title-research returns; constructor gains adzuna creds + fetcher
- `src/main.ts` — pass adzuna env into ResearchLead constructor
- `src/http/routes/sessions.ts` — replace `/approve` with `/select-titles` + `/approve-resume`
- `src/http/schemas.ts` — `selectTitlesBody`, `approveResumeBody` (replace `approveBody`)
- `src/web/routes/Research.tsx` — full rewrite with title rows + checkboxes + approve button
- `src/web/routes/Resume.tsx` — strip target-picking UI, add approve-resume button
- `src/web/api.ts` — `selectTitles` + `approveResume` (replace `approve`)
- `tests/agents/orchestrator.test.ts` — update + add tests
- `tests/agents/research/research-lead.test.ts` — add stats tests
- `tests/http/sessions.test.ts` (or equivalent) — update tests for new endpoints
- `tests/integration/full-flow.test.ts` — update flow assertions

## Failure modes

- **Adzuna unreachable during research:** stats fields stay undefined; UI shows "Salary not reported" / "—". Workflow continues normally. Logged at WARN.
- **User selects titles, server restarts before resume builds:** A1 persistence saves `targetTitles` to DB on the SelectTitles transition. New orchestrator instance loads the session, sees stage `building_resume` (or `awaiting_title_selection` if save happened post-stage-update), continues from there. (If the SkillsMarketResearch / ResumeBuilder LLM call is in flight at restart time, the message is in the queue and gets re-delivered.)
- **User clicks "Approve titles" twice:** the frontend's existing in-flight ref pattern from the Interview fix carries over to Research's button.
- **User browses to /resume directly during awaiting_title_selection:** GatedLink locks the link, so this requires URL manipulation. If they do it anyway, Resume route renders "No resume yet. (Still building.)" — same as today's race.

## Self-Review

- **Placeholder scan:** none.
- **Internal consistency:** the `select-titles` endpoint expects stage `awaiting_title_selection`; `approve-resume` expects stage `awaiting_resume_approval`. Orchestrator validates current stage before routing each. Tests cover wrong-stage cases.
- **Scope check:** single coherent feature (the salary/openings collection is the data input that justifies moving the picker). Bounded.
- **Ambiguity check:** "average salary" is defined precisely (mean of `(salary_min + salary_max) / 2` over jobs that report both). Empty-salary case → undefined, not zero.
- **Type consistency:** `targetTitles: string[]` everywhere. `avgSalaryUsd?` and `openingsCount?` consistently optional. Stage value `'awaiting_title_selection'` matches across types, orchestrator, and tests.
