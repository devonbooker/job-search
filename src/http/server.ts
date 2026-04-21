import { Hono, type MiddlewareHandler } from 'hono'
import { serveStatic } from 'hono/bun'
import type Anthropic from '@anthropic-ai/sdk'
import type { HttpApiAgent } from './http-api-agent'
import { mountSessionRoutes } from './routes/sessions'
import { mountSseRoutes } from './routes/sse'
import { mountJobRoutes } from './routes/jobs'
import { mountDrillRoutes } from './routes/drill'

export interface AppDeps {
  httpApiAgent: HttpApiAgent
  token: string
  anthropic: Anthropic
}

export function createApp(deps: AppDeps) {
  const app = new Hono()

  const requireAuth: MiddlewareHandler = async (c, next) => {
    const header = c.req.header('Authorization')
    const queryToken = c.req.query('token')
    const provided = header?.startsWith('Bearer ') ? header.slice(7) : queryToken
    if (provided !== deps.token) {
      return c.json({ error: 'Unauthorized' }, 401)
    }
    await next()
  }
  app.use('/sessions/*', requireAuth)
  app.use('/jobs/*', requireAuth)

  mountSessionRoutes(app, deps.httpApiAgent)
  mountSseRoutes(app, deps.httpApiAgent)
  mountJobRoutes(app)
  mountDrillRoutes(app, { anthropic: deps.anthropic })

  app.use('/*', serveStatic({ root: './dist/web' }))
  app.notFound((c) => {
    return serveStatic({ root: './dist/web', path: 'index.html' })(c, async () => {})
  })

  return app
}
