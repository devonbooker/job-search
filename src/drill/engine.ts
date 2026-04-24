import type Anthropic from '@anthropic-ai/sdk'
import {
  newSessionId,
  appendEvent,
  readSession,
  hashInput,
} from './storage'
import type { DrillEvent } from './storage'
import {
  DRILL_SYSTEM,
  VERDICT_SYSTEM,
  buildDrillUserMessage,
  buildCompanyAppendix,
} from './prompts'
import type { DrillTurnResponse } from './prompts'
import type { ModelAssessment, Verdict } from './types'

// ─── Constants ────────────────────────────────────────────────────────────────

// Model aliases point to the current latest in each family. Anthropic may
// retire aliases on notice (usually 6 months). If you see "model deprecated"
// errors: bump these to a dated version like 'claude-sonnet-4-6-20260101'.
// Don't forget to also update the tool-use tests if behavior shifts.
const SONNET_MODEL = 'claude-sonnet-4-6'
const OPUS_MODEL = 'claude-opus-4-7'
const MAX_TURNS = 12
const PREVIEW_LENGTH = 120

// Forcing Opus to emit the verdict via a tool call guarantees schema-valid JSON.
// Text-mode JSON output hit "Unterminated string" parse failures when long
// string fields (how_to_fix, model_answer, interviewer_verdict) contained
// em-dashes, embedded quotes, or multi-sentence prose.
const SUBMIT_VERDICT_TOOL = {
  name: 'submit_verdict',
  description: 'Submit the structured post-drill verdict for the candidate.',
  input_schema: {
    type: 'object' as const,
    properties: {
      target_role: { type: 'string' as const, description: 'Inferred from the JD, e.g. "Senior Cloud Security Engineer, Series-B startup"' },
      project_drilled: { type: 'string' as const, description: 'The primary resume project the drill focused on' },
      solid: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Array of plain strings describing demonstrated strengths. At least one entry required.',
      },
      weak: {
        type: 'array' as const,
        items: {
          type: 'object' as const,
          properties: {
            area: { type: 'string' as const },
            why: { type: 'string' as const },
            example_question: { type: 'string' as const, description: 'Verbatim from the transcript' },
            how_to_fix: { type: 'string' as const, description: '3-5 sentences: concepts, docs, practice reps' },
            model_answer: { type: 'string' as const, description: '2-4 sentences showing what a solid answer sounds like' },
          },
          required: ['area', 'why', 'example_question', 'how_to_fix', 'model_answer'],
        },
        description: 'Array of weak-area objects. At least one entry required.',
      },
      not_probed: {
        type: 'array' as const,
        items: { type: 'string' as const },
        description: 'Areas the drill did not get to cover this session. Use this INSTEAD OF inventing weak entries when the transcript was genuinely clean. Optional.',
      },
      interviewer_verdict: { type: 'string' as const, description: '2-3 sentences: phone screen / on-site / study gap in weeks' },
      overall: { type: 'string' as const, enum: ['Solid', 'Borderline', 'Needs work'] },
      overall_summary: { type: 'string' as const },
    },
    required: ['target_role', 'project_drilled', 'solid', 'weak', 'interviewer_verdict', 'overall', 'overall_summary'],
  },
}

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface EngineDeps {
  anthropic: Anthropic
  storageFilePath?: string  // for tests
  errorLogFilePath?: string // for tests (falls back to storageFilePath)
  now?: () => Date          // for deterministic test timestamps
  opusRetryDelayMs?: number // override Opus 5xx/529 retry backoff (default 3000; tests pass 0)
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class DrillTurnError extends Error {
  readonly stage = 'drill' as const
  readonly code: 'session_complete' | 'model_error' | 'parse_error'
  readonly sessionId: string
  readonly cause?: unknown

  constructor(message: string, init: { code: DrillTurnError['code']; sessionId: string; cause?: unknown }) {
    super(message)
    this.name = 'DrillTurnError'
    this.code = init.code
    this.sessionId = init.sessionId
    this.cause = init.cause
  }
}

export class VerdictGenerationError extends Error {
  readonly stage = 'verdict' as const
  readonly code: 'opus_error' | 'parse_error' | 'invalid_verdict'
  readonly sessionId: string
  readonly cause?: unknown

  constructor(message: string, init: { code: VerdictGenerationError['code']; sessionId: string; cause?: unknown }) {
    super(message)
    this.name = 'VerdictGenerationError'
    this.code = init.code
    this.sessionId = init.sessionId
    this.cause = init.cause
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StartSessionInput {
  resume: string
  jobDescription: string
  userAgent?: string
  project?: string
}

export interface StartSessionResult {
  sessionId: string
  firstQuestion: string
}

export interface SubmitAnswerResult {
  nextQuestion: string | null       // null means session is over
  completed: boolean                // true when early-termination or 12-turn cap
  turnsCompleted: number
}

export interface SessionSnapshot {
  sessionId: string
  status: 'in_progress' | 'complete'
  turnsCompleted: number
  transcript: Array<{ turn: number; question: string; answer?: string; assessment?: ModelAssessment }>
  verdict?: Verdict
  // True iff at least one event exists for this session_id. False for unknown
  // session IDs (the true "not found" signal). A session with only a start
  // event + error event still has exists=true — the session exists, it just
  // failed to produce a question. Routes use this to distinguish 404 from
  // "session exists but errored".
  exists: boolean
}

// ─── Internal helpers ─────────────────────────────────────────────────────────

function ts(deps: EngineDeps): string {
  return (deps.now ? deps.now() : new Date()).toISOString()
}

function storagePath(deps: EngineDeps): string | undefined {
  return deps.storageFilePath
}

function errorPath(deps: EngineDeps): string | undefined {
  return deps.errorLogFilePath ?? deps.storageFilePath
}

async function callModel(
  anthropic: Anthropic,
  model: string,
  system: string,
  userContent: string,
  maxTokens: number,
): Promise<string> {
  const response = await anthropic.messages.create({
    model,
    max_tokens: maxTokens,
    system,
    messages: [{ role: 'user', content: userContent }],
  })
  const block = response.content.find(b => b.type === 'text')
  return block?.text ?? ''
}

/**
 * Attempt to parse strict JSON from the model response.
 * Models sometimes wrap JSON in markdown code fences; strip those first.
 */
function parseModelJson<T>(text: string): T {
  // Strip optional markdown code block
  const stripped = text.replace(/^```(?:json)?\s*/i, '').replace(/\s*```\s*$/i, '').trim()
  return JSON.parse(stripped) as T
}

/**
 * Build the prior transcript array from stored JSONL events for use in
 * buildDrillUserMessage. Includes all question and answer events in order.
 */
function buildPriorTranscript(
  events: DrillEvent[],
): Array<{ role: 'question' | 'answer'; text: string; turn: number }> {
  const result: Array<{ role: 'question' | 'answer'; text: string; turn: number }> = []
  for (const event of events) {
    if (event.event === 'question') {
      result.push({ role: 'question', text: event.text, turn: event.turn })
    } else if (event.event === 'answer') {
      result.push({ role: 'answer', text: event.text, turn: event.turn })
    }
  }
  return result
}

/**
 * Build the full verdict context string from events (resume + JD + transcript).
 * User-paste fields are wrapped in XML tags and sanitized — VERDICT_SYSTEM instructs
 * Opus to treat that content as untrusted data, not instructions. See prompts.ts.
 */
function buildVerdictContext(events: DrillEvent[]): string {
  const startEvent = events.find(e => e.event === 'start')
  if (!startEvent || startEvent.event !== 'start') {
    throw new Error('No start event found in session')
  }

  const sanitize = (text: string): string =>
    text
      .replace(/<\/resume>/gi, '&lt;/resume&gt;')
      .replace(/<\/job_description>/gi, '&lt;/job_description&gt;')
      .replace(/<\/project>/gi, '&lt;/project&gt;')

  const resumeText = sanitize(startEvent.resume)
  const jdText = sanitize(startEvent.job_description)
  const projectText = startEvent.project ? sanitize(startEvent.project) : ''

  const questionEvents = events.filter(
    (e): e is Extract<DrillEvent, { event: 'question' }> => e.event === 'question'
  )
  const answerEvents = events.filter(
    (e): e is Extract<DrillEvent, { event: 'answer' }> => e.event === 'answer'
  )

  const parts: string[] = [
    `<resume>\n${resumeText}\n</resume>`,
    `<job_description>\n${jdText}\n</job_description>`,
  ]
  if (projectText) {
    parts.push(`<project>\n${projectText}\n</project>`)
  }
  parts.push('Transcript:')

  for (const q of questionEvents) {
    parts.push(`Q${q.turn}: ${q.text}`)
    const a = answerEvents.find(e => e.turn === q.turn)
    if (a) {
      parts.push(`A${a.turn} [${a.model_assessment}]: ${a.text}`)
    }
  }

  return parts.join('\n\n')
}

// ─── API ──────────────────────────────────────────────────────────────────────

/**
 * Start a new drill session. Writes start + question events, calls Sonnet
 * for the first question.
 */
export async function startSession(
  input: StartSessionInput,
  deps: EngineDeps,
): Promise<StartSessionResult> {
  const { resume, jobDescription, project } = input
  const sessionId = newSessionId()
  const now = ts(deps)
  const fp = storagePath(deps)
  const ep = errorPath(deps)

  // Write start event
  const startEventBase = {
    session_id: sessionId,
    event: 'start' as const,
    ts: now,
    resume_hash: hashInput(resume),
    jd_hash: hashInput(jobDescription),
    resume_preview: resume.slice(0, PREVIEW_LENGTH),
    jd_preview: jobDescription.slice(0, PREVIEW_LENGTH),
    resume,
    job_description: jobDescription,
  }
  await appendEvent(
    project && project.trim().length > 0
      ? { ...startEventBase, project }
      : startEventBase,
    fp,
  )

  // Build user message and call Sonnet for first question. The company
  // appendix injects role-specific interview knowledge into the system prompt
  // when the JD matches a company we have curated knowledge for.
  const userMessage = buildDrillUserMessage({
    resume,
    jobDescription,
    turn: 1,
    priorTranscript: [],
    project,
  })
  const drillSystemPrompt = DRILL_SYSTEM + buildCompanyAppendix(jobDescription)

  let rawResponse: string
  try {
    rawResponse = await callModel(deps.anthropic, SONNET_MODEL, drillSystemPrompt, userMessage, 1024)
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: `${cause instanceof Error ? cause.message : String(cause)} (stage=drill, session=${sessionId}, turn=1)`,
      },
      ep,
    )
    throw new DrillTurnError('Sonnet API call failed during startSession', { code: 'model_error', sessionId, cause })
  }

  let parsed: DrillTurnResponse
  try {
    parsed = parseModelJson<DrillTurnResponse>(rawResponse)
    if (typeof parsed.question !== 'string') throw new Error('Missing question field')
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: `Failed to parse Sonnet response (stage=drill, session=${sessionId}, turn=1): ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      ep,
    )
    throw new DrillTurnError('Failed to parse Sonnet response in startSession', { code: 'parse_error', sessionId, cause })
  }

  // Write question event
  await appendEvent(
    {
      session_id: sessionId,
      event: 'question',
      ts: ts(deps),
      turn: 1,
      text: parsed.question,
    },
    fp,
  )

  return { sessionId, firstQuestion: parsed.question }
}

// Per-session in-flight lock. Prevents concurrent submitAnswer / finishSession
// calls for the same session from racing the "read events → compute currentTurn
// → write answer + next question" sequence. Without this, a double-click across
// two tabs or a slow network retry can write duplicate turn events with the
// same turn number.
//
// Module-local map keyed by sessionId. Entry cleared in the finally handler so
// the map doesn't grow unbounded.
const inFlightSessionLocks = new Map<string, Promise<unknown>>()

async function withSessionLock<T>(sessionId: string, fn: () => Promise<T>): Promise<T> {
  const prev = inFlightSessionLocks.get(sessionId) ?? Promise.resolve()
  const task = prev.then(fn, fn)   // run regardless of predecessor outcome
  inFlightSessionLocks.set(sessionId, task)
  try {
    return await task
  } finally {
    // Only clear if this task is still the head of the chain. If another call
    // queued after us, it now owns the slot.
    if (inFlightSessionLocks.get(sessionId) === task) {
      inFlightSessionLocks.delete(sessionId)
    }
  }
}

/**
 * Submit an answer for the current turn. Calls Sonnet to rate the answer and
 * propose the next question. Enforces the 12-turn cap and early-terminate flag.
 *
 * DESIGN DECISION: submitAnswer does NOT automatically call finishSession on
 * completion. It returns `completed: true` and `nextQuestion: null`. The handler
 * (Task 4) is responsible for calling finishSession separately. This keeps the
 * engine functions single-responsibility and avoids finishSession being called
 * implicitly without the handler knowing.
 *
 * Concurrent calls for the same sessionId serialize through withSessionLock
 * to prevent duplicate turn events.
 */
export async function submitAnswer(
  input: { sessionId: string; answerText: string },
  deps: EngineDeps,
): Promise<SubmitAnswerResult> {
  return withSessionLock(input.sessionId, () => submitAnswerImpl(input, deps))
}

async function submitAnswerImpl(
  input: { sessionId: string; answerText: string },
  deps: EngineDeps,
): Promise<SubmitAnswerResult> {
  const { sessionId, answerText } = input
  const fp = storagePath(deps)
  const ep = errorPath(deps)

  const events = await readSession(sessionId, fp)

  // Guard: reject submissions to already-completed sessions
  if (events.some(e => e.event === 'finish')) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: `Cannot submit answer: session is complete (session=${sessionId})`,
      },
      ep,
    )
    throw new DrillTurnError('Cannot submit answer: session is complete', { code: 'session_complete', sessionId })
  }

  // Count existing answer events to determine which turn we're completing
  const existingAnswers = events.filter(e => e.event === 'answer')
  const currentTurn = existingAnswers.length + 1 // the turn number we're completing now

  // Get the start event to reconstruct resume/JD for the user message
  const startEvent = events.find(e => e.event === 'start')
  if (!startEvent || startEvent.event !== 'start') {
    throw new DrillTurnError('Session start event not found', { code: 'model_error', sessionId })
  }

  // Build prior transcript (all Q/A so far, excluding the current answer)
  const priorTranscript = buildPriorTranscript(events)

  // Append the current answer to the transcript so Sonnet rates it
  // and proposes the next question
  const fullTranscript = [
    ...priorTranscript,
    { role: 'answer' as const, text: answerText, turn: currentTurn },
  ]

  const userMessage = buildDrillUserMessage({
    resume: startEvent.resume,
    jobDescription: startEvent.job_description,
    turn: currentTurn + 1,
    priorTranscript: fullTranscript,
  })
  const drillSystemPrompt = DRILL_SYSTEM + buildCompanyAppendix(startEvent.job_description)

  let rawResponse: string
  try {
    rawResponse = await callModel(deps.anthropic, SONNET_MODEL, drillSystemPrompt, userMessage, 1024)
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: `${cause instanceof Error ? cause.message : String(cause)} (stage=drill, session=${sessionId}, turn=${currentTurn})`,
      },
      ep,
    )
    throw new DrillTurnError('Sonnet API call failed during submitAnswer', { code: 'model_error', sessionId, cause })
  }

  let parsed: DrillTurnResponse
  try {
    parsed = parseModelJson<DrillTurnResponse>(rawResponse)
    if (typeof parsed.model_assessment !== 'string') throw new Error('Missing model_assessment field')
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: `Failed to parse Sonnet response (stage=drill, session=${sessionId}, turn=${currentTurn}): ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      ep,
    )
    throw new DrillTurnError('Failed to parse Sonnet response in submitAnswer', { code: 'parse_error', sessionId, cause })
  }

  // Write answer event
  await appendEvent(
    {
      session_id: sessionId,
      event: 'answer',
      ts: ts(deps),
      turn: currentTurn,
      text: answerText,
      model_assessment: parsed.model_assessment as ModelAssessment,
    },
    fp,
  )

  // Determine if we should terminate: early_terminate flag OR 12-turn cap
  const shouldTerminate = parsed.early_terminate || currentTurn >= MAX_TURNS

  if (shouldTerminate) {
    return {
      nextQuestion: null,
      completed: true,
      turnsCompleted: currentTurn,
    }
  }

  // Write next question event
  await appendEvent(
    {
      session_id: sessionId,
      event: 'question',
      ts: ts(deps),
      turn: currentTurn + 1,
      text: parsed.question,
    },
    fp,
  )

  return {
    nextQuestion: parsed.question,
    completed: false,
    turnsCompleted: currentTurn,
  }
}

/**
 * Generate and persist the final verdict for a session. Idempotent - if the
 * session already has a finish event, returns the existing verdict without
 * calling Opus again.
 *
 * Throws VerdictGenerationError if Opus returns malformed JSON or a verdict
 * that violates the at-least-1-solid, at-least-1-weak constraint.
 */
export async function finishSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<Verdict> {
  return withSessionLock(sessionId, () => finishSessionImpl(sessionId, deps))
}

async function finishSessionImpl(
  sessionId: string,
  deps: EngineDeps,
): Promise<Verdict> {
  const fp = storagePath(deps)
  const ep = errorPath(deps)

  const events = await readSession(sessionId, fp)

  // Idempotency: if already finished, return existing verdict
  const existingFinish = events.find(e => e.event === 'finish')
  if (existingFinish && existingFinish.event === 'finish') {
    return existingFinish.verdict
  }

  const turnsCompleted = events.filter(e => e.event === 'answer').length
  const context = buildVerdictContext(events)

  // Retry-once policy for transient Opus 5xx / 529 (overloaded). Anthropic
  // 529s flash during peak hours; a single bad moment shouldn't blank Preston's
  // verdict. Retry after 3s on retryable statuses, throw immediately on 4xx.
  const isRetryableOpusError = (err: unknown): boolean => {
    if (typeof err !== 'object' || err === null) return false
    const status = (err as { status?: number }).status
    return typeof status === 'number' && (status >= 500 || status === 529)
  }
  const opusCall = () => deps.anthropic.messages.create({
    model: OPUS_MODEL,
    max_tokens: 8000,
    system: VERDICT_SYSTEM,
    messages: [{ role: 'user', content: context }],
    tools: [SUBMIT_VERDICT_TOOL],
    tool_choice: { type: 'tool', name: 'submit_verdict' },
  })

  let response: Awaited<ReturnType<typeof deps.anthropic.messages.create>>
  try {
    response = await opusCall()
  } catch (firstErr) {
    if (isRetryableOpusError(firstErr)) {
      await new Promise(resolve => setTimeout(resolve, deps.opusRetryDelayMs ?? 3000))
      try {
        response = await opusCall()
      } catch (retryErr) {
        await appendEvent(
          {
            session_id: sessionId,
            event: 'error',
            ts: ts(deps),
            stage: 'verdict',
            message: `${retryErr instanceof Error ? retryErr.message : String(retryErr)} (stage=verdict, session=${sessionId}, turn=${turnsCompleted}, retried=true)`,
          },
          ep,
        )
        throw new VerdictGenerationError('Opus API call failed during finishSession (after 1 retry)', { code: 'opus_error', sessionId, cause: retryErr })
      }
    } else {
      await appendEvent(
        {
          session_id: sessionId,
          event: 'error',
          ts: ts(deps),
          stage: 'verdict',
          message: `${firstErr instanceof Error ? firstErr.message : String(firstErr)} (stage=verdict, session=${sessionId}, turn=${turnsCompleted})`,
        },
        ep,
      )
      throw new VerdictGenerationError('Opus API call failed during finishSession', { code: 'opus_error', sessionId, cause: firstErr })
    }
  }

  const toolBlock = response.content.find(
    (b): b is Extract<typeof response.content[number], { type: 'tool_use' }> => b.type === 'tool_use',
  )
  if (!toolBlock || toolBlock.name !== 'submit_verdict') {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: `Opus did not return submit_verdict tool_use block (stage=verdict, session=${sessionId}, turn=${turnsCompleted})`,
      },
      ep,
    )
    throw new VerdictGenerationError('Opus did not return submit_verdict tool_use block', { code: 'parse_error', sessionId })
  }

  const verdict = toolBlock.input as Verdict

  // Validate the verdict constraints
  if (!Array.isArray(verdict.solid) || verdict.solid.length < 1) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: `Verdict validation failed: "solid" must have at least 1 entry (stage=verdict, session=${sessionId}, turn=${turnsCompleted})`,
      },
      ep,
    )
    throw new VerdictGenerationError(
      'Verdict validation failed: "solid" must have at least 1 entry',
      { code: 'invalid_verdict', sessionId },
    )
  }

  // weak CAN be empty if not_probed is non-empty (genuine pure-positive transcripts
  // no longer require Opus to invent a fake weak moment). But at least one of the
  // two "areas to improve" surfaces must be populated so the verdict isn't vapid.
  const hasWeak = Array.isArray(verdict.weak) && verdict.weak.length >= 1
  const hasNotProbed = Array.isArray(verdict.not_probed) && verdict.not_probed.length >= 1
  if (!Array.isArray(verdict.weak)) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: `Verdict validation failed: "weak" must be an array (stage=verdict, session=${sessionId}, turn=${turnsCompleted})`,
      },
      ep,
    )
    throw new VerdictGenerationError(
      'Verdict validation failed: "weak" must be an array',
      { code: 'invalid_verdict', sessionId },
    )
  }
  if (!hasWeak && !hasNotProbed) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: `Verdict validation failed: at least one of "weak" or "not_probed" must be non-empty (stage=verdict, session=${sessionId}, turn=${turnsCompleted})`,
      },
      ep,
    )
    throw new VerdictGenerationError(
      'Verdict validation failed: at least one of "weak" or "not_probed" must be non-empty',
      { code: 'invalid_verdict', sessionId },
    )
  }

  // Write finish event
  await appendEvent(
    {
      session_id: sessionId,
      event: 'finish',
      ts: ts(deps),
      turns_completed: turnsCompleted,
      verdict,
    },
    fp,
  )

  return verdict
}

/**
 * Reconstruct a session snapshot from JSONL events.
 */
export async function getSession(
  sessionId: string,
  deps: EngineDeps,
): Promise<SessionSnapshot> {
  const fp = storagePath(deps)
  const events = await readSession(sessionId, fp)

  const answerEvents = events.filter(
    (e): e is Extract<DrillEvent, { event: 'answer' }> => e.event === 'answer'
  )
  const questionEvents = events.filter(
    (e): e is Extract<DrillEvent, { event: 'question' }> => e.event === 'question'
  )
  const finishEvent = events.find(
    (e): e is Extract<DrillEvent, { event: 'finish' }> => e.event === 'finish'
  )

  const turnsCompleted = answerEvents.length
  const status: 'in_progress' | 'complete' = finishEvent ? 'complete' : 'in_progress'

  // Build transcript: collect all turn numbers from question events, pair with answers
  const allTurns = new Set(questionEvents.map(e => e.turn))
  const transcript = Array.from(allTurns)
    .sort((a, b) => a - b)
    .map(turn => {
      const q = questionEvents.find(e => e.turn === turn)
      const a = answerEvents.find(e => e.turn === turn)
      const entry: SessionSnapshot['transcript'][number] = {
        turn,
        question: q?.text ?? '',
      }
      if (a) {
        entry.answer = a.text
        entry.assessment = a.model_assessment
      }
      return entry
    })

  const snapshot: SessionSnapshot = {
    sessionId,
    status,
    turnsCompleted,
    transcript,
    exists: events.length > 0,
  }

  if (finishEvent) {
    snapshot.verdict = finishEvent.verdict
  }

  return snapshot
}

/**
 * Record a reopen event when a user revisits a session URL.
 */
export async function recordReopen(
  sessionId: string,
  userAgent: string,
  deps: EngineDeps,
): Promise<void> {
  const fp = storagePath(deps)
  await appendEvent(
    {
      session_id: sessionId,
      event: 'reopen',
      ts: ts(deps),
      user_agent: userAgent,
    },
    fp,
  )
}
