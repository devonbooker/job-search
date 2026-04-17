import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type JobSearchDispatchPayload,
  type JobSearchResultPayload,
  type AdzunaSearchDispatchPayload,
  type AdzunaSearchResultPayload,
} from '../types'
import { OPUS_MODEL } from '../constants'

export class JobSearchLead extends BaseAgent {
  readonly role = AgentRole.JOB_SEARCH_LEAD
  readonly model = OPUS_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const dispatch = message.payload as JobSearchDispatchPayload
      this.send(AgentRole.ADZUNA_SEARCH, MessageType.DISPATCH, {
        sessionId: dispatch.sessionId,
        targetTitles: dispatch.targetTitles,
      } satisfies AdzunaSearchDispatchPayload)
      return
    }

    if (message.type === MessageType.RESULT) {
      const result = message.payload as AdzunaSearchResultPayload
      this.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, {
        sessionId: result.sessionId,
        jobsFound: result.jobsFound,
      } satisfies JobSearchResultPayload)
    }
  }
}
