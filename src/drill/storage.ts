import { createHash } from 'crypto'
import { appendFile, readFile, mkdir } from 'fs/promises'
import { existsSync } from 'fs'
import { dirname } from 'path'

// ─── Types ───────────────────────────────────────────────────────────────────

export type DrillEvent =
  | { session_id: string; event: 'start'; ts: string; resume_hash: string; jd_hash: string; resume_preview: string; jd_preview: string }
  | { session_id: string; event: 'question'; ts: string; turn: number; text: string }
  | { session_id: string; event: 'answer'; ts: string; turn: number; text: string; model_assessment: 'weak' | 'partial' | 'solid' }
  | { session_id: string; event: 'reopen'; ts: string; user_agent: string }
  | { session_id: string; event: 'finish'; ts: string; turns_completed: number; verdict: unknown }
  | { session_id: string; event: 'error'; ts: string; stage: 'drill' | 'verdict'; message: string }

// ─── ULID ────────────────────────────────────────────────────────────────────

// Crockford base32 alphabet (uppercase, no I L O U)
const ENCODING = '0123456789ABCDEFGHJKMNPQRSTVWXYZ'

function encodeTime(ms: number, len: number): string {
  let str = ''
  for (let i = len - 1; i >= 0; i--) {
    str = ENCODING[ms & 0x1f] + str
    ms = Math.floor(ms / 32)
  }
  return str
}

function encodeRandom(len: number): string {
  let str = ''
  for (let i = 0; i < len; i++) {
    str += ENCODING[Math.floor(Math.random() * 32)]
  }
  return str
}

/**
 * Generates a ULID: 26-char, lexicographically sortable, timestamp-embedded.
 * Format: 10 timestamp chars + 16 random chars
 */
export function newSessionId(): string {
  const ms = Date.now()
  return encodeTime(ms, 10) + encodeRandom(16)
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
    if (!existsSync(dir)) {
      await mkdir(dir, { recursive: true })
    }
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
