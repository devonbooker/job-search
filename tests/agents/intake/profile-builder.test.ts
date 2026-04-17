import { describe, test, expect, afterEach } from 'bun:test'
import { mock } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { ProfileBuilder } from '../../../src/agents/intake/profile-builder'
import { MessageQueue } from '../../../src/agents/queue'
import { AgentRole, MessageType, type ProfileBuilderDispatchPayload } from '../../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-profile-builder.db'

function makeAnthropic(responseText: string): Anthropic {
  return {
    messages: {
      create: mock(async () => ({
        content: [{ type: 'text', text: responseText }],
      })),
    },
  } as unknown as Anthropic
}

describe('ProfileBuilder', () => {
  let queue: MessageQueue
  let agent: ProfileBuilder

  afterEach(async () => {
    await agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('sends ProfileBuilderResultPayload back to IntakeLead after Claude call', async () => {
    const mockProfile = {
      goals: 'security engineer at a startup',
      experience: '5 years backend engineering',
      preferences: 'remote, SF bay area',
      resumeRaw: null,
    }
    queue = new MessageQueue(TEST_DB)
    agent = new ProfileBuilder(queue, makeAnthropic(JSON.stringify(mockProfile)))

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.PROFILE_BUILDER, MessageType.DISPATCH, {
      sessionId: 'pb-1',
      goals: 'security engineer at a startup',
      experience: '5 years backend engineering',
      preferences: 'remote, SF bay area',
    } satisfies ProfileBuilderDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const result = queue.receive(AgentRole.INTAKE_LEAD)
    expect(result).not.toBeNull()
    expect(result!.from_agent).toBe(AgentRole.PROFILE_BUILDER)
    expect(result!.type).toBe(MessageType.RESULT)
    const payload = result!.payload as { sessionId: string; profile: typeof mockProfile }
    expect(payload.sessionId).toBe('pb-1')
    expect(payload.profile.goals).toBe(mockProfile.goals)
  })

  test('retries if Claude returns invalid JSON', async () => {
    let callCount = 0
    const validProfile = { goals: 'g', experience: 'e', preferences: 'p', resumeRaw: null }
    const anthropic = {
      messages: {
        create: mock(async () => {
          callCount++
          const text = callCount === 1 ? 'not json' : JSON.stringify(validProfile)
          return { content: [{ type: 'text', text }] }
        }),
      },
    } as unknown as Anthropic

    queue = new MessageQueue(TEST_DB)
    agent = new ProfileBuilder(queue, anthropic)

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.PROFILE_BUILDER, MessageType.DISPATCH, {
      sessionId: 'pb-2',
      goals: 'g',
      experience: 'e',
      preferences: 'p',
    } satisfies ProfileBuilderDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(500)
    await agent.stop()
    await runPromise

    expect(callCount).toBeGreaterThanOrEqual(2)
    const result = queue.receive(AgentRole.INTAKE_LEAD)
    expect(result).not.toBeNull()
  })

  test('includes resumeRaw in Claude prompt when provided', async () => {
    let capturedMessages: unknown[] = []
    const anthropic = {
      messages: {
        create: mock(async (params: { messages: unknown[] }) => {
          capturedMessages = params.messages
          return {
            content: [{
              type: 'text',
              text: JSON.stringify({ goals: 'g', experience: 'e', preferences: 'p', resumeRaw: 'resume text here' }),
            }],
          }
        }),
      },
    } as unknown as Anthropic

    queue = new MessageQueue(TEST_DB)
    agent = new ProfileBuilder(queue, anthropic)

    queue.send(AgentRole.INTAKE_LEAD, AgentRole.PROFILE_BUILDER, MessageType.DISPATCH, {
      sessionId: 'pb-3',
      goals: 'g',
      experience: 'e',
      preferences: 'p',
      resumeRaw: 'resume text here',
    } satisfies ProfileBuilderDispatchPayload)

    const runPromise = agent.run()
    await Bun.sleep(300)
    await agent.stop()
    await runPromise

    const userContent = JSON.stringify(capturedMessages)
    expect(userContent).toContain('resume text here')
  })
})
