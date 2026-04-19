import type { AgentEvent } from '../agents/events'

export function openEventStream(
  sessionId: string,
  onEvent: (evt: AgentEvent) => void,
): () => void {
  const token = sessionStorage.getItem('auth-token') ?? ''
  const es = new EventSource(`/sessions/${sessionId}/events?token=${token}`)
  es.onmessage = (m) => {
    try {
      const evt = JSON.parse(m.data) as AgentEvent
      onEvent(evt)
    } catch (err) {
      console.error('[sse] bad event', err)
    }
  }
  es.onerror = (err) => {
    console.error('[sse] error', err)
  }
  return () => es.close()
}
