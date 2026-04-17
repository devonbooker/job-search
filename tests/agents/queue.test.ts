import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MessageQueue } from '../../src/agents/queue'
import { AgentRole, MessageType } from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-queue.db'

describe('MessageQueue', () => {
  let queue: MessageQueue

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('send adds a message to the queue', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'abc' })
    const msg = queue.receive(AgentRole.INTAKE_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
    expect(msg!.to_agent).toBe(AgentRole.INTAKE_LEAD)
    expect(msg!.type).toBe(MessageType.DISPATCH)
    expect(msg!.payload).toEqual({ sessionId: 'abc' })
  })

  test('receive returns null when no messages', () => {
    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).toBeNull()
  })

  test('receive returns only unacked messages', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, { sessionId: '1' })
    const msg = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg).not.toBeNull()
    queue.ack(msg!.id)
    const msg2 = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg2).toBeNull()
  })

  test('receive returns oldest message first', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESUME_LEAD, MessageType.DISPATCH, { sessionId: 'first' })
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESUME_LEAD, MessageType.DISPATCH, { sessionId: 'second' })
    const msg = queue.receive(AgentRole.RESUME_LEAD)
    expect((msg!.payload as { sessionId: string }).sessionId).toBe('first')
  })

  test('receive does not return messages intended for other agents', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'x' })
    const msg = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg).toBeNull()
  })

  test('ack marks message as acknowledged', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, { sessionId: 'y' })
    const msg = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    queue.ack(msg!.id)
    const row = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    expect(row).toBeNull()
  })

  test('payload is deserialized from JSON', () => {
    const payload = { sessionId: 'z', nested: { key: 'value' }, arr: [1, 2, 3] }
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTERVIEW_PREP_LEAD, MessageType.DISPATCH, payload)
    const msg = queue.receive(AgentRole.INTERVIEW_PREP_LEAD)
    expect(msg!.payload).toEqual(payload)
  })
})
