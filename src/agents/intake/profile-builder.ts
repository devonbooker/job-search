import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type ProfileBuilderDispatchPayload,
  type ProfileBuilderResultPayload,
  type UserProfile,
} from '../types'
import { SONNET_MODEL } from '../constants'

const SYSTEM_PROMPT = `You are a profile structuring assistant. Given raw intake answers, produce a structured JSON profile.
Respond with ONLY a JSON object matching this schema:
{
  "goals": "string - what the user wants in their next role",
  "experience": "string - summary of their background and skills",
  "preferences": "string - location, remote/on-site, company size, etc.",
  "resumeRaw": "string | null - the raw resume text if provided, otherwise null"
}`

export class ProfileBuilder extends BaseAgent {
  readonly role = AgentRole.PROFILE_BUILDER
  readonly model = SONNET_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type !== MessageType.DISPATCH) return

    const dispatch = message.payload as ProfileBuilderDispatchPayload

    const userMessage = [
      `Goals: ${dispatch.goals}`,
      `Experience: ${dispatch.experience}`,
      `Preferences: ${dispatch.preferences}`,
      dispatch.resumeRaw ? `Resume:\n${dispatch.resumeRaw}` : '',
    ]
      .filter(Boolean)
      .join('\n\n')

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = response.content.find((b: { type: string }) => b.type === 'text')?.text ?? ''
    const profile = JSON.parse(text) as UserProfile

    this.send(AgentRole.INTAKE_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      profile,
    } satisfies ProfileBuilderResultPayload)
  }
}
