import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type ResearchDispatchPayload,
  type JobTitleResearchResultPayload,
  type JobTitleResearchDispatchPayload,
  type SkillsMarketResearchResultPayload,
  type ResearchResultPayload,
  type UserProfile,
  type JobTitleResult,
  type SkillsMarketResearchDispatchPayload,
} from '../types'
import { OPUS_MODEL } from '../constants'
import { SessionStore } from '../session-store'

type ResearchStage = 'awaiting_titles' | 'awaiting_skills'

export interface ResearchSession {
  stage: ResearchStage
  profile: UserProfile
  jobTitles?: JobTitleResult[]
}

export class ResearchLead extends BaseAgent {
  readonly role = AgentRole.RESEARCH_LEAD
  readonly model = OPUS_MODEL
  private sessions = new Map<string, ResearchSession>()

  constructor(
    queue: MessageQueue,
    anthropic: Anthropic,
    private readonly store: SessionStore<ResearchSession>,
    private readonly adzunaAppId: string = process.env.ADZUNA_APP_ID ?? '',
    private readonly adzunaAppKey: string = process.env.ADZUNA_APP_KEY ?? '',
    private readonly fetcher: typeof fetch = globalThis.fetch,
  ) {
    super(queue, anthropic)
  }

  private async fetchTitleStats(titles: JobTitleResult[]): Promise<JobTitleResult[]> {
    return Promise.all(titles.map(async (jt) => {
      if (!this.adzunaAppId || !this.adzunaAppKey) return jt
      try {
        const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${this.adzunaAppId}&app_key=${this.adzunaAppKey}&what=${encodeURIComponent(jt.title)}&results_per_page=10`
        const res = await this.fetcher(url, { headers: { Accept: 'application/json' } })
        if (!res.ok) {
          console.warn(`[RESEARCH_LEAD] Adzuna stats ${res.status} for "${jt.title}"`)
          return jt
        }
        const data = await res.json() as {
          count?: number
          results?: { salary_min?: number; salary_max?: number }[]
        }
        const salaried = (data.results ?? []).filter(j => typeof j.salary_min === 'number' && typeof j.salary_max === 'number')
        const avgSalaryUsd = salaried.length > 0
          ? Math.round(salaried.reduce((sum, j) => sum + ((j.salary_min! + j.salary_max!) / 2), 0) / salaried.length)
          : undefined
        return { ...jt, openingsCount: data.count, avgSalaryUsd }
      } catch (err) {
        console.warn(`[RESEARCH_LEAD] Adzuna stats fetch error for "${jt.title}":`, err)
        return jt
      }
    }))
  }

  async run(): Promise<void> {
    this.sessions = await this.store.loadAll()
    return super.run()
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type === MessageType.DISPATCH) {
      const dispatch = message.payload as ResearchDispatchPayload
      this.sessions.set(dispatch.sessionId, {
        stage: 'awaiting_titles',
        profile: dispatch.profile,
      })
      await this.store.save(dispatch.sessionId, { stage: 'awaiting_titles', profile: dispatch.profile })
      this.send(AgentRole.HTTP_API, MessageType.STATUS, {
        sessionId: dispatch.sessionId,
        stage: 'researching',
        agent: AgentRole.RESEARCH_LEAD,
        message: 'researching job titles + skills',
      })
      this.send(AgentRole.JOB_TITLE_RESEARCH, MessageType.DISPATCH, {
        sessionId: dispatch.sessionId,
        profile: dispatch.profile,
      } satisfies JobTitleResearchDispatchPayload)
      return
    }

    if (message.type === MessageType.RESULT) {
      const p = message.payload as { sessionId: string }
      const session = this.sessions.get(p.sessionId)
      if (!session) return

      if (session.stage === 'awaiting_titles') {
        const result = message.payload as JobTitleResearchResultPayload
        const enriched = await this.fetchTitleStats(result.jobTitles)
        session.jobTitles = enriched
        session.stage = 'awaiting_skills'
        await this.store.save(p.sessionId, session)
        this.send(AgentRole.SKILLS_MARKET_RESEARCH, MessageType.DISPATCH, {
          sessionId: result.sessionId,
          profile: session.profile,
          jobTitles: enriched,
        } satisfies SkillsMarketResearchDispatchPayload)
        return
      }

      if (session.stage === 'awaiting_skills') {
        const result = message.payload as SkillsMarketResearchResultPayload
        if (!session.jobTitles) {
          console.error(`[RESEARCH_LEAD] no jobTitles for session ${result.sessionId} at skills stage`)
          this.sessions.delete(result.sessionId)
          await this.store.delete(result.sessionId)
          return
        }
        this.sessions.delete(result.sessionId)
        await this.store.delete(result.sessionId)
        this.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, {
          sessionId: result.sessionId,
          jobTitles: session.jobTitles,
          skillsByTitle: result.skillsByTitle,
        } satisfies ResearchResultPayload)
      }
    }
  }
}
