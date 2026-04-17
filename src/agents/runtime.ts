import Anthropic from '@anthropic-ai/sdk'
import { MessageQueue } from './queue'

export interface Runtime {
  queue: MessageQueue
  anthropic: Anthropic
}

export function createRuntime(dbPath: string): Runtime {
  const queue = new MessageQueue(dbPath)
  const anthropic = new Anthropic()
  return { queue, anthropic }
}
