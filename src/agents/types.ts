export enum AgentRole {
  ORCHESTRATOR = 'ORCHESTRATOR',
  INTAKE_LEAD = 'INTAKE_LEAD',
  PROFILE_BUILDER = 'PROFILE_BUILDER',
  RESEARCH_LEAD = 'RESEARCH_LEAD',
  JOB_TITLE_RESEARCH = 'JOB_TITLE_RESEARCH',
  SKILLS_MARKET_RESEARCH = 'SKILLS_MARKET_RESEARCH',
  RESUME_LEAD = 'RESUME_LEAD',
  RESUME_BUILDER = 'RESUME_BUILDER',
  JOB_SEARCH_LEAD = 'JOB_SEARCH_LEAD',
  ADZUNA_SEARCH = 'ADZUNA_SEARCH',
  INTERVIEW_PREP_LEAD = 'INTERVIEW_PREP_LEAD',
  TOPIC_DRILL = 'TOPIC_DRILL',
}

export enum MessageType {
  DISPATCH = 'DISPATCH',
  RESULT = 'RESULT',
  STATUS = 'STATUS',
  ERROR = 'ERROR',
}

export interface Message {
  id: string
  from_agent: AgentRole
  to_agent: AgentRole
  type: MessageType
  payload: unknown
  created_at: number
  acked_at: number | null
}

export interface UserProfile {
  goals: string
  experience: string
  resumeRaw: string | null
  preferences: string
}

export interface JobTitleResult {
  title: string
  description: string
  relevanceReason: string
}

export interface SkillsResult {
  jobTitle: string
  requiredSkills: string[]
  niceToHaveSkills: string[]
}

export interface BulletItem {
  text: string
}

export interface ResumeSection {
  title: string
  content: string | BulletItem[]
}

export interface InterviewFeedback {
  question: string
  feedback: string
  clarity: 'strong' | 'adequate' | 'weak'
  specificity: 'strong' | 'adequate' | 'weak'
}

// Dispatch payloads (Orchestrator -> Lead, Lead -> Sub)
export interface DispatchIntakePayload {
  sessionId: string
}

export interface DispatchResearchPayload {
  sessionId: string
  profile: UserProfile
}

export interface DispatchResumePayload {
  sessionId: string
  profile: UserProfile
  jobTitles: JobTitleResult[]
  skillsByTitle: SkillsResult[]
  targetTitles: string[]
}

export interface DispatchJobSearchPayload {
  sessionId: string
  targetTitles: string[]
}

export interface DispatchInterviewPayload {
  sessionId: string
  resumeSections: ResumeSection[]
  selectedTopic: string
  userAnswer?: string
}

// Result payloads (Lead -> Orchestrator, Sub -> Lead)
export interface IntakeResultPayload {
  sessionId: string
  profile: UserProfile
}

export interface ResearchResultPayload {
  sessionId: string
  jobTitles: JobTitleResult[]
  skillsByTitle: SkillsResult[]
}

export interface ResumeResultPayload {
  sessionId: string
  sections: ResumeSection[]
}

export interface JobSearchResultPayload {
  sessionId: string
  jobsFound: number
}

export interface InterviewResultPayload {
  sessionId: string
  feedback: InterviewFeedback
}

export interface StatusPayload {
  sessionId: string
  agent: AgentRole
  message: string
}

export interface ErrorPayload {
  sessionId: string
  agent: AgentRole
  error: string
}
