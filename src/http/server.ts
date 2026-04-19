import { Hono } from 'hono'
import type { HttpApiAgent } from './http-api-agent'
import { mountSessionRoutes } from './routes/sessions'
import { mountSseRoutes } from './routes/sse'

export interface AppDeps {
  httpApiAgent: HttpApiAgent
  token: string
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  app.use('*', async (c, next) => {
    // Skip auth for static assets + / and /config could be tokenless in future,
    // but for v1 we require auth on everything.
    const header = c.req.header('Authorization')
    const queryToken = c.req.query('token')
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : queryToken
    if (provided !== deps.token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  })

  mountSessionRoutes(app, deps.httpApiAgent)
  mountSseRoutes(app, deps.httpApiAgent)

  return app
}
