import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type ResumeDispatchPayload,
  type ResumeResultPayload,
  type ResumeBuildDispatchPayload,
  type ResumeBuildResultPayload,
} from '../types'
import { OPUS_MODEL } from '../constants'

export class ResumeLead extends BaseAgent {
  readonly role = AgentRole.RESUME_LEAD
  readonly model = OPUS_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const dispatch = message.payload as ResumeDispatchPayload
      this.send(AgentRole.RESUME_BUILDER, MessageType.DISPATCH, {
        sessionId: dispatch.sessionId,
        profile: dispatch.profile,
        jobTitles: dispatch.jobTitles,
        skillsByTitle: dispatch.skillsByTitle,
        targetTitles: dispatch.targetTitles,
      } satisfies ResumeBuildDispatchPayload)
      return
    }

    if (message.type === MessageType.RESULT) {
      if (message.from_agent !== AgentRole.RESUME_BUILDER) return
      const result = message.payload as ResumeBuildResultPayload
      this.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, {
        sessionId: result.sessionId,
        sections: result.sections,
      } satisfies ResumeResultPayload)
    }
  }
}
