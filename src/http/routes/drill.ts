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
} as const

// ─── Schemas ──────────────────────────────────────────────────────────────────

const startBodySchema = z.object({
  resume: z.string().min(200, 'Resume must be at least 200 characters'),
  jobDescription: z.string().min(100, 'Job description must be at least 100 characters'),
})

const answerBodySchema = z.object({
  text: z.string().min(1, 'Answer cannot be empty'),
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
    const raw = await c.req.json().catch(() => null)
    const parsed = startBodySchema.safeParse(raw)
    if (!parsed.success) {
      const issues = parsed.error.issues
      // Report the first failing field
      const firstIssue = issues[0]
      const field = firstIssue?.path[0] as string | undefined
      return c.json({ error: firstIssue?.message ?? 'Invalid body', field }, 400)
    }

    const { resume, jobDescription } = parsed.data
    const userAgent = c.req.header('User-Agent')

    try {
      const result = await startSession({ resume, jobDescription, userAgent }, deps)
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
  // Side effect: writes a reopen event before reading the session.
  // The snapshot's transcript last entry includes the current unanswered question
  // when status is in_progress (via getSession's natural transcript building).
  app.get('/drill/api/sessions/:id', async (c) => {
    const id = c.req.param('id')
    const userAgent = c.req.header('User-Agent') ?? ''

    // Check existence first — do NOT call recordReopen for bogus IDs
    const snapshot = await getSession(id, deps)

    // readSession returns [] for an unknown session_id → transcript will be empty
    // and turnsCompleted will be 0 with no start event. Detect via empty transcript
    // AND no verdict AND status in_progress (i.e. nothing was ever written).
    if (snapshot.transcript.length === 0 && snapshot.turnsCompleted === 0 && !snapshot.verdict) {
      return c.json({ error: ERROR_CODE.SESSION_NOT_FOUND }, 404)
    }

    // Session exists — record the reopen event
    await recordReopen(id, userAgent, deps)

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

    // If the session has no events at all, treat as not found
    if (snapshot.transcript.length === 0 && snapshot.turnsCompleted === 0 && !snapshot.verdict) {
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
