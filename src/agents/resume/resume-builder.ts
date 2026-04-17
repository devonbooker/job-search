import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type ResumeBuildDispatchPayload,
  type ResumeBuildResultPayload,
  type ResumeSection,
} from '../types'
import { SONNET_MODEL } from '../constants'

const SYSTEM_PROMPT = `You are an expert resume writer. Build a tailored resume that maps the user's experience to the target job titles and required skills.
Respond with ONLY a JSON array of resume sections:
[{ "title": "string", "content": "string OR [{ \"text\": \"string\" }]" }]
Use bullet items (array) for Experience and Skills sections. Use a plain string for the Summary section.
Sections: Summary, Skills, Experience. Keep bullets concise and achievement-focused.`

export class ResumeBuilder extends BaseAgent {
  readonly role = AgentRole.RESUME_BUILDER
  readonly model = SONNET_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type !== MessageType.DISPATCH) return

    const dispatch = message.payload as ResumeBuildDispatchPayload

    const skillsSummary = dispatch.skillsByTitle
      .filter(s => dispatch.targetTitles.includes(s.jobTitle))
      .map(s => `${s.jobTitle}: required - ${s.requiredSkills.join(', ')}; nice to have - ${s.niceToHaveSkills.join(', ')}`)
      .join('\n')

    const userContent = [
      `User Goals: ${dispatch.profile.goals}`,
      `Experience: ${dispatch.profile.experience}`,
      `Target Job Titles: ${dispatch.targetTitles.join(', ')}`,
      `Required Skills by Title:\n${skillsSummary}`,
      dispatch.profile.resumeRaw ? `Existing Resume:\n${dispatch.profile.resumeRaw}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    let sections: ResumeSection[]
    try {
      sections = JSON.parse(text) as ResumeSection[]
    } catch {
      throw new Error(`ResumeBuilder: Claude returned invalid JSON: ${text.slice(0, 100)}`)
    }

    this.send(AgentRole.RESUME_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      sections,
    } satisfies ResumeBuildResultPayload)
  }
}
