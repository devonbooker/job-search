import Anthropic from '@anthropic-ai/sdk'
import type { MessageQueue } from './queue'
import { AgentRole, MessageType, type Message } from './types'

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
        } catch (err) {
          console.error(`[${this.role}] handleMessage error:`, err)
          this.emitError(message, err)
        } finally {
          this.queue.ack(message.id)
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

  private emitError(message: Message, err: unknown): void {
    const sessionId = (message.payload as { sessionId?: string } | null)?.sessionId
    if (!sessionId) return
    try {
      this.send(AgentRole.HTTP_API, MessageType.ERROR, {
        sessionId,
        agent: this.role,
        message: err instanceof Error ? err.message : String(err),
      })
    } catch (sendErr) {
      console.error(`[${this.role}] failed to emit error event:`, sendErr)
    }
  }
}
