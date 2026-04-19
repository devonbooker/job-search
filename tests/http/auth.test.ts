import { describe, test, expect, afterEach } from 'bun:test'
import { generateToken, persistToken, loadOrCreateToken } from '../../src/http/auth'
import { existsSync, unlinkSync, readFileSync } from 'fs'

const TEST_FILE = './test.session-token'

afterEach(() => {
  if (existsSync(TEST_FILE)) unlinkSync(TEST_FILE)
})

describe('auth token', () => {
  test('generateToken returns 64-char hex', () => {
    const t = generateToken()
    expect(t).toMatch(/^[0-9a-f]{64}$/)
  })

  test('persistToken writes file with 0o600 semantics (file exists with content)', () => {
    persistToken('deadbeef', TEST_FILE)
    expect(existsSync(TEST_FILE)).toBe(true)
    expect(readFileSync(TEST_FILE, 'utf-8')).toBe('deadbeef')
  })

  test('loadOrCreateToken creates when absent, reads when present', () => {
    const t1 = loadOrCreateToken(TEST_FILE)
    const t2 = loadOrCreateToken(TEST_FILE)
    expect(t1).toBe(t2)
  })
})
