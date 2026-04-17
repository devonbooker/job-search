import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../base'
import type { MessageQueue } from '../queue'
import {
  AgentRole,
  MessageType,
  type Message,
  type TopicDrillDispatchPayload,
  type TopicDrillResultPayload,
  type InterviewFeedback,
  type ResumeSection,
  type BulletItem,
} from '../types'
import { SONNET_MODEL } from '../constants'

const GENERATE_SYSTEM = `You are an interview coach generating a targeted interview question.
Given a resume topic and context, generate one behavioral or technical question.
Respond with ONLY a JSON object:
{ "question": "string", "feedback": "", "clarity": "strong", "specificity": "strong" }
The feedback and rating fields will be filled after the user answers. Set them to empty string / "strong" as placeholders.`

const EVALUATE_SYSTEM = `You are an interview coach evaluating a candidate's answer.
Given the question, the user's answer, and their resume context, provide structured feedback.
Respond with ONLY a JSON object:
{ "question": "string (the original question)", "feedback": "string - 2-3 sentences on what was strong and what was missing", "clarity": "strong|adequate|weak", "specificity": "strong|adequate|weak" }`

function sectionsToText(sections: ResumeSection[]): string {
  return sections
    .map(s => {
      const content = Array.isArray(s.content)
        ? (s.content as BulletItem[]).map(b => `- ${b.text}`).join('\n')
        : s.content
      return `${s.title}:\n${content}`
    })
    .join('\n\n')
}

export class TopicDrill extends BaseAgent {
  readonly role = AgentRole.TOPIC_DRILL
  readonly model = SONNET_MODEL

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    super(queue, anthropic)
  }

  async handleMessage(message: Message): Promise<void> {
    if (message.type !== MessageType.DISPATCH) return

    const dispatch = message.payload as TopicDrillDispatchPayload
    const resumeContext = sectionsToText(dispatch.resumeSections)

    let system: string
    let userContent: string

    if (dispatch.userAnswer) {
      system = EVALUATE_SYSTEM
      userContent = [
        `Resume context:\n${resumeContext}`,
        `Topic: ${dispatch.selectedTopic}`,
        `Question: (previously generated for this topic)`,
        `User's answer: ${dispatch.userAnswer}`,
        `evaluate the answer for clarity and specificity`,
      ].join('\n\n')
    } else {
      system = GENERATE_SYSTEM
      userContent = [
        `Resume context:\n${resumeContext}`,
        `Topic to drill: ${dispatch.selectedTopic}`,
        `generate a behavioral or technical interview question for this topic`,
      ].join('\n\n')
    }

    const response = await this.anthropic.messages.create({
      model: this.model,
      max_tokens: 1024,
      system,
      messages: [{ role: 'user', content: userContent }],
    })

    const text = response.content.find(b => b.type === 'text')?.text ?? ''
    const feedback = JSON.parse(text) as InterviewFeedback

    this.send(AgentRole.INTERVIEW_PREP_LEAD, MessageType.RESULT, {
      sessionId: dispatch.sessionId,
      feedback,
    } satisfies TopicDrillResultPayload)
  }
}
