import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from './base'
import type { MessageQueue } from './queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type IntakeDispatchPayload,
  type ApproveResumePayload,
  type SelectTitlesPayload,
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
  targetTitles?: string[]
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
        // SelectTitles - happens at awaiting_title_selection; advances to building_resume
        const payload = p as unknown as SelectTitlesPayload
        const session = this.sessions.get(payload.sessionId)
        if (!session) {
          this.emitUnknownSessionError(payload.sessionId)
          return
        }
        if (session.stage !== 'awaiting_title_selection') {
          console.warn(`[ORCHESTRATOR] SelectTitles for ${payload.sessionId} in wrong stage ${session.stage}; ignoring`)
          return
        }
        if (!session.research || !session.profile) {
          console.error(`[ORCHESTRATOR] missing research/profile for ${payload.sessionId} at SelectTitles`)
          return
        }
        session.targetTitles = payload.targetTitles
        session.stage = 'building_resume'
        await this.store.save(payload.sessionId, session, 'building_resume')
        this.emitStatus(payload.sessionId, 'building_resume')
        this.send(AgentRole.RESUME_LEAD, MessageType.DISPATCH, {
          sessionId: payload.sessionId,
          profile: session.profile,
          jobTitles: session.research.jobTitles,
          skillsByTitle: session.research.skillsByTitle,
          targetTitles: payload.targetTitles,
        } satisfies ResumeDispatchPayload)
        return
      }

      if ('sessionId' in p && Object.keys(p).length === 1) {
        // ApproveResume - empty body besides sessionId; happens at awaiting_resume_approval
        const payload = p as unknown as ApproveResumePayload
        const session = this.sessions.get(payload.sessionId)
        if (!session) {
          this.emitUnknownSessionError(payload.sessionId)
          return
        }
        if (session.stage !== 'awaiting_resume_approval') {
          console.warn(`[ORCHESTRATOR] ApproveResume for ${payload.sessionId} in wrong stage ${session.stage}; ignoring`)
          return
        }
        if (!session.targetTitles || session.targetTitles.length === 0) {
          console.error(`[ORCHESTRATOR] no targetTitles stored for ${payload.sessionId} at ApproveResume`)
          return
        }
        session.stage = 'searching_jobs'
        await this.store.save(payload.sessionId, session, 'searching_jobs')
        this.emitStatus(payload.sessionId, 'searching_jobs')
        this.send(AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, {
          sessionId: payload.sessionId,
          targetTitles: session.targetTitles,
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
          session.stage = 'awaiting_title_selection'
          await this.store.save(result.sessionId, session, 'awaiting_title_selection')
          this.emitStatus(result.sessionId, 'awaiting_title_selection')
          this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
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
          await this.store.save(result.sessionId, session, 'interview_prep')
          this.emitStatus(result.sessionId, 'interview_prep')
          this.send(AgentRole.HTTP_API, MessageType.RESULT, result)
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
