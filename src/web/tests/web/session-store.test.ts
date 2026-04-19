import { describe, test, expect, beforeEach } from 'vitest'
import { useSessionStore } from '../../state/session'
import { AgentRole } from '../../../agents/types'

describe('session store', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
  })

  test('setFromEvent with status stage updates stage', () => {
    useSessionStore.getState().setFromEvent({
      id: 1, type: 'status', from: AgentRole.ORCHESTRATOR,
      payload: { sessionId: 's1', stage: 'researching' },
      timestamp: Date.now(),
    })
    expect(useSessionStore.getState().stage).toBe('researching')
  })

  test('result from RESEARCH_LEAD populates jobTitles and skillsByTitle', () => {
    useSessionStore.getState().setFromEvent({
      id: 2, type: 'result', from: AgentRole.RESEARCH_LEAD,
      payload: { sessionId: 's1', jobTitles: [{ title: 'T', description: 'd', relevanceReason: 'r' }], skillsByTitle: [] },
      timestamp: Date.now(),
    })
    expect(useSessionStore.getState().jobTitles?.[0].title).toBe('T')
  })

  test('result from RESUME_LEAD populates resumeSections', () => {
    useSessionStore.getState().setFromEvent({
      id: 3, type: 'result', from: AgentRole.RESUME_LEAD,
      payload: { sessionId: 's1', sections: [{ title: 'Summary', content: 'Hi' }] },
      timestamp: Date.now(),
    })
    expect(useSessionStore.getState().resumeSections?.[0].title).toBe('Summary')
  })

  test('events buffer caps at 100', () => {
    for (let i = 0; i < 120; i++) {
      useSessionStore.getState().setFromEvent({
        id: i, type: 'status', from: AgentRole.ORCHESTRATOR,
        payload: { sessionId: 's1', stage: 'intake' },
        timestamp: Date.now(),
      })
    }
    expect(useSessionStore.getState().events).toHaveLength(100)
  })
})
