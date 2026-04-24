import { createHash, randomBytes } from 'crypto'
import { appendFile, readFile, mkdir } from 'fs/promises'
import { dirname } from 'path'
import type { Verdict } from './types'

// ─── Types ───────────────────────────────────────────────────────────────────

export type DrillEvent =
  | { session_id: string; event: 'start'; ts: string; resume_hash: string; jd_hash: string; resume_preview: string; jd_preview: string; resume: string; job_description: string; project?: string }
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

// Monotonic ULID state (module-local — process-scoped, NOT worker-safe).
// If we ever run the drill in a multi-process deploy (cluster mode, multiple
// Bun workers, horizontal scaling), two workers can generate the same ULID
// during the same millisecond because each has its own lastTimestamp/lastRandom.
// Mitigations if needed: (a) use crypto.randomUUID() instead, (b) embed a
// per-worker id in the random bytes, (c) wire through a shared-memory lock.
// Fine for V1 single-process Bun.
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

// Per-session event cache. Avoids the O(file_size) full-file parse on every
// read. On startup the cache is cold — the first read of any session falls
// through to the full-file scan, which populates entries for EVERY session
// found (one pass amortizes all future reads). appendEvent invalidates the
// per-session entry (cheaper than re-scanning) so subsequent reads rebuild
// just that session.
//
// Cache is keyed by `filePath + session_id` so tests with per-test tmpfiles
// don't leak state between tests.
const sessionCache = new Map<string, DrillEvent[]>()
let cacheHydratedForPath: string | null = null

function cacheKey(filePath: string, sessionId: string): string {
  return `${filePath}|${sessionId}`
}

function invalidateSessionCache(filePath: string, sessionId: string): void {
  sessionCache.delete(cacheKey(filePath, sessionId))
}

/**
 * Reset cache — exported for tests. Production code never calls this.
 */
export function _resetCacheForTests(): void {
  sessionCache.clear()
  cacheHydratedForPath = null
}

async function hydrateCache(filePath: string): Promise<void> {
  if (cacheHydratedForPath === filePath) return
  sessionCache.clear()
  let raw: string
  try {
    raw = await readFile(filePath, 'utf8')
  } catch {
    cacheHydratedForPath = filePath
    return
  }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    const event = JSON.parse(line) as DrillEvent
    const key = cacheKey(filePath, event.session_id)
    const bucket = sessionCache.get(key) ?? []
    bucket.push(event)
    sessionCache.set(key, bucket)
  }
  cacheHydratedForPath = filePath
}

/**
 * Appends one DrillEvent as a JSON line to the JSONL file.
 * Writes are serialized through an in-memory promise chain to prevent
 * interleaving under concurrent async callers.
 *
 * Side effect: updates the in-memory cache for this session. If the cache
 * is hydrated for this filePath, the event is pushed onto the existing
 * bucket. Otherwise the cache is invalidated for this session and will
 * rebuild on the next read.
 *
 * @param event - The event to append
 * @param filePath - Override path (used in tests; defaults to ./data/drill-sessions.jsonl)
 */
export function appendEvent(event: DrillEvent, filePath: string = DEFAULT_PATH): Promise<void> {
  const task = writeChain.then(async () => {
    const dir = dirname(filePath)
    await mkdir(dir, { recursive: true })
    await appendFile(filePath, JSON.stringify(event) + '\n', 'utf8')
    // Keep cache consistent with disk if we're hydrated for this path.
    if (cacheHydratedForPath === filePath) {
      const key = cacheKey(filePath, event.session_id)
      const bucket = sessionCache.get(key) ?? []
      bucket.push(event)
      sessionCache.set(key, bucket)
    } else {
      invalidateSessionCache(filePath, event.session_id)
    }
  })
  // Chain: next write waits for this one, even if it rejects
  writeChain = task.catch(() => {})
  return task
}

/**
 * Reads all events for a given session_id from the JSONL file,
 * returned in file order. Uses an in-memory cache — first read per filePath
 * hydrates the cache from disk; subsequent reads hit memory.
 *
 * @param sessionId - The session to filter for
 * @param filePath - Override path (used in tests)
 */
export async function readSession(
  sessionId: string,
  filePath: string = DEFAULT_PATH,
): Promise<DrillEvent[]> {
  await hydrateCache(filePath)
  return sessionCache.get(cacheKey(filePath, sessionId)) ?? []
}
