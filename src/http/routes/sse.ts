import type { Hono } from 'hono'
import { streamSSE } from 'hono/streaming'
import type { HttpApiAgent } from '../http-api-agent'

export function mountSseRoutes(app: Hono, agent: HttpApiAgent): void {
  app.get('/sessions/:id/events', (c) => {
    const sessionId = c.req.param('id')
    const lastEventId = Number(c.req.header('Last-Event-ID') ?? 0)

    return streamSSE(c, async (stream) => {
      const iter = agent.subscribe(sessionId, lastEventId)
      const heartbeat = setInterval(() => {
        stream.writeSSE({ event: 'ping', data: '' }).catch(() => {})
      }, 15_000)

      try {
        for await (const evt of iter) {
          await stream.writeSSE({
            id: String(evt.id),
            data: JSON.stringify(evt),
          })
        }
      } finally {
        clearInterval(heartbeat)
      }
    })
  })
}
