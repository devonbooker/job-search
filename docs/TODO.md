# Phase 3 TODO

## Where we left off

Plan 1 (Foundation) and Plan 2 (Agents) are complete. 48 tests passing. Repo pushed to https://github.com/devonbooker/job-search.

Phase 3 is the HTTP server + frontend. Brainstorming was started but not finished.

---

## Brainstorming (not done)

The brainstorming skill is loaded. Pick up from here:

- [ ] Decide: want visual companion for UI mockups? (yes/no)
- [ ] Answer clarifying questions (one at a time):
  - What does the user flow look like? (wizard steps vs single page?)
  - Auth? (none for now, or simple session token?)
  - Resume display format? (raw sections or styled?)
  - Interview prep: one question at a time, or a full drill loop?
- [ ] Agree on approaches (Hono + SSE + React is the expected stack)
- [ ] Approve design sections
- [ ] Write + commit spec to docs/superpowers/specs/

## After brainstorming

- [ ] Write implementation plan (writing-plans skill)
- [ ] Execute plan (subagent-driven-development skill)

---

## Key technical context for Phase 3

**The gap to bridge:**
- Orchestrator currently does NOT send results back to HTTP_API
- Need to add a mechanism for the HTTP layer to receive agent events

**The blocking point:**
- Workflow pauses at `awaiting_resume_approval` - frontend must show resume sections and wait for user to pick target titles and approve

**Expected stack:**
- Hono (HTTP framework, already in Bun ecosystem)
- SSE (Server-Sent Events) for streaming agent progress to client
- React (frontend)
- No auth needed for v1

**HTTP API shape (rough):**
- `POST /sessions` - start workflow, returns sessionId
- `GET /sessions/:id/events` - SSE stream of agent events
- `POST /sessions/:id/approve` - send ApproveResumePayload (targetTitles)
- `POST /sessions/:id/interview` - send StartInterviewPayload (selectedTopic, userAnswer?)
