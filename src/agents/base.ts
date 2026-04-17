import Anthropic from '@anthropic-ai/sdk'
import type { MessageQueue } from './queue'
import type { AgentRole, MessageType, Message } from './types'

export abstract class BaseAgent {
  abstract readonly role: AgentRole
  abstract readonly model: string

  protected queue: MessageQueue
  protected anthropic: Anthropic
  private running = false
  private runPromise: Promise<void> | null = null
  protected readonly pollIntervalMs: number

  constructor(queue: MessageQueue, anthropic: Anthropic, pollIntervalMs = 100) {
    this.queue = queue
    this.anthropic = anthropic
    this.pollIntervalMs = pollIntervalMs
  }

  abstract handleMessage(message: Message): Promise<void>

  send(to: AgentRole, type: MessageType, payload: unknown): void {
    this.queue.send(this.role, to, type, payload)
  }

  async run(): Promise<void> {
    if (this.running) {
      throw new Error(`[${this.role}] run() called while already running`)
    }
    this.running = true
    this.runPromise = this.loop()
    try {
      await this.runPromise
    } finally {
      this.running = false
      this.runPromise = null
    }
  }

  private async loop(): Promise<void> {
    while (this.running) {
      let message: Message | null = null
      try {
        message = this.queue.receive(this.role)
      } catch (err) {
        console.error(`[${this.role}] queue.receive error:`, err)
        await Bun.sleep(this.pollIntervalMs)
        continue
      }

      if (message) {
        try {
          await this.handleMessage(message)
          this.queue.ack(message.id)
        } catch (err) {
          console.error(`[${this.role}] handleMessage error:`, err)
          await Bun.sleep(this.pollIntervalMs)
        }
      } else {
        await Bun.sleep(this.pollIntervalMs)
      }
    }
  }

  async stop(): Promise<void> {
    this.running = false
    if (this.runPromise) {
      await this.runPromise
    }
  }
}
