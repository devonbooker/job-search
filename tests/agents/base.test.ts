import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../../src/agents/base'
import { MessageQueue } from '../../src/agents/queue'
import { AgentRole, MessageType, type Message } from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-base.db'

class TestAgent extends BaseAgent {
  readonly role = AgentRole.INTAKE_LEAD
  readonly model = 'claude-sonnet-4-6'
  receivedMessages: Message[] = []

  async handleMessage(message: Message): Promise<void> {
    this.receivedMessages.push(message)
  }
}

describe('BaseAgent', () => {
  let queue: MessageQueue
  let anthropic: Anthropic
  let agent: TestAgent

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    anthropic = new Anthropic({ apiKey: 'test-key' })
    agent = new TestAgent(queue, anthropic)
  })

  afterEach(() => {
    agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('agent has correct role and model', () => {
    expect(agent.role).toBe(AgentRole.INTAKE_LEAD)
    expect(agent.model).toBe('claude-sonnet-4-6')
  })

  test('send puts a message in the queue for the target agent', () => {
    agent.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, { sessionId: 'abc' })
    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.INTAKE_LEAD)
    expect(msg!.to_agent).toBe(AgentRole.ORCHESTRATOR)
    expect(msg!.type).toBe(MessageType.RESULT)
  })

  test('run processes a queued message via handleMessage', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'x' })

    const runPromise = agent.run()
    await Bun.sleep(200)
    agent.stop()
    await runPromise

    expect(agent.receivedMessages.length).toBe(1)
    expect((agent.receivedMessages[0].payload as { sessionId: string }).sessionId).toBe('x')
  })

  test('run acks the message after handling', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'y' })

    const runPromise = agent.run()
    await Bun.sleep(200)
    agent.stop()
    await runPromise

    const unacked = queue.receive(AgentRole.INTAKE_LEAD)
    expect(unacked).toBeNull()
  })

  test('stop halts the run loop', async () => {
    const runPromise = agent.run()
    agent.stop()
    await expect(runPromise).resolves.toBeUndefined()
  })

  test('run does not ack message if handleMessage throws', async () => {
    class ThrowingAgent extends BaseAgent {
      readonly role = AgentRole.RESEARCH_LEAD
      readonly model = 'claude-sonnet-4-6'
      async handleMessage(): Promise<void> {
        throw new Error('boom')
      }
    }
    const throwing = new ThrowingAgent(queue, anthropic)
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, { sessionId: 'z' })

    const runPromise = throwing.run()
    await Bun.sleep(300)
    throwing.stop()
    await runPromise

    const stillThere = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(stillThere).not.toBeNull()
  })
})
