import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type ResearchDispatchPayload,
  type JobTitleResearchResultPayload,
  type SkillsMarketResearchResultPayload,
  type ResearchResultPayload,
  type UserProfile,
  type JobTitleResult,
  type SkillsMarketResearchDispatchPayload,
} from '../types'
import { OPUS_MODEL } from '../constants'

type ResearchStage = 'awaiting_titles' | 'awaiting_skills'

interface ResearchSession {
  stage: ResearchStage
  profile: UserProfile
  jobTitles?: JobTitleResult[]
}

export class ResearchLead extends BaseAgent {
  readonly role = AgentRole.RESEARCH_LEAD
  readonly model = OPUS_MODEL
  private sessions = new Map<string, ResearchSession>()

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const dispatch = message.payload as ResearchDispatchPayload
      this.sessions.set(dispatch.sessionId, {
        stage: 'awaiting_titles',
        profile: dispatch.profile,
      })
      this.send(AgentRole.JOB_TITLE_RESEARCH, MessageType.DISPATCH, {
        sessionId: dispatch.sessionId,
        profile: dispatch.profile,
      })
      return
    }

    if (message.type === MessageType.RESULT) {
      const p = message.payload as { sessionId: string }
      const session = this.sessions.get(p.sessionId)
      if (!session) return

      if (session.stage === 'awaiting_titles') {
        const result = message.payload as JobTitleResearchResultPayload
        session.jobTitles = result.jobTitles
        session.stage = 'awaiting_skills'
        this.send(AgentRole.SKILLS_MARKET_RESEARCH, MessageType.DISPATCH, {
          sessionId: result.sessionId,
          profile: session.profile,
          jobTitles: result.jobTitles,
        } satisfies SkillsMarketResearchDispatchPayload)
        return
      }

      if (session.stage === 'awaiting_skills') {
        const result = message.payload as SkillsMarketResearchResultPayload
        if (!session.jobTitles) {
          console.error(`[RESEARCH_LEAD] no jobTitles for session ${result.sessionId} at skills stage`)
          return
        }
        this.sessions.delete(result.sessionId)
        this.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, {
          sessionId: result.sessionId,
          jobTitles: session.jobTitles,
          skillsByTitle: result.skillsByTitle,
        } satisfies ResearchResultPayload)
      }
    }
  }
}
