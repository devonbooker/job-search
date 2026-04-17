import Anthropic from '@anthropic-ai/sdk'
import type { MessageQueue } from './queue'
import type { AgentRole, MessageType, Message } from './types'

export abstract class BaseAgent {
  abstract readonly role: AgentRole
  abstract readonly model: string

  protected queue: MessageQueue
  protected anthropic: Anthropic
  private running = false
  private readonly pollIntervalMs = 100

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    this.queue = queue
    this.anthropic = anthropic
  }

  abstract handleMessage(message: Message): Promise<void>

  send(to: AgentRole, type: MessageType, payload: unknown): void {
    this.queue.send(this.role, to, type, payload)
  }

  async run(): Promise<void> {
    this.running = true
    while (this.running) {
      const message = this.queue.receive(this.role)
      if (message) {
        try {
          await this.handleMessage(message)
          this.queue.ack(message.id)
        } catch (err) {
          // Message remains unacked for retry on next poll
          console.error(`[${this.role}] handleMessage error:`, err)
          await Bun.sleep(this.pollIntervalMs)
        }
      } else {
        await Bun.sleep(this.pollIntervalMs)
      }
    }
  }

  stop(): void {
    this.running = false
  }
}
