import { describe, test, expect } from 'bun:test'
import { parseClaudeJson } from '../../src/agents/json-extract'

describe('parseClaudeJson', () => {
  test('parses raw JSON object', () => {
    expect(parseClaudeJson<{ a: number }>('{"a":1}')).toEqual({ a: 1 })
  })

  test('parses raw JSON array', () => {
    expect(parseClaudeJson<number[]>('[1,2,3]')).toEqual([1, 2, 3])
  })

  test('strips ```json ... ``` fence', () => {
    const text = '```json\n{"a":1}\n```'
    expect(parseClaudeJson<{ a: number }>(text)).toEqual({ a: 1 })
  })

  test('strips bare ``` ... ``` fence', () => {
    const text = '```\n[1,2]\n```'
    expect(parseClaudeJson<number[]>(text)).toEqual([1, 2])
  })

  test('strips fence with leading prose', () => {
    const text = "Here's the JSON:\n```json\n{\"x\":\"y\"}\n```\n"
    expect(parseClaudeJson<{ x: string }>(text)).toEqual({ x: 'y' })
  })

  test('throws on truly invalid JSON', () => {
    expect(() => parseClaudeJson('not json')).toThrow()
  })
})
