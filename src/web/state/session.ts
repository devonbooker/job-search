import { create } from 'zustand'
import { AgentRole } from '../../agents/types'
import type {
  JobTitleResult, SkillsResult, ResumeSection, InterviewFeedback,
  ResearchResultPayload, ResumeResultPayload, InterviewResultPayload,
} from '../../agents/types'
import type { AgentEvent, OrchestratorStage, Snapshot } from '../../agents/events'

interface State {
  sessionId: string | null
  stage: OrchestratorStage
  jobTitles?: JobTitleResult[]
  skillsByTitle?: SkillsResult[]
  resumeSections?: ResumeSection[]
  interviewQuestion?: string
  interviewFeedback?: InterviewFeedback
  events: AgentEvent[]
  setSessionId(id: string | null): void
  setInterviewQuestion(q: string): void
  setInterviewFeedback(f: InterviewFeedback | undefined): void
  setFromSnapshot(snap: Snapshot): void
  setFromEvent(evt: AgentEvent): void
  reset(): void
}

const EVENTS_CAP = 100

export const useSessionStore = create<State>((set) => ({
  sessionId: null,
  stage: 'idle',
  events: [],
  setSessionId: (id) => set({ sessionId: id }),
  setInterviewQuestion: (q) => set({ interviewQuestion: q }),
  setInterviewFeedback: (f) => set({ interviewFeedback: f }),
  setFromSnapshot: (snap) => set({
    sessionId: snap.sessionId,
    stage: snap.stage,
    jobTitles: snap.jobTitles,
    skillsByTitle: snap.skillsByTitle,
    resumeSections: snap.resumeSections,
    interviewFeedback: snap.interviewFeedback,
    events: snap.events.slice(-EVENTS_CAP),
  }),
  setFromEvent: (evt) => set((state) => {
    const patch: Partial<State> = {
      events: [...state.events, evt].slice(-EVENTS_CAP),
    }
    const p = evt.payload as Record<string, unknown>
    if (typeof p.stage === 'string') patch.stage = p.stage as OrchestratorStage

    if (evt.type === 'result') {
      if (Array.isArray(p.jobTitles)) {
        patch.jobTitles = (evt.payload as ResearchResultPayload).jobTitles
        patch.skillsByTitle = (evt.payload as ResearchResultPayload).skillsByTitle
      }
      if (Array.isArray(p.sections)) {
        patch.resumeSections = (evt.payload as ResumeResultPayload).sections
      }
      if (p.feedback && typeof p.feedback === 'object') {
        patch.interviewFeedback = (evt.payload as InterviewResultPayload).feedback
      }
    }
    if (evt.from === AgentRole.INTERVIEW_PREP_LEAD && evt.type === 'status') {
      const q = (evt.payload as { question?: string }).question
      if (q) patch.interviewQuestion = q
    }
    return patch
  }),
  reset: () => set({
    sessionId: null,
    stage: 'idle',
    jobTitles: undefined,
    skillsByTitle: undefined,
    resumeSections: undefined,
    interviewQuestion: undefined,
    interviewFeedback: undefined,
    events: [],
  }),
}))
