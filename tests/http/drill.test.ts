import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { Hono } from 'hono'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { mountDrillRoutes, type DrillRouteDeps } from '../../src/http/routes/drill'

// ─── Helpers ──────────────────────────────────────────────────────────────────

const RESUME = 'A'.repeat(200)
const JD = 'B'.repeat(100)

// Minimal valid Sonnet (drill) response
const SONNET_RESPONSE = JSON.stringify({
  question: 'Tell me about your experience with container security.',
  model_assessment: 'solid',
  early_terminate: false,
})

// Minimal valid Opus (verdict) response - emitted as tool_use input
const VERDICT_OBJECT = {
  target_role: 'Cloud Security Engineer',
  project_drilled: 'Container security project',
  solid: ['Container security knowledge'],
  weak: [
    {
      area: 'Public cloud breadth',
      why: 'Limited exposure outside AWS',
      example_question: 'How would you handle this in GCP?',
      how_to_fix: 'Study GCP IAM fundamentals.',
      model_answer: 'I would leverage GCP service accounts with least privilege.',
    },
  ],
  interviewer_verdict: 'Proceed to onsite with a 2-week study plan on GCP.',
  overall: 'Solid' as const,
  overall_summary: 'Strong AWS foundation, minor GCP gap.',
}

function verdictToolUse() {
  return {
    content: [{ type: 'tool_use', id: 'stub_tool_call', name: 'submit_verdict', input: VERDICT_OBJECT }],
  }
}

function makeApp(testFilePath: string, anthropicOverride?: { messages: { create: (opts?: unknown) => unknown } }) {
  const anthropic = (anthropicOverride ?? {
    messages: {
      create: async () => ({
        content: [{ type: 'text', text: SONNET_RESPONSE }],
      }),
    },
  }) as unknown as import('@anthropic-ai/sdk').default

  const deps: DrillRouteDeps = {
    anthropic,
    storageFilePath: testFilePath,
    errorLogFilePath: testFilePath,
  }

  const app = new Hono()
  mountDrillRoutes(app, deps)
  return app
}

// ─── POST /drill/api/start ────────────────────────────────────────────────────

describe('POST /drill/api/start', () => {
  let tmpDir: string
  let testFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drill-start-'))
    testFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('happy path: 200 with sessionId and firstQuestion', async () => {
    const app = makeApp(testFile)
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { sessionId: string; firstQuestion: string }
    expect(typeof body.sessionId).toBe('string')
    expect(body.sessionId.length).toBeGreaterThan(10)
    expect(typeof body.firstQuestion).toBe('string')
    expect(body.firstQuestion.length).toBeGreaterThan(0)
  })

  test('resume too short: 400 with field=resume', async () => {
    const app = makeApp(testFile)
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: 'short', jobDescription: JD }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { field: string }
    expect(body.field).toBe('resume')
  })

  test('JD too short: 400 with field=jobDescription', async () => {
    const app = makeApp(testFile)
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: 'short' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { field: string }
    expect(body.field).toBe('jobDescription')
  })

  test('happy path with project field: 200 with sessionId and firstQuestion', async () => {
    const app = makeApp(testFile)
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD, project: 'My WAF rules project in Go' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { sessionId: string; firstQuestion: string }
    expect(typeof body.sessionId).toBe('string')
    expect(body.sessionId.length).toBeGreaterThan(10)
  })

  test('project field is optional: 200 without project field', async () => {
    const app = makeApp(testFile)
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(res.status).toBe(200)
  })

  test('Sonnet throws: 502 with retry-friendly error', async () => {
    const brokenClient = {
      messages: {
        create: async () => { throw new Error('API overloaded') },
      },
    }
    const app = makeApp(testFile, brokenClient as unknown as { messages: { create: () => unknown } })
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string; message: string; sessionId: string }
    expect(body.error).toBe('drill_start_failed')
    expect(typeof body.message).toBe('string')
    expect(body.sessionId.length).toBeGreaterThan(10)
  })
})

// ─── GET /drill/api/sessions/:id ──────────────────────────────────────────────

describe('GET /drill/api/sessions/:id', () => {
  let tmpDir: string
  let testFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drill-get-'))
    testFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('existing session: 200 with snapshot and reopen event written', async () => {
    const app = makeApp(testFile)

    // Create a session first
    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    // GET the session
    const res = await app.request(`/drill/api/sessions/${sessionId}`, {
      headers: { 'User-Agent': 'test-browser/1.0' },
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      sessionId: string
      status: string
      turnsCompleted: number
      transcript: unknown[]
    }
    expect(body.sessionId).toBe(sessionId)
    expect(body.status).toBe('in_progress')
    expect(typeof body.turnsCompleted).toBe('number')
    expect(Array.isArray(body.transcript)).toBe(true)
    // The start event produces a question event, so transcript has at least 1 entry
    expect(body.transcript.length).toBeGreaterThan(0)
  })

  test('nonexistent session: 404', async () => {
    const app = makeApp(testFile)
    const res = await app.request('/drill/api/sessions/nonexistent-session-id-abc')
    expect(res.status).toBe(404)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('session_not_found')
  })
})

// ─── POST /drill/api/sessions/:id/answer ──────────────────────────────────────

describe('POST /drill/api/sessions/:id/answer', () => {
  let tmpDir: string
  let testFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drill-answer-'))
    testFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('happy path: 200 with nextQuestion', async () => {
    const app = makeApp(testFile)

    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    const res = await app.request(`/drill/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'I have 3 years of container security experience.' }),
    })
    expect(res.status).toBe(200)
    const body = await res.json() as {
      nextQuestion: string | null
      completed: boolean
      turnsCompleted: number
    }
    expect(body.turnsCompleted).toBe(1)
    expect(typeof body.completed).toBe('boolean')
  })

  test('text under 15 chars: 400 with field=text (substance guard against single-word spam)', async () => {
    const app = makeApp(testFile)

    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    const res = await app.request(`/drill/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'yes' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; field: string }
    expect(body.field).toBe('text')
    expect(body.error).toMatch(/15 characters/)
  })

  test('"I don\'t know" (15+ chars) is accepted as a valid weak answer', async () => {
    // Honest deflection is a legitimate answer the drill must accept.
    // Verifies the 15-char floor doesn't block genuine "I don't know" responses.
    const app = makeApp(testFile)

    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    const { sessionId } = await startRes.json() as { sessionId: string }

    const res = await app.request(`/drill/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: "I don't know the answer" }),
    })
    expect(res.status).toBe(200)
  })

  test('empty text: 400 with field=text', async () => {
    const app = makeApp(testFile)

    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    const res = await app.request(`/drill/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: '' }),
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; field: string }
    expect(body.error).toBeTruthy()
    expect(body.field).toBe('text')
  })

})

// ─── POST /drill/api/sessions/:id/answer — 409 guard (separate describe) ─────

describe('POST /drill/api/sessions/:id/answer - 409 on completed session', () => {
  let tmpDir: string
  let testFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drill-409-'))
    testFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('409 when session has finish event', async () => {
    // callCount: 1=start, 2/3/4=answers, 5=finishSession(Opus)
    let callCount = 0
    const client = {
      messages: {
        create: async () => {
          callCount++
          if (callCount <= 4) {
            return { content: [{ type: 'text', text: SONNET_RESPONSE }] }
          }
          return verdictToolUse()
        },
      },
    }

    const app = makeApp(testFile, client as unknown as { messages: { create: () => unknown } })

    // Start
    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    // Submit 3 answers to meet minimum
    for (let i = 0; i < 3; i++) {
      await app.request(`/drill/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `Answer ${i + 1} with enough detail.` }),
      })
    }

    // Finish session
    const finishRes = await app.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(finishRes.status).toBe(200)

    // Now try to submit another answer - should 409
    const res = await app.request(`/drill/api/sessions/${sessionId}/answer`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ text: 'Too late — session should already be complete.' }),
    })
    expect(res.status).toBe(409)
    const body = await res.json() as { error: string }
    expect(body.error).toBe('session_complete')
  })
})

// ─── POST /drill/api/sessions/:id/finish ─────────────────────────────────────

describe('POST /drill/api/sessions/:id/finish', () => {
  let tmpDir: string
  let testFile: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drill-finish-'))
    testFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  // Helper: run a session to N turns using the default Sonnet stub
  async function runSessionToTurns(app: Hono, n: number): Promise<string> {
    const startRes = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    for (let i = 0; i < n; i++) {
      await app.request(`/drill/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `Answer number ${i + 1} with enough detail.` }),
      })
    }
    return sessionId
  }

  test('under 3 turns: 400 with minimum_turns_not_met', async () => {
    const app = makeApp(testFile)
    const sessionId = await runSessionToTurns(app, 2)

    const res = await app.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(res.status).toBe(400)
    const body = await res.json() as { error: string; minimum: number; actual: number }
    expect(body.error).toBe('minimum_turns_not_met')
    expect(body.minimum).toBe(3)
    expect(body.actual).toBe(2)
  })

  test('at turn 3+: 200 with verdict', async () => {
    // callCount: 1=start, 2/3/4=answers (Sonnet), 5=finishSession (Opus)
    let callCount = 0
    const mixedClient = {
      messages: {
        create: async () => {
          callCount++
          if (callCount <= 4) {
            return { content: [{ type: 'text', text: SONNET_RESPONSE }] }
          }
          return verdictToolUse()
        },
      },
    }

    const app = makeApp(testFile, mixedClient as unknown as { messages: { create: () => unknown } })
    const sessionId = await runSessionToTurns(app, 3)

    const res = await app.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(res.status).toBe(200)
    const body = await res.json() as { verdict: { target_role: string } }
    expect(typeof body.verdict).toBe('object')
    expect(body.verdict.target_role).toBe('Cloud Security Engineer')
  })

  test('idempotent: calling finish twice returns same verdict', async () => {
    let callCount = 0
    const mixedClient = {
      messages: {
        create: async () => {
          callCount++
          if (callCount <= 4) {
            return { content: [{ type: 'text', text: SONNET_RESPONSE }] }
          }
          // Only first finishSession call hits Opus; second is idempotent (no API call)
          return verdictToolUse()
        },
      },
    }

    const app = makeApp(testFile, mixedClient as unknown as { messages: { create: () => unknown } })
    const sessionId = await runSessionToTurns(app, 3)

    const firstRes = await app.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(firstRes.status).toBe(200)
    const firstBody = await firstRes.json() as { verdict: { target_role: string } }

    const secondRes = await app.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(secondRes.status).toBe(200)
    const secondBody = await secondRes.json() as { verdict: { target_role: string } }
    expect(secondBody.verdict.target_role).toBe(firstBody.verdict.target_role)
  })

  test('Opus fails: 502 with transcript in body fallback', async () => {
    let callCount = 0
    const opusFailClient = {
      messages: {
        create: async () => {
          callCount++
          if (callCount <= 4) {
            return { content: [{ type: 'text', text: SONNET_RESPONSE }] }
          }
          throw new Error('Opus overloaded')
        },
      },
    }

    const app = makeApp(testFile, opusFailClient as unknown as { messages: { create: () => unknown } })
    const sessionId = await runSessionToTurns(app, 3)

    const res = await app.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(res.status).toBe(502)
    const body = await res.json() as { error: string; message: string; transcript: unknown[] }
    expect(body.error).toBe('verdict_failed')
    expect(typeof body.message).toBe('string')
    expect(Array.isArray(body.transcript)).toBe(true)
    expect(body.transcript.length).toBeGreaterThan(0)
  })
})
