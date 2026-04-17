import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type SkillsMarketResearchDispatchPayload,
  type SkillsMarketResearchResultPayload,
  type SkillsResult,
} from '../types'
import { SONNET_MODEL } from '../constants'

const SYSTEM_PROMPT = `You are a technical skills researcher. Given job titles and search results from real job postings, extract required and nice-to-have skills.
Respond with ONLY a JSON array matching this schema:
[{ "jobTitle": "string", "requiredSkills": ["string"], "niceToHaveSkills": ["string"] }]
One object per job title. Skills should be specific technologies, tools, or certifications.`

export class SkillsMarketResearch extends BaseAgent {
  readonly role = AgentRole.SKILLS_MARKET_RESEARCH
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

    const dispatch = message.payload as SkillsMarketResearchDispatchPayload
    const snippetsByTitle: Record<string, string> = {}

    for (const jobTitle of dispatch.jobTitles) {
      const query = encodeURIComponent(`required skills ${jobTitle.title} job posting 2024`)
      const url = `https://api.search.brave.com/res/v1/web/search?q=${query}&count=10`
      const response = await this.fetcher(url, {
        headers: {
          Accept: 'application/json',
          'X-Subscription-Token': this.braveApiKey,
        },
      })
      const data = await response.json() as { web?: { results?: { description?: string }[] } }
      snippetsByTitle[jobTitle.title] = data.web?.results?.map(r => r.description ?? '').join('\n') ?? ''
    }

    const searchSummary = Object.entries(snippetsByTitle)
      .map(([title, snippets]) => `${title}:\n${snippets}`)
      .join('\n\n')

    const claudeResponse = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [
        {
          role: 'user',
          content: `Job titles to research: ${dispatch.jobTitles.map(j => j.title).join(', ')}\n\nSearch results:\n${searchSummary}`,
        },
      ],
    })

    const text = claudeResponse.content.find(b => b.type === 'text')?.text ?? ''
    const skillsByTitle = JSON.parse(text) as SkillsResult[]

    this.send(AgentRole.RESEARCH_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      skillsByTitle,
    } satisfies SkillsMarketResearchResultPayload)
  }
}
