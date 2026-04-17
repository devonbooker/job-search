import { describe, test, expect, afterEach } from 'bun:test'
import { createRuntime } from '../../src/agents/runtime'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-runtime.db'

describe('createRuntime', () => {
  afterEach(() => {
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('returns a queue and anthropic client', () => {
    const runtime = createRuntime(TEST_DB)
    expect(runtime.queue).toBeDefined()
    expect(runtime.anthropic).toBeDefined()
    runtime.queue.close()
  })

  test('returns a single shared queue instance', () => {
    const runtime = createRuntime(TEST_DB)
    expect(runtime.queue).toBe(runtime.queue)
    runtime.queue.close()
  })
})
