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
} from './prompts'
import type { ModelAssessment, DrillTurnResponse, Verdict } from './prompts'

// ─── Constants ────────────────────────────────────────────────────────────────

const SONNET_MODEL = 'claude-sonnet-4-6'
const OPUS_MODEL = 'claude-opus-4-7'
const MAX_TURNS = 12
const PREVIEW_LENGTH = 120

// ─── Deps ─────────────────────────────────────────────────────────────────────

export interface EngineDeps {
  anthropic: Anthropic
  storageFilePath?: string  // for tests
  errorLogFilePath?: string // for tests (falls back to storageFilePath)
  now?: () => Date          // for deterministic test timestamps
}

// ─── Errors ───────────────────────────────────────────────────────────────────

export class DrillTurnError extends Error {
  readonly stage = 'drill' as const
  readonly sessionId: string
  readonly cause?: unknown

  constructor(message: string, sessionId: string, cause?: unknown) {
    super(message)
    this.name = 'DrillTurnError'
    this.sessionId = sessionId
    this.cause = cause
  }
}

export class VerdictGenerationError extends Error {
  readonly stage = 'verdict' as const
  readonly sessionId: string
  readonly cause?: unknown

  constructor(message: string, sessionId: string, cause?: unknown) {
    super(message)
    this.name = 'VerdictGenerationError'
    this.sessionId = sessionId
    this.cause = cause
  }
}

// ─── Public types ─────────────────────────────────────────────────────────────

export interface StartSessionInput {
  resume: string
  jobDescription: string
  userAgent?: string
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
 */
function buildVerdictContext(events: DrillEvent[]): string {
  const startEvent = events.find(e => e.event === 'start')
  if (!startEvent || startEvent.event !== 'start') {
    throw new Error('No start event found in session')
  }

  // We store previews, not full text. The start event has previews but not full text.
  // For the verdict, we'll use the previews as the best available data.
  // NOTE: If the handler stores full resume/JD separately, it would be passed in.
  // For now, use the previews - this is a known limitation documented below.
  // DESIGN DECISION: The start event only stores resume_preview (120 chars) + hash,
  // not full text. The verdict context will use previews. If full text is needed,
  // the caller should pass it or the start event format would need to change.
  // For now, previews serve as the resume/JD context for Opus.
  const resumeText = startEvent.resume_preview
  const jdText = startEvent.jd_preview

  const questionEvents = events.filter(
    (e): e is Extract<DrillEvent, { event: 'question' }> => e.event === 'question'
  )
  const answerEvents = events.filter(
    (e): e is Extract<DrillEvent, { event: 'answer' }> => e.event === 'answer'
  )

  const parts: string[] = [
    `Resume:\n${resumeText}`,
    `Job Description:\n${jdText}`,
    'Transcript:',
  ]

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
  const { resume, jobDescription } = input
  const sessionId = newSessionId()
  const now = ts(deps)
  const fp = storagePath(deps)
  const ep = errorPath(deps)

  // Write start event
  await appendEvent(
    {
      session_id: sessionId,
      event: 'start',
      ts: now,
      resume_hash: hashInput(resume),
      jd_hash: hashInput(jobDescription),
      resume_preview: resume.slice(0, PREVIEW_LENGTH),
      jd_preview: jobDescription.slice(0, PREVIEW_LENGTH),
    },
    fp,
  )

  // Build user message and call Sonnet for first question
  const userMessage = buildDrillUserMessage({
    resume,
    jobDescription,
    turn: 1,
    priorTranscript: [],
  })

  let rawResponse: string
  try {
    rawResponse = await callModel(deps.anthropic, SONNET_MODEL, DRILL_SYSTEM, userMessage, 1024)
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: cause instanceof Error ? cause.message : String(cause),
      },
      ep,
    )
    throw new DrillTurnError('Sonnet API call failed during startSession', sessionId, cause)
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
        message: `Failed to parse Sonnet response: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      ep,
    )
    throw new DrillTurnError('Failed to parse Sonnet response in startSession', sessionId, cause)
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

/**
 * Submit an answer for the current turn. Calls Sonnet to rate the answer and
 * propose the next question. Enforces the 12-turn cap and early-terminate flag.
 *
 * DESIGN DECISION: submitAnswer does NOT automatically call finishSession on
 * completion. It returns `completed: true` and `nextQuestion: null`. The handler
 * (Task 4) is responsible for calling finishSession separately. This keeps the
 * engine functions single-responsibility and avoids finishSession being called
 * implicitly without the handler knowing.
 */
export async function submitAnswer(
  input: { sessionId: string; answerText: string },
  deps: EngineDeps,
): Promise<SubmitAnswerResult> {
  const { sessionId, answerText } = input
  const fp = storagePath(deps)
  const ep = errorPath(deps)

  const events = await readSession(sessionId, fp)

  // Count existing answer events to determine which turn we're completing
  const existingAnswers = events.filter(e => e.event === 'answer')
  const currentTurn = existingAnswers.length + 1 // the turn number we're completing now

  // Get the start event to reconstruct resume/JD for the user message
  const startEvent = events.find(e => e.event === 'start')
  if (!startEvent || startEvent.event !== 'start') {
    throw new DrillTurnError('Session start event not found', sessionId)
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
    resume: startEvent.resume_preview,
    jobDescription: startEvent.jd_preview,
    turn: currentTurn + 1,
    priorTranscript: fullTranscript,
  })

  let rawResponse: string
  try {
    rawResponse = await callModel(deps.anthropic, SONNET_MODEL, DRILL_SYSTEM, userMessage, 1024)
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'drill',
        message: cause instanceof Error ? cause.message : String(cause),
      },
      ep,
    )
    throw new DrillTurnError('Sonnet API call failed during submitAnswer', sessionId, cause)
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
        message: `Failed to parse Sonnet response: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      ep,
    )
    throw new DrillTurnError('Failed to parse Sonnet response in submitAnswer', sessionId, cause)
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
  const fp = storagePath(deps)
  const ep = errorPath(deps)

  const events = await readSession(sessionId, fp)

  // Idempotency: if already finished, return existing verdict
  const existingFinish = events.find(e => e.event === 'finish')
  if (existingFinish && existingFinish.event === 'finish') {
    return existingFinish.verdict as Verdict
  }

  const turnsCompleted = events.filter(e => e.event === 'answer').length
  const context = buildVerdictContext(events)

  let rawResponse: string
  try {
    rawResponse = await callModel(deps.anthropic, OPUS_MODEL, VERDICT_SYSTEM, context, 2048)
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: cause instanceof Error ? cause.message : String(cause),
      },
      ep,
    )
    throw new VerdictGenerationError('Opus API call failed during finishSession', sessionId, cause)
  }

  let verdict: Verdict
  try {
    verdict = parseModelJson<Verdict>(rawResponse)
    if (typeof verdict.target_role !== 'string') throw new Error('Missing target_role field')
  } catch (cause) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: `Failed to parse Opus response: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
      ep,
    )
    throw new VerdictGenerationError('Failed to parse Opus verdict response', sessionId, cause)
  }

  // Validate the verdict constraints
  if (!Array.isArray(verdict.solid) || verdict.solid.length < 1) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: 'Verdict validation failed: "solid" must have at least 1 entry',
      },
      ep,
    )
    throw new VerdictGenerationError(
      'Verdict validation failed: "solid" must have at least 1 entry',
      sessionId,
    )
  }

  if (!Array.isArray(verdict.weak) || verdict.weak.length < 1) {
    await appendEvent(
      {
        session_id: sessionId,
        event: 'error',
        ts: ts(deps),
        stage: 'verdict',
        message: 'Verdict validation failed: "weak" must have at least 1 entry',
      },
      ep,
    )
    throw new VerdictGenerationError(
      'Verdict validation failed: "weak" must have at least 1 entry',
      sessionId,
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
  }

  if (finishEvent) {
    snapshot.verdict = finishEvent.verdict as Verdict
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
