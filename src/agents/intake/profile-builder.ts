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
import { parseClaudeJson } from '../json-extract'

const SYSTEM_PROMPT = `You are a profile structuring assistant. Given raw intake answers, produce a structured JSON profile.
Respond with ONLY a JSON object matching this schema:
{
  "goals": "string - what the user wants in their next role",
  "experience": "string - summary of their background and skills",
  "preferences": "string - location, remote/on-site, company size, etc."
}
Do NOT include the resume text in your response - it is preserved separately.`

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
      max_tokens: 2048,
      system: SYSTEM_PROMPT,
      messages: [{ role: 'user', content: userMessage }],
    })

    const text = response.content.find((b: { type: string }) => b.type === 'text')?.text ?? ''
    const parsed = parseClaudeJson<Omit<UserProfile, 'resumeRaw'>>(text)
    const profile: UserProfile = { ...parsed, resumeRaw: dispatch.resumeRaw ?? null }

    this.send(AgentRole.INTAKE_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      profile,
    } satisfies ProfileBuilderResultPayload)
  }
}
