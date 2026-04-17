import Anthropic from '@anthropic-ai/sdk'
import type { Pool } from 'pg'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type AdzunaSearchDispatchPayload,
  type AdzunaSearchResultPayload,
} from '../types'
import { SONNET_MODEL } from '../constants'

interface AdzunaJob {
  title: string
  company: { display_name: string }
  redirect_url: string
}

export class AdzunaSearch extends BaseAgent {
  readonly role = AgentRole.ADZUNA_SEARCH
  readonly model = SONNET_MODEL

  constructor(
    queue: MessageQueue,
    anthropic: Anthropic,
    private readonly pool: Pool,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly appId: string = process.env.ADZUNA_APP_ID ?? '',
    private readonly appKey: string = process.env.ADZUNA_APP_KEY ?? '',
  ) {
    super(queue, anthropic)
    if (!this.appId || !this.appKey) {
      throw new Error('ADZUNA_APP_ID and ADZUNA_APP_KEY must be set')
    }
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type !== MessageType.DISPATCH) return

    const dispatch = message.payload as AdzunaSearchDispatchPayload
    const allJobs: AdzunaJob[] = []
    let successCount = 0

    for (const title of dispatch.targetTitles) {
      try {
        const query = encodeURIComponent(title)
        const url = `https://api.adzuna.com/v1/api/jobs/us/search/1?app_id=${this.appId}&app_key=${this.appKey}&what=${query}&results_per_page=50`
        const response = await this.fetcher(url, {
          headers: { Accept: 'application/json' },
        })
        if (!response.ok) {
          console.error(`[ADZUNA_SEARCH] HTTP ${response.status} for title "${title}"`)
          continue
        }
        const data = await response.json() as { results?: AdzunaJob[] }
        const valid = (data.results ?? []).filter(
          j => j?.redirect_url && j?.title && j?.company?.display_name
        )
        allJobs.push(...valid)
        successCount++
      } catch (err) {
        console.error(`[ADZUNA_SEARCH] fetch error for title "${title}":`, err)
      }
    }

    if (successCount === 0 && dispatch.targetTitles.length > 0) {
      throw new Error('[ADZUNA_SEARCH] all title fetches failed, will retry')
    }

    const seen = new Set<string>()
    const unique = allJobs.filter(job => {
      if (seen.has(job.redirect_url)) return false
      seen.add(job.redirect_url)
      return true
    })

    for (const job of unique) {
      await this.pool.query(
        `INSERT INTO jobs (job_title, company, link, source) VALUES ($1, $2, $3, $4) ON CONFLICT (link) DO NOTHING`,
        [job.title, job.company.display_name, job.redirect_url, 'adzuna'],
      )
    }

    this.send(AgentRole.JOB_SEARCH_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      jobsFound: unique.length,
    } satisfies AdzunaSearchResultPayload)
  }
}
