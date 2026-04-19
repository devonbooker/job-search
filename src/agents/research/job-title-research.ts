import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type JobTitleResearchDispatchPayload,
  type JobTitleResearchResultPayload,
  type JobTitleResult,
} from '../types'
import { SONNET_MODEL } from '../constants'
import { parseClaudeJson } from '../json-extract'

const SYSTEM_PROMPT = `You are a job market researcher. Given a user profile and search results, identify the most relevant current job titles.
Respond with ONLY a JSON array of objects matching this schema:
[{ "title": "string", "description": "string - one sentence", "relevanceReason": "string - why this fits the profile" }]
Return 3-6 titles. Focus on titles actively used in job postings today.`

export class JobTitleResearch extends BaseAgent {
  readonly role = AgentRole.JOB_TITLE_RESEARCH
  readonly model = SONNET_MODEL

  constructor(
    queue: MessageQueue,
    anthropic: Anthropic,
    private readonly fetcher: typeof fetch = globalThis.fetch,
    private readonly braveApiKey: string = process.env.BRAVE_SEARCH_API_KEY ?? '',
  ) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type !== MessageType.DISPATCH) return

    const dispatch = message.payload as JobTitleResearchDispatchPayload
    const { profile } = dispatch

    const query = encodeURIComponent(`job titles for ${profile.goals} ${profile.experience} ${new Date().getFullYear()}`)
    const url = `https://api.search.brave.com/res/v1/web/search?q=${query}&count=10`
    const response = await this.fetcher(url, {
      headers: {
        Accept: 'application/json',
        'X-Subscription-Token': this.braveApiKey,
      },
    })

    if (!response.ok) {
      throw new Error(`Brave Search error: ${response.status}`)
    }

    const data = await response.json() as { web?: { results?: { description?: string }[] } }
    const snippets = data.web?.results?.map(r => r.description ?? '').join('\n') ?? ''

    const claudeResponse = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `User profile:\nGoals: ${profile.goals}\nExperience: ${profile.experience}\nPreferences: ${profile.preferences}\n\nSearch results:\n${snippets}`,
        },
      ],
    })

    const text = claudeResponse.content.find(b => b.type === 'text')?.text ?? ''
    let jobTitles: JobTitleResult[]
    try {
      jobTitles = parseClaudeJson<JobTitleResult[]>(text)
    } catch {
      throw new Error(`JobTitleResearch: Claude returned invalid JSON: ${text.slice(0, 100)}`)
    }

    this.send(AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      jobTitles,
    } satisfies JobTitleResearchResultPayload)
  }
}
