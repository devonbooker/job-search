import type { AgentRole } from './types'
import type {
  JobTitleResult,
  SkillsResult,
  ResumeSection,
  InterviewFeedback,
} from './types'

export type AgentEventType = 'status' | 'result' | 'error' | 'stage'

export interface AgentEvent {
  id: number
  type: AgentEventType
  from: AgentRole
  payload: unknown
  timestamp: number
}

export type OrchestratorStage =
  | 'idle'
  | 'intake'
  | 'researching'
  | 'building_resume'
  | 'awaiting_resume_approval'
  | 'searching_jobs'
  | 'interview_prep'

export interface Snapshot {
  sessionId: string
  stage: OrchestratorStage
  events: AgentEvent[]
  jobTitles?: JobTitleResult[]
  skillsByTitle?: SkillsResult[]
  resumeSections?: ResumeSection[]
  interviewFeedback?: InterviewFeedback
}
