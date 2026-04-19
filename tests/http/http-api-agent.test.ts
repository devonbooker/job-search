import { describe, test, expect } from 'bun:test'
import type { AgentEvent, Snapshot } from '../../src/agents/events'
import { AgentRole } from '../../src/agents/types'

describe('AgentEvent / Snapshot types', () => {
  test('AgentEvent carries id, type, from, payload, timestamp', () => {
    const evt: AgentEvent = {
      id: 1,
      type: 'status',
      from: AgentRole.ORCHESTRATOR,
      payload: { sessionId: 's1', stage: 'intake' },
      timestamp: Date.now(),
    }
    expect(evt.id).toBe(1)
  })

  test('Snapshot aggregates stage + buffered events + optional payloads', () => {
    const snap: Snapshot = {
      sessionId: 's1',
      stage: 'intake',
      events: [],
    }
    expect(snap.sessionId).toBe('s1')
  })
})
