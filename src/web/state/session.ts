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
      if (evt.from === AgentRole.RESEARCH_LEAD) {
        const r = evt.payload as ResearchResultPayload
        patch.jobTitles = r.jobTitles
        patch.skillsByTitle = r.skillsByTitle
      }
      if (evt.from === AgentRole.RESUME_LEAD) {
        patch.resumeSections = (evt.payload as ResumeResultPayload).sections
      }
      if (evt.from === AgentRole.INTERVIEW_PREP_LEAD) {
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
