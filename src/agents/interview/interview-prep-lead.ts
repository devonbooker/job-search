import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type InterviewDispatchPayload,
  type InterviewResultPayload,
  type TopicDrillDispatchPayload,
  type TopicDrillResultPayload,
} from '../types'
import { OPUS_MODEL } from '../constants'

export class InterviewPrepLead extends BaseAgent {
  readonly role = AgentRole.INTERVIEW_PREP_LEAD
  readonly model = OPUS_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const dispatch = message.payload as InterviewDispatchPayload
      this.send(AgentRole.TOPIC_DRILL, MessageType.DISPATCH, {
        sessionId: dispatch.sessionId,
        resumeSections: dispatch.resumeSections,
        selectedTopic: dispatch.selectedTopic,
        userAnswer: dispatch.userAnswer,
      } satisfies TopicDrillDispatchPayload)
      return
    }

    if (message.type === MessageType.RESULT) {
      const result = message.payload as TopicDrillResultPayload
      this.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, {
        sessionId: result.sessionId,
        feedback: result.feedback,
      } satisfies InterviewResultPayload)
    }
  }
}
