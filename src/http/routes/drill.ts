import { Hono } from 'hono'
import { z } from 'zod'
import type Anthropic from '@anthropic-ai/sdk'
import {
  startSession,
  submitAnswer,
  finishSession,
  getSession,
  recordReopen,
  DrillTurnError,
  VerdictGenerationError,
} from '../../drill/engine'

// ─── Error codes ──────────────────────────────────────────────────────────────

const ERROR_CODE = {
  VALIDATION: 'validation_error',
  SESSION_NOT_FOUND: 'session_not_found',
  SESSION_COMPLETE: 'session_complete',
  MINIMUM_TURNS_NOT_MET: 'minimum_turns_not_met',
  DRILL_START_FAILED: 'drill_start_failed',
  DRILL_TURN_FAILED: 'drill_turn_failed',
  VERDICT_FAILED: 'verdict_failed',
  INVALID_START_TOKEN: 'invalid_start_token',
} as const

// Shared-secret gate on POST /drill/api/start. Prevents random internet traffic
// from burning Opus/Sonnet budget against a public URL. When DRILL_START_TOKEN
// is unset (dev default), the gate is disabled — keeps local dev ergonomic.
//
// Callers pass the token via either `?k=<token>` query param or
// `X-Drill-Token: <token>` header. The DM link Devon sends to Preston embeds
// `?k=<token>` so he doesn't have to do anything.
function isStartTokenValid(supplied: string, expected: string): boolean {
  if (!supplied || supplied.length !== expected.length) return false
  let diff = 0
  for (let i = 0; i < supplied.length; i++) diff |= supplied.charCodeAt(i) ^ expected.charCodeAt(i)
  return diff === 0
}

// ─── Schemas ──────────────────────────────────────────────────────────────────

const startBodySchema = z.object({
  resume: z.string().min(200, 'Resume must be at least 200 characters'),
  jobDescription: z.string().min(100, 'Job description must be at least 100 characters'),
  project: z.string().optional().default(''),
})

// Min 15 chars allows "I don't know" (honest deflection is a valid weak answer)
// but blocks "yes"/"no"/"AWS" spam that Sonnet might rate solid and trigger a
// garbage-verdict early-termination at turn 6.
const answerBodySchema = z.object({
  text: z.string().trim().min(15, 'Please type at least 15 characters. Real interview answers need specifics — even "I don\'t know the details because X" is better than one word.'),
})

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface DrillRouteDeps {
  anthropic: Anthropic
  storageFilePath?: string
  errorLogFilePath?: string
  now?: () => Date
}

// ─── Mount ────────────────────────────────────────────────────────────────────

export function mountDrillRoutes(app: Hono, deps: DrillRouteDeps): void {
  // POST /drill/api/start
  // Body: { resume: string, jobDescription: string }
  // Returns: { sessionId, firstQuestion }
  app.post('/drill/api/start', async (c) => {
    const expectedToken = process.env.DRILL_START_TOKEN
    if (expectedToken) {
      const supplied = c.req.query('k') ?? c.req.header('X-Drill-Token') ?? ''
      if (!isStartTokenValid(supplied, expectedToken)) {
        return c.json(
          { error: ERROR_CODE.INVALID_START_TOKEN, message: 'Drill is invite-only. Use the link Devon sent you.' },
          403,
        )
      }
    }

    const raw = await c.req.json().catch(() => null)
    const parsed = startBodySchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
      // Report the first failing field
      const firstIssue = issues[0]
      const field = firstIssue?.path[0] as string | undefined
      return c.json({ error: firstIssue?.message ?? 'Invalid body', field }, 400)
    }

    const { resume, jobDescription, project } = parsed.data
    const userAgent = c.req.header('User-Agent')

    try {
      const result = await startSession({ resume, jobDescription, userAgent, project }, deps)
      return c.json({ sessionId: result.sessionId, firstQuestion: result.firstQuestion }, 200)
    } catch (err) {
      if (err instanceof DrillTurnError) {
        return c.json(
          {
            error: ERROR_CODE.DRILL_START_FAILED,
            message: 'Model hiccuped — please retry',
            sessionId: err.sessionId,
          },
          502,
        )
      }
      throw err
    }
  })

  // GET /drill/api/sessions/:id
  // Returns: SessionSnapshot (200) or { error: "session_not_found" } (404)
  //
  // SECURITY NOTE: session URL currently doubles as the credential — anyone
  // with /drill/<sessionId> can read the full resume + JD + transcript.
  // Mitigation today: (1) ULIDs have 80 bits of random entropy, guessing is
  // infeasible; (2) DRILL_START_TOKEN gates /start so random crawlers can't
  // create new sessions; (3) noindex headers below prevent search-engine
  // indexing of leaked URLs. Proper fix (post-Preston): separate read_token
  // from session_id, store mapping in JSONL, rotate readable tokens on
  // revocation.
  app.get('/drill/api/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const userAgent = c.req.header('User-Agent') ?? ''

    const snapshot = await getSession(id, deps)

    // True not-found signal: zero events on disk for this session_id.
    // A session with only start+error events (orphan: first Sonnet call failed)
    // has exists=true, so reopen still returns 200 + the (empty) snapshot.
    if (!snapshot.exists) {
      return c.json({ error: ERROR_CODE.SESSION_NOT_FOUND }, 404)
    }

    // Metric hygiene: only log reopen for in-progress sessions. Verdict-page
    // refreshes are high-frequency but meaningless for the behavioral signal.
    if (snapshot.status === 'in_progress') {
      await recordReopen(id, userAgent, deps)
    }

    // Prevent search-engine indexing if a session URL ever leaks (Twitter paste,
    // Slack share, etc.). Cache-Control: no-store avoids intermediary caching.
    c.header('X-Robots-Tag', 'noindex, nofollow, noarchive')
    c.header('Cache-Control', 'no-store, private')
    return c.json(snapshot, 200)
  })

  // POST /drill/api/sessions/:id/answer
  // Body: { text: string }
  // Returns: SubmitAnswerResult (200), 400 on empty text, 409 on completed session,
  //          502 on model error.
  app.post('/drill/api/sessions/:id/answer', async (c) => {
    const id = c.req.param('id')
    const raw = await c.req.json().catch(() => null)
    const parsed = answerBodySchema.safeParse(raw)
    if (!parsed.success) {
      const firstIssue = parsed.error.issues[0]
      const field = firstIssue?.path[0] as string | undefined
      return c.json({ error: firstIssue?.message ?? 'Invalid body', field }, 400)
    }

    const { text } = parsed.data

    try {
      const result = await submitAnswer({ sessionId: id, answerText: text }, deps)
      return c.json(result, 200)
    } catch (err) {
      if (err instanceof DrillTurnError) {
        // Distinguish "session already complete" (409) from model errors (502)
        if (err.code === 'session_complete') {
          return c.json({ error: ERROR_CODE.SESSION_COMPLETE }, 409)
        }
        return c.json(
          {
            error: ERROR_CODE.DRILL_TURN_FAILED,
            message: 'Model hiccuped — please retry',
            sessionId: err.sessionId,
          },
          502,
        )
      }
      throw err
    }
  })

  // POST /drill/api/sessions/:id/finish
  // No body required.
  // Enforces 3-turn minimum. Returns { verdict } (200) or error responses.
  app.post('/drill/api/sessions/:id/finish', async (c) => {
    const id = c.req.param('id')

    // Read session to check turn count and completion status
    const snapshot = await getSession(id, deps)

    // True not-found signal: zero events on disk for this session_id.
    if (!snapshot.exists) {
      return c.json({ error: ERROR_CODE.SESSION_NOT_FOUND }, 404)
    }

    // Enforce 3-turn minimum (skip if already complete — finishSession is idempotent)
    if (snapshot.status !== 'complete' && snapshot.turnsCompleted < 3) {
      return c.json(
        {
          error: ERROR_CODE.MINIMUM_TURNS_NOT_MET,
          minimum: 3,
          actual: snapshot.turnsCompleted,
        },
        400,
      )
    }

    try {
      const verdict = await finishSession(id, deps)
      return c.json({ verdict }, 200)
    } catch (err) {
      if (err instanceof VerdictGenerationError) {
        // Return transcript as fallback per design doc "Verdict unavailable" pattern
        const fallbackSnapshot = await getSession(id, deps)
        return c.json(
          {
            error: ERROR_CODE.VERDICT_FAILED,
            message: 'Verdict unavailable — here\'s your transcript',
            transcript: fallbackSnapshot.transcript,
          },
          502,
        )
      }
      throw err
    }
  })
}
