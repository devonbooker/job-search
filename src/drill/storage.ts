import { createHash, randomBytes } from 'crypto'
import { appendFile, readFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Verdict } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export type DrillEvent =
  | { session_id: string; event: 'start'; ts: string; resume_hash: string; jd_hash: string; resume_preview: string; jd_preview: string; resume: string; job_description: string }
  | { session_id: string; event: 'question'; ts: string; turn: number; text: string }
  | { session_id: string; event: 'answer'; ts: string; turn: number; text: string; model_assessment: 'weak' | 'partial' | 'solid' }
  | { session_id: string; event: 'reopen'; ts: string; user_agent: string }
  | { session_id: string; event: 'finish'; ts: string; turns_completed: number; verdict: Verdict }
  | { session_id: string; event: 'error'; ts: string; stage: 'drill' | 'verdict'; message: string }

// ─── ULID ────────────────────────────────────────────────────────────────────

// Crockford base32 alphabet (uppercase, no I L O U)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

const ULID_TIME_LEN = 10
const ULID_RAND_LEN = 16
const ULID_RAND_BYTES = 10

function encodeTime(ms: number, len: number): string {
  let str = ''
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[ms & 0x1f] + str
    ms = Math.floor(ms / 32)
  }
  return str
}

// Encode an 80-bit random value (10 bytes) as 16 Crockford base32 chars.
// Each base32 char encodes 5 bits; 16 * 5 = 80 bits.
function encodeRandomBytes(bytes: Uint8Array): string {
  // Pack 10 bytes into a 16-char base32 string (80 bits).
  // We read 5 bits at a time across the byte array.
  let str = ''
  let bitBuf = 0
  let bitsLeft = 0
  let byteIdx = 0
  for (let i = 0; i < ULID_RAND_LEN; i++) {
    while (bitsLeft < 5) {
      bitBuf = (bitBuf << 8) | bytes[byteIdx++]
      bitsLeft += 8
    }
    bitsLeft -= 5
    str += ENCODING[(bitBuf >> bitsLeft) & 0x1f]
  }
  return str
}

function freshRandomBytes(): Uint8Array {
  return new Uint8Array(randomBytes(ULID_RAND_BYTES).buffer)
}

// Increment an 80-bit value stored in a Uint8Array (big-endian).
// Returns true if overflow occurred (all bits were 1).
function incrementBytes(bytes: Uint8Array): boolean {
  for (let i = bytes.length - 1; i >= 0; i--) {
    if (bytes[i] < 255) {
      bytes[i]++
      return false
    }
    bytes[i] = 0
  }
  return true // overflow: all bytes wrapped to 0
}

// Monotonic ULID state
let lastTimestamp = -1
let lastRandom = new Uint8Array(10)

/**
 * Generates a ULID: 26-char, lexicographically sortable, timestamp-embedded.
 * Format: 10 timestamp chars + 16 random chars
 *
 * Implements ULID monotonicity: within the same millisecond, increments the
 * random portion rather than generating a fresh one, guaranteeing sort order.
 */
export function newSessionId(): string {
  let ms = Date.now()

  if (ms <= lastTimestamp) {
    ms = lastTimestamp
    const overflow = incrementBytes(lastRandom)
    if (overflow) {
      // Advance timestamp by 1 ms to avoid collision
      ms = lastTimestamp + 1
      lastTimestamp = ms
      lastRandom = freshRandomBytes()
    }
  } else {
    lastTimestamp = ms
    lastRandom = freshRandomBytes()
  }

  return encodeTime(ms, ULID_TIME_LEN) + encodeRandomBytes(lastRandom)
}

// ─── Hash ────────────────────────────────────────────────────────────────────

/**
 * Returns "sha256:" + hex digest. Used to store hashes instead of full
 * resume/JD text in start events.
 */
export function hashInput(text: string): string {
  const digest = createHash('sha256').update(text, 'utf8').digest('hex')
  return `sha256:${digest}`
}

// ─── JSONL Storage ───────────────────────────────────────────────────────────

const DEFAULT_PATH = './data/drill-sessions.jsonl'

// Serializes concurrent writes via an in-memory promise chain.
// Each call to appendEvent chains onto this promise so writes are sequential.
let writeChain: Promise<void> = Promise.resolve()

/**
 * Appends one DrillEvent as a JSON line to the JSONL file.
 * Writes are serialized through an in-memory promise chain to prevent
 * interleaving under concurrent async callers.
 *
 * @param event - The event to append
 * @param filePath - Override path (used in tests; defaults to ./data/drill-sessions.jsonl)
 */
export function appendEvent(event: DrillEvent, filePath: string = DEFAULT_PATH): Promise<void> {
  const task = writeChain.then(async () => {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true })
    await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8')
  })
  // Chain: next write waits for this one, even if it rejects
  writeChain = task.catch(() => {})
  return task
}

/**
 * Reads all events for a given session_id from the JSONL file,
 * returned in file order.
 *
 * @param sessionId - The session to filter for
 * @param filePath - Override path (used in tests)
 */
export async function readSession(
  sessionId: string,
  filePath: string = DEFAULT_PATH,
): Promise<DrillEvent[]> {
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    // File doesn't exist yet
    return []
  }

  return raw
    .split('\n')
    .filter(line => line.trim() !== '')
    .map(line => JSON.parse(line) as DrillEvent)
    .filter(event => event.session_id === sessionId)
}
