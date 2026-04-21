import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readSession } from '../../src/drill/storage'
import type { DrillEvent } from '../../src/drill/storage'
import type { DrillTurnResponse, Verdict } from '../../src/drill/prompts'
import {
  startSession,
  submitAnswer,
  finishSession,
  getSession,
  recordReopen,
  DrillTurnError,
  VerdictGenerationError,
} from '../../src/drill/engine'
import type { EngineDeps } from '../../src/drill/engine'

// ─── Stub Anthropic client ────────────────────────────────────────────────────

interface StubMessage {
  content: Array<{ type: 'text'; text: string }>
}

/**
 * Minimal stub for the Anthropic messages.create() call.
 * Responses are consumed in FIFO order per call to messages.create.
 */
function makeStubAnthropic(responses: string[]): EngineDeps['anthropic'] {
  const queue = [...responses]
  return {
    messages: {
      create: async (_params: unknown): Promise<StubMessage> => {
        if (queue.length === 0) throw new Error('No more stub responses queued')
        const text = queue.shift()!
        return { content: [{ type: 'text', text }] }
      },
    },
  } as unknown as EngineDeps['anthropic']
}

// ─── Sample fixtures ──────────────────────────────────────────────────────────

const RESUME = 'Senior Cloud Security Engineer. Deployed AWS WAF, wrote Terraform modules.'
const JD = 'Series-B startup seeking a Cloud Security Engineer with AWS experience.'

const goodDrillTurn = (question = 'Tell me about your WAF deployment.'): DrillTurnResponse => ({
  question,
  model_assessment: 'solid',
  early_terminate: false,
})

const earlyTerminateTurn: DrillTurnResponse = {
  question: '',
  model_assessment: 'solid',
  early_terminate: true,
}

const goodVerdict: Verdict = {
  target_role: 'Cloud Security Engineer',
  project_drilled: 'AWS WAF deployment',
  solid: ['Clear ownership of WAF configuration'],
  weak: [{ area: 'Threat modelling', why: 'Not explored', example_question: 'Tell me about your WAF deployment.' }],
  interviewer_verdict: 'Advance to phone screen.',
  overall: 'Solid',
  overall_summary: 'Strong practical knowledge, minor gaps in formal process.',
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

let tmpDir: string
let jsonlPath: string
let fixedNow: Date

function makeDeps(responses: string[], overrides: Partial<EngineDeps> = {}): EngineDeps {
  return {
    anthropic: makeStubAnthropic(responses),
    storageFilePath: jsonlPath,
    now: () => fixedNow,
    ...overrides,
  }
}

function getEvents(sessionId: string): Promise<DrillEvent[]> {
  return readSession(sessionId, jsonlPath)
}

// ─── Setup / teardown ────────────────────────────────────────────────────────

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'drill-engine-test-'))
  jsonlPath = join(tmpDir, 'sessions.jsonl')
  fixedNow = new Date('2026-01-01T00:00:00.000Z')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

// ─── 1. startSession ─────────────────────────────────────────────────────────

describe('startSession', () => {
  test('writes start + question events, returns first question from stubbed Sonnet', async () => {
    const firstQ = 'Tell me about your WAF deployment.'
    const deps = makeDeps([JSON.stringify(goodDrillTurn(firstQ))])

    const result = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    expect(result.firstQuestion).toBe(firstQ)
    expect(result.sessionId).toHaveLength(26)

    const events = await getEvents(result.sessionId)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('start')
    expect(events[1].event).toBe('question')

    const questionEvent = events[1]
    if (questionEvent.event !== 'question') throw new Error('Expected question event')
    expect(questionEvent.text).toBe(firstQ)
    expect(questionEvent.turn).toBe(1)
  })

  test('start event has correct hash, preview, and full-text fields', async () => {
    const deps = makeDeps([JSON.stringify(goodDrillTurn())])
    const result = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    const events = await getEvents(result.sessionId)
    const startEvent = events[0]
    if (startEvent.event !== 'start') throw new Error('Expected start event')

    expect(startEvent.resume_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(startEvent.jd_hash).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(startEvent.resume_preview).toBe(RESUME.slice(0, 120))
    expect(startEvent.jd_preview).toBe(JD.slice(0, 120))
    expect(startEvent.resume).toBe(RESUME)
    expect(startEvent.job_description).toBe(JD)
  })

  test('uses fixed timestamp from now() dep', async () => {
    const deps = makeDeps([JSON.stringify(goodDrillTurn())])
    const result = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    const events = await getEvents(result.sessionId)
    expect(events[0].ts).toBe('2026-01-01T00:00:00.000Z')
  })

  test('logs error event and throws DrillTurnError on malformed Sonnet JSON', async () => {
    const deps = makeDeps(['not valid json at all {{{'])
    await expect(startSession({ resume: RESUME, jobDescription: JD }, deps))
      .rejects.toBeInstanceOf(DrillTurnError)

    // The start event is always written before the Sonnet call, so the file always exists here.
    const { readFileSync } = await import('fs')
    const lines = readFileSync(jsonlPath, 'utf8').split('\n').filter(l => l.trim())
    const parsed = lines.map(l => JSON.parse(l))
    const errorEvent = parsed.find((e: DrillEvent) => e.event === 'error')
    expect(errorEvent).toBeDefined()
    expect(errorEvent.stage).toBe('drill')
  })
})

// ─── 2. submitAnswer - normal turn ───────────────────────────────────────────

describe('submitAnswer - normal turn', () => {
  test('turn 2: writes answer + question events, returns next question', async () => {
    const q1 = 'Tell me about your WAF deployment.'
    const q2 = 'Which managed rule groups did you use?'
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn(q1)),
      JSON.stringify(goodDrillTurn(q2)),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    const result = await submitAnswer(
      { sessionId, answerText: 'I used AWS WAF with AWSManagedRulesCommonRuleSet.' },
      deps,
    )

    expect(result.nextQuestion).toBe(q2)
    expect(result.completed).toBe(false)
    expect(result.turnsCompleted).toBe(1)

    const events = await getEvents(sessionId)
    // start, question(1), answer(1), question(2)
    expect(events).toHaveLength(4)
    const types = events.map(e => e.event)
    expect(types).toEqual(['start', 'question', 'answer', 'question'])

    const answerEvent = events[2]
    if (answerEvent.event !== 'answer') throw new Error('Expected answer event')
    expect(answerEvent.model_assessment).toBe('solid')
    expect(answerEvent.turn).toBe(1)

    const q2Event = events[3]
    if (q2Event.event !== 'question') throw new Error('Expected question event')
    expect(q2Event.text).toBe(q2)
    expect(q2Event.turn).toBe(2)
  })
})

// ─── 3. submitAnswer - early terminate ───────────────────────────────────────

describe('submitAnswer - early terminate', () => {
  test('at turn 6, Sonnet returning early_terminate: true -> completed: true, no new question event', async () => {
    // We need 5 turns done (start + 5 Q/A pairs), then submit turn 6 which triggers early_terminate
    // start: 1 Sonnet call for Q1
    // turns 2-6: 5 more Sonnet calls (one per submitAnswer)
    // We'll simulate: all 6 Sonnet calls, last one returns early_terminate: true

    const responses = [
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(goodDrillTurn('Q2')),
      JSON.stringify(goodDrillTurn('Q3')),
      JSON.stringify(goodDrillTurn('Q4')),
      JSON.stringify(goodDrillTurn('Q5')),
      JSON.stringify(goodDrillTurn('Q6')),
      // 6th submitAnswer: early terminate
      JSON.stringify(earlyTerminateTurn),
    ]
    const deps = makeDeps(responses)

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    // 5 intermediate turns
    for (let i = 1; i <= 5; i++) {
      await submitAnswer({ sessionId, answerText: `Answer ${i}` }, deps)
    }

    // 6th answer triggers early_terminate
    const result = await submitAnswer({ sessionId, answerText: 'Answer 6' }, deps)

    expect(result.completed).toBe(true)
    expect(result.nextQuestion).toBeNull()
    expect(result.turnsCompleted).toBe(6)

    const events = await getEvents(sessionId)
    // Should have answer event but NO new question event after the early-terminate turn
    const last = events[events.length - 1]
    expect(last.event).toBe('answer')
  })
})

// ─── 4. submitAnswer - 12-turn cap ───────────────────────────────────────────

describe('submitAnswer - 12-turn cap', () => {
  test('at turn 12, always returns completed: true regardless of Sonnet response', async () => {
    // Build 12 turns: start (Q1) + 11 more Q generations + 12 answer evaluations
    const responses: string[] = []
    // startSession: Sonnet returns Q1
    responses.push(JSON.stringify(goodDrillTurn('Q1')))
    // submitAnswer turns 1-11: each Sonnet call returns the next question (Q2..Q12)
    for (let i = 2; i <= 12; i++) {
      responses.push(JSON.stringify(goodDrillTurn(`Q${i}`)))
    }
    // submitAnswer turn 12: Sonnet call returns early_terminate: false, but cap forces completed
    responses.push(JSON.stringify({ ...goodDrillTurn('Q13'), early_terminate: false }))

    const deps = makeDeps(responses)
    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    for (let i = 1; i <= 11; i++) {
      await submitAnswer({ sessionId, answerText: `Answer ${i}` }, deps)
    }

    const result = await submitAnswer({ sessionId, answerText: 'Answer 12' }, deps)

    expect(result.completed).toBe(true)
    expect(result.nextQuestion).toBeNull()
    expect(result.turnsCompleted).toBe(12)

    // No question event for turn 13 (Q12 was asked during submitAnswer 11, but no Q13)
    const events = await getEvents(sessionId)
    const questionTurns = events
      .filter((e): e is Extract<DrillEvent, { event: 'question' }> => e.event === 'question')
      .map(e => e.turn)
    // Q1 through Q12 exist (Q12 was the last question asked before the 12th answer)
    expect(Math.max(...questionTurns)).toBe(12)
    expect(questionTurns.includes(13)).toBe(false)
  })
})

// ─── 5. submitAnswer - malformed JSON ────────────────────────────────────────

describe('submitAnswer - malformed JSON from Sonnet', () => {
  test('logs error event and throws DrillTurnError', async () => {
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      'not json at all',
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    await expect(submitAnswer({ sessionId, answerText: 'My answer' }, deps))
      .rejects.toBeInstanceOf(DrillTurnError)

    const events = await getEvents(sessionId)
    const errorEvent = events.find(e => e.event === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.event !== 'error') throw new Error()
    expect(errorEvent.stage).toBe('drill')
  })
})

// ─── 5b. submitAnswer - completed session guard ───────────────────────────────

describe('submitAnswer - completed session guard', () => {
  test('throws DrillTurnError and logs error event when session already has finish event', async () => {
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(goodVerdict),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)
    await finishSession(sessionId, deps)

    // Now attempt to submit an answer to the already-finished session
    const thrown = await submitAnswer({ sessionId, answerText: 'Late answer' }, deps).catch(e => e)
    expect(thrown).toBeInstanceOf(DrillTurnError)
    expect((thrown as DrillTurnError).code).toBe('session_complete')

    const events = await getEvents(sessionId)
    const errorEvent = events.find(e => e.event === 'error' && e.message.includes('session is complete'))
    expect(errorEvent).toBeDefined()
    if (errorEvent?.event !== 'error') throw new Error()
    expect(errorEvent.stage).toBe('drill')
  })
})

// ─── 6. finishSession ────────────────────────────────────────────────────────

describe('finishSession', () => {
  test('writes finish event with verdict from stubbed Opus, returns verdict', async () => {
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(goodVerdict),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)
    const verdict = await finishSession(sessionId, deps)

    expect(verdict.overall).toBe('Solid')
    expect(verdict.solid).toHaveLength(1)
    expect(verdict.weak).toHaveLength(1)

    const events = await getEvents(sessionId)
    const finishEvent = events.find(e => e.event === 'finish')
    expect(finishEvent).toBeDefined()
    if (finishEvent?.event !== 'finish') throw new Error()
    expect(finishEvent.verdict).toEqual(goodVerdict)
  })
})

// ─── 7. finishSession - idempotent ───────────────────────────────────────────

describe('finishSession - idempotent', () => {
  test('calling twice does not double-write and returns same verdict', async () => {
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(goodVerdict),
      // Second finishSession call should NOT call Opus again (idempotent)
      // If it does, this would throw "No more stub responses queued"
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)
    const v1 = await finishSession(sessionId, deps)
    const v2 = await finishSession(sessionId, deps)

    expect(v1).toEqual(v2)

    const events = await getEvents(sessionId)
    const finishEvents = events.filter(e => e.event === 'finish')
    expect(finishEvents).toHaveLength(1)
  })
})

// ─── 8. finishSession - invalid verdict (empty weak) ─────────────────────────

describe('finishSession - verdict validation', () => {
  test('throws VerdictGenerationError when Opus returns empty weak array, logs error', async () => {
    const badVerdict: Verdict = {
      ...goodVerdict,
      weak: [], // violates the constraint
    }

    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(badVerdict),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    await expect(finishSession(sessionId, deps))
      .rejects.toBeInstanceOf(VerdictGenerationError)

    const events = await getEvents(sessionId)
    const errorEvent = events.find(e => e.event === 'error')
    expect(errorEvent).toBeDefined()
    if (errorEvent?.event !== 'error') throw new Error()
    expect(errorEvent.stage).toBe('verdict')
  })

  test('throws VerdictGenerationError when Opus returns empty solid array, logs error', async () => {
    const badVerdict: Verdict = {
      ...goodVerdict,
      solid: [], // violates the constraint
    }

    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(badVerdict),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    await expect(finishSession(sessionId, deps))
      .rejects.toBeInstanceOf(VerdictGenerationError)
  })

  test('throws VerdictGenerationError when Opus returns malformed JSON, logs error', async () => {
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      'totally not json',
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    await expect(finishSession(sessionId, deps))
      .rejects.toBeInstanceOf(VerdictGenerationError)
  })
})

// ─── 9. getSession - in-progress ─────────────────────────────────────────────

describe('getSession - in-progress', () => {
  test('reconstructs correct snapshot for in-progress session', async () => {
    const q1 = 'Tell me about your WAF deployment.'
    const q2 = 'Which rule groups?'
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn(q1)),
      JSON.stringify(goodDrillTurn(q2)),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)
    await submitAnswer({ sessionId, answerText: 'I used AWS WAF.' }, deps)

    const snapshot = await getSession(sessionId, deps)

    expect(snapshot.sessionId).toBe(sessionId)
    expect(snapshot.status).toBe('in_progress')
    expect(snapshot.turnsCompleted).toBe(1)
    expect(snapshot.verdict).toBeUndefined()
    expect(snapshot.transcript).toHaveLength(2) // turn 1 (complete Q+A) and turn 2 (question only)

    const t1 = snapshot.transcript.find(t => t.turn === 1)
    expect(t1?.question).toBe(q1)
    expect(t1?.answer).toBe('I used AWS WAF.')
    expect(t1?.assessment).toBe('solid')

    const t2 = snapshot.transcript.find(t => t.turn === 2)
    expect(t2?.question).toBe(q2)
    expect(t2?.answer).toBeUndefined()
  })
})

// ─── 10. getSession - complete ────────────────────────────────────────────────

describe('getSession - complete', () => {
  test("returns status 'complete' + verdict for finished session", async () => {
    const deps = makeDeps([
      JSON.stringify(goodDrillTurn('Q1')),
      JSON.stringify(goodVerdict),
    ])

    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)
    await finishSession(sessionId, deps)

    const snapshot = await getSession(sessionId, deps)

    expect(snapshot.status).toBe('complete')
    expect(snapshot.verdict).toEqual(goodVerdict)
    expect(snapshot.turnsCompleted).toBe(0) // no answers submitted
  })
})

// ─── 11. recordReopen ────────────────────────────────────────────────────────

describe('recordReopen', () => {
  test('appends reopen event with user_agent', async () => {
    const deps = makeDeps([JSON.stringify(goodDrillTurn('Q1'))])
    const { sessionId } = await startSession({ resume: RESUME, jobDescription: JD }, deps)

    await recordReopen(sessionId, 'Mozilla/5.0 TestBrowser', deps)

    const events = await getEvents(sessionId)
    const reopenEvent = events.find(e => e.event === 'reopen')
    expect(reopenEvent).toBeDefined()
    if (reopenEvent?.event !== 'reopen') throw new Error()
    expect(reopenEvent.user_agent).toBe('Mozilla/5.0 TestBrowser')
  })
})
