import { Hono, type MiddlewareHandler } from 'hono'
import { serveStatic } from 'hono/bun'
import type { HttpApiAgent } from './http-api-agent'
import { mountSessionRoutes } from './routes/sessions'
import { mountSseRoutes } from './routes/sse'
import { mountJobRoutes } from './routes/jobs'

export interface AppDeps {
  httpApiAgent: HttpApiAgent
  token: string
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

  app.use('/*', serveStatic({ root: './dist/web' }))
  app.notFound((c) => {
    return serveStatic({ root: './dist/web', path: 'index.html' })(c, async () => {})
  })

  return app
}
