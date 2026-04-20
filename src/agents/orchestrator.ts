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
  type ErrorPayload,
} from './types'
import { OPUS_MODEL } from './constants'
import type { OrchestratorStage } from './events'
import { SessionStore } from './session-store'

export interface SessionState {
  stage: OrchestratorStage
  profile?: UserProfile
  research?: ResearchResultPayload
  resume?: ResumeResultPayload
}

export class Orchestrator extends BaseAgent {
  readonly role = AgentRole.ORCHESTRATOR
  readonly model = OPUS_MODEL
  private sessions = new Map<string, SessionState>()

  constructor(
    queue: MessageQueue,
    anthropic: Anthropic,
    private readonly store: SessionStore<SessionState>,
  ) {
    super(queue, anthropic)
  }

  async run(): Promise<void> {
    this.sessions = await this.store.loadAll()
    return super.run()
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const p = message.payload as Record<string, unknown>

      if (typeof p.goals === 'string') {
        const payload = p as unknown as IntakeDispatchPayload
        this.sessions.set(payload.sessionId, { stage: 'intake' })
        await this.store.save(payload.sessionId, { stage: 'intake' }, 'intake')
        this.emitStatus(payload.sessionId, 'intake')
        this.send(AgentRole.INTAKE_LEAD, MessageType.DISPATCH, payload)
        return
      }

      if (Array.isArray(p.targetTitles) && !('selectedTopic' in p)) {
        const payload = p as unknown as ApproveResumePayload
        const session = this.sessions.get(payload.sessionId)
        if (!session) {
          this.emitUnknownSessionError(payload.sessionId)
          return
        }
        session.stage = 'searching_jobs'
        await this.store.save(payload.sessionId, session, 'searching_jobs')
        this.emitStatus(payload.sessionId, 'searching_jobs')
        this.send(AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, {
          sessionId: payload.sessionId,
          targetTitles: payload.targetTitles,
        } satisfies JobSearchDispatchPayload)
        return
      }

      if (typeof p.selectedTopic === 'string') {
        const payload = p as unknown as StartInterviewPayload
        const session = this.sessions.get(payload.sessionId)
        if (!session) {
          this.emitUnknownSessionError(payload.sessionId)
          return
        }
        session.stage = 'interview_prep'
        await this.store.save(payload.sessionId, session, 'interview_prep')
        this.emitStatus(payload.sessionId, 'interview_prep')
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
          await this.store.save(result.sessionId, session, 'researching')
          this.emitStatus(result.sessionId, 'researching')
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
          await this.store.save(result.sessionId, session, 'building_resume')
          this.emitStatus(result.sessionId, 'building_resume')
          this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
          if (!session.profile) {
            console.error(`[ORCHESTRATOR] no profile for session ${result.sessionId}`)
            return
          }
          this.send(AgentRole.RESUME_LEAD, MessageType.DISPATCH, {
            sessionId: result.sessionId,
            profile: session.profile,
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
          await this.store.save(result.sessionId, session, 'awaiting_resume_approval')
          this.emitStatus(result.sessionId, 'awaiting_resume_approval')
          this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
          break
        }
        case AgentRole.JOB_SEARCH_LEAD: {
          const result = message.payload as JobSearchResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.stage = 'idle'
          this.emitStatus(result.sessionId, 'idle')
          this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
          this.sessions.delete(result.sessionId)
          await this.store.delete(result.sessionId)
          break
        }
        case AgentRole.INTERVIEW_PREP_LEAD: {
          const result = message.payload as InterviewResultPayload
          const session = this.sessions.get(result.sessionId)
          if (!session) return
          session.stage = 'interview_prep'
          this.emitStatus(result.sessionId, 'interview_prep')
          this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
          this.sessions.delete(result.sessionId)
          await this.store.delete(result.sessionId)
          break
        }
        default:
          console.warn(`[ORCHESTRATOR] unexpected RESULT from ${message.from_agent}`)
      }
    }
  }

  private emitStatus(sessionId: string, stage: OrchestratorStage): void {
    this.send(AgentRole.HTTP_API, MessageType.STATUS, {
      sessionId,
      stage,
      agent: AgentRole.ORCHESTRATOR,
    })
  }

  private emitUnknownSessionError(sessionId: string): void {
    this.send(AgentRole.HTTP_API, MessageType.ERROR, {
      sessionId,
      agent: AgentRole.ORCHESTRATOR,
      error: `Unknown session: ${sessionId}`,
      message: `Unknown session: ${sessionId} (server likely restarted - start a new intake)`,
    } as ErrorPayload & { message: string })
  }

  getSessionState(sessionId: string): SessionState | undefined {
    return this.sessions.get(sessionId)
  }
}
