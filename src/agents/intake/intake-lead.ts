import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type IntakeDispatchPayload,
  type IntakeResultPayload,
  type ProfileBuilderDispatchPayload,
} from '../types'
import { OPUS_MODEL } from '../constants'

export class IntakeLead extends BaseAgent {
  readonly role = AgentRole.INTAKE_LEAD
  readonly model = OPUS_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const dispatch = message.payload as IntakeDispatchPayload
      this.send(AgentRole.PROFILE_BUILDER, MessageType.DISPATCH, {
        sessionId: dispatch.sessionId,
        goals: dispatch.goals,
        experience: dispatch.experience,
        preferences: dispatch.preferences,
        resumeRaw: dispatch.resumeRaw,
      } satisfies ProfileBuilderDispatchPayload)
      return
    }

    if (message.type === MessageType.RESULT) {
      if (message.from_agent !== AgentRole.PROFILE_BUILDER) return
      const result = message.payload as IntakeResultPayload
      this.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, result)
    }
  }
}
