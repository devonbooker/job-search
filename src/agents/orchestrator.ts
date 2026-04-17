import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from './base'
import type { MessageQueue } from './queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type IntakeDispatchPayload,
  type ApproveResumePayload,
  type StartInterviewPayload,
  type IntakeResultPayload,
  type ResearchResultPayload,
  type ResumeResultPayload,
  type JobSearchResultPayload,
  type InterviewResultPayload,
  type ResearchDispatchPayload,
  type ResumeDispatchPayload,
  type JobSearchDispatchPayload,
  type InterviewDispatchPayload,
  type UserProfile,
} from './types'
import { OPUS_MODEL } from './constants'

type OrchestratorStage =
  | 'idle'
  | 'intake'
  | 'researching'
  | 'building_resume'
  | 'awaiting_resume_approval'
  | 'searching_jobs'
  | 'interview_prep'

interface SessionState {
  stage: OrchestratorStage
  profile?: UserProfile
  research?: ResearchResultPayload
  resume?: ResumeResultPayload
}

export class Orchestrator extends BaseAgent {
  readonly role = AgentRole.ORCHESTRATOR
  readonly model = OPUS_MODEL
  private sessions = new Map<string, SessionState>()

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const p = message.payload as Record<string, unknown>

      if (typeof p.goals === 'string') {
        const payload = p as unknown as IntakeDispatchPayload
        this.sessions.set(payload.sessionId, { stage: 'intake' })
        this.send(AgentRole.INTAKE_LEAD, MessageType.DISPATCH, payload)
        return
      }

      if (Array.isArray(p.targetTitles) && typeof p.selectedTopic !== 'string') {
        const payload = p as unknown as ApproveResumePayload
        const session = this.sessions.get(payload.sessionId)
        if (!session) return
        session.stage = 'searching_jobs'
        this.send(AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, {
          sessionId: payload.sessionId,
          targetTitles: payload.targetTitles,
        } satisfies JobSearchDispatchPayload)
        return
      }

      if (typeof p.selectedTopic === 'string') {
        const payload = p as unknown as StartInterviewPayload
        const session = this.sessions.get(payload.sessionId)
        if (!session) return
        session.stage = 'interview_prep'
        this.send(AgentRole.INTERVIEW_PREP_LEAD, MessageType.DISPATCH, {
          sessionId: payload.sessionId,
          resumeSections: payload.resumeSections,
          selectedTopic: payload.selectedTopic,
          userAnswer: payload.userAnswer,
        } satisfies InterviewDispatchPayload)
        return
      }
    }

    if (message.type === MessageType.RESULT) {
      switch (message.from_agent) {
        case AgentRole.INTAKE_LEAD: {
          const result = message.payload as IntakeResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.profile = result.profile
          session.stage = 'researching'
          this.send(AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, {
            sessionId: result.sessionId,
            profile: result.profile,
          } satisfies ResearchDispatchPayload)
          break
        }
        case AgentRole.RESEARCH_LEAD: {
          const result = message.payload as ResearchResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.research = result
          session.stage = 'building_resume'
          this.send(AgentRole.RESUME_LEAD, MessageType.DISPATCH, {
            sessionId: result.sessionId,
            profile: session.profile!,
            jobTitles: result.jobTitles,
            skillsByTitle: result.skillsByTitle,
            targetTitles: result.jobTitles.map(j => j.title),
          } satisfies ResumeDispatchPayload)
          break
        }
        case AgentRole.RESUME_LEAD: {
          const result = message.payload as ResumeResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.resume = result
          session.stage = 'awaiting_resume_approval'
          break
        }
        case AgentRole.JOB_SEARCH_LEAD: {
          const result = message.payload as JobSearchResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.stage = 'idle'
          break
        }
        case AgentRole.INTERVIEW_PREP_LEAD: {
          const result = message.payload as InterviewResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.stage = 'awaiting_resume_approval'
          break
        }
      }
    }
  }

  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }
}
