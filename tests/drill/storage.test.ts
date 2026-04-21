import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { newSessionId, appendEvent, readSession, hashInput } from '../../src/drill/storage'
import type { DrillEvent } from '../../src/drill/storage'

// ULID character set (Crockford base32)
const ULID_CHARS = /^[0123456789ABCDEFGHJKMNPQRSTVWXYZ]{26}$/

describe('newSessionId', () => {
  test('returns a 26-character ULID', () => {
    const id = newSessionId()
    expect(id).toHaveLength(26)
  })

  test('uses only valid ULID characters', () => {
    const id = newSessionId()
    expect(ULID_CHARS.test(id)).toBe(true)
  })

  test('two sequential IDs are different', () => {
    const a = newSessionId()
    const b = newSessionId()
    expect(a).not.toBe(b)
  })

  test('two sequential IDs are lexicographically sortable (later >= earlier)', () => {
    const a = newSessionId()
    const b = newSessionId()
    // Both generated in sequence; b should sort >= a
    expect(b >= a).toBe(true)
  })
})

describe('hashInput', () => {
  test('output starts with "sha256:"', () => {
    const h = hashInput('hello')
    expect(h.startsWith('sha256:')).toBe(true)
  })

  test('is deterministic - same input yields same hash', () => {
    const a = hashInput('some resume text')
    const b = hashInput('some resume text')
    expect(a).toBe(b)
  })

  test('different inputs produce different hashes', () => {
    expect(hashInput('foo')).not.toBe(hashInput('bar'))
  })

  test('hash portion is 64 hex characters (sha256)', () => {
    const h = hashInput('test')
    const hex = h.slice('sha256:'.length)
    expect(hex).toHaveLength(64)
    expect(/^[0-9a-f]{64}$/.test(hex)).toBe(true)
  })
})

describe('appendEvent / readSession', () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'drill-test-'))
    jsonlPath = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  test('writes a JSON line with newline terminator', async () => {
    const event: DrillEvent = {
      session_id: 'SESSION1',
      event: 'start',
      ts: new Date().toISOString(),
      resume_hash: hashInput('resume'),
      jd_hash: hashInput('jd'),
      resume_preview: 'Senior engineer...',
      jd_preview: 'We are hiring...',
    }

    await appendEvent(event, jsonlPath)

    const raw = readFileSync(jsonlPath, 'utf8')
    expect(raw.endsWith('\n')).toBe(true)
    const parsed = JSON.parse(raw.trim())
    expect(parsed).toEqual(event)
  })

  test('two concurrent appendEvent calls produce exactly 2 valid JSON lines', async () => {
    const event1: DrillEvent = {
      session_id: 'SESSION_A',
      event: 'question',
      ts: new Date().toISOString(),
      turn: 1,
      text: 'Tell me about your work at ACME.',
    }
    const event2: DrillEvent = {
      session_id: 'SESSION_B',
      event: 'answer',
      ts: new Date().toISOString(),
      turn: 1,
      text: 'I built a pipeline.',
      model_assessment: 'solid',
    }

    await Promise.all([appendEvent(event1, jsonlPath), appendEvent(event2, jsonlPath)])

    const raw = readFileSync(jsonlPath, 'utf8')
    const lines = raw.split('\n').filter(l => l.trim() !== '')
    expect(lines).toHaveLength(2)

    // Both lines must parse as valid JSON
    const parsed = lines.map(l => JSON.parse(l))
    const sessionIds = new Set(parsed.map((p: DrillEvent) => p.session_id))
    expect(sessionIds.has('SESSION_A')).toBe(true)
    expect(sessionIds.has('SESSION_B')).toBe(true)
  })

  test('readSession returns only events matching session_id', async () => {
    const sid = 'TARGET_SESSION'
    const otherSid = 'OTHER_SESSION'

    const e1: DrillEvent = {
      session_id: sid,
      event: 'start',
      ts: '2025-01-01T00:00:00.000Z',
      resume_hash: hashInput('r'),
      jd_hash: hashInput('j'),
      resume_preview: 'r',
      jd_preview: 'j',
    }
    const e2: DrillEvent = {
      session_id: otherSid,
      event: 'question',
      ts: '2025-01-01T00:00:01.000Z',
      turn: 1,
      text: 'noise',
    }
    const e3: DrillEvent = {
      session_id: sid,
      event: 'question',
      ts: '2025-01-01T00:00:02.000Z',
      turn: 1,
      text: 'What did you build?',
    }

    // Sequential appends to maintain file order
    await appendEvent(e1, jsonlPath)
    await appendEvent(e2, jsonlPath)
    await appendEvent(e3, jsonlPath)

    const events = await readSession(sid, jsonlPath)
    expect(events).toHaveLength(2)
    expect(events[0].event).toBe('start')
    expect(events[1].event).toBe('question')
    expect(events.every(e => e.session_id === sid)).toBe(true)
  })

  test('readSession returns events in file order', async () => {
    const sid = 'ORDER_SESSION'
    const eventTypes: DrillEvent['event'][] = ['start', 'question', 'answer', 'finish']

    await appendEvent({
      session_id: sid,
      event: 'start',
      ts: '2025-01-01T00:00:00.000Z',
      resume_hash: hashInput('r'),
      jd_hash: hashInput('j'),
      resume_preview: 'r',
      jd_preview: 'j',
    }, jsonlPath)

    await appendEvent({
      session_id: sid,
      event: 'question',
      ts: '2025-01-01T00:00:01.000Z',
      turn: 1,
      text: 'Q1',
    }, jsonlPath)

    await appendEvent({
      session_id: sid,
      event: 'answer',
      ts: '2025-01-01T00:00:02.000Z',
      turn: 1,
      text: 'A1',
      model_assessment: 'weak',
    }, jsonlPath)

    await appendEvent({
      session_id: sid,
      event: 'finish',
      ts: '2025-01-01T00:00:03.000Z',
      turns_completed: 1,
      verdict: { score: 'low' },
    }, jsonlPath)

    const events = await readSession(sid, jsonlPath)
    expect(events.map(e => e.event)).toEqual(eventTypes)
  })

  test('readSession returns empty array when file does not exist', async () => {
    const events = await readSession('MISSING', join(tmpDir, 'nonexistent.jsonl'))
    expect(events).toEqual([])
  })
})
