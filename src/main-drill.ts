import Anthropic from '@anthropic-ai/sdk'
import { Hono } from 'hono'
import { serveStatic } from 'hono/bun'
import { mountDrillRoutes } from './http/routes/drill'

const PORT = Number(process.env.PORT ?? 3000)

async function main() {
  if (!process.env.ANTHROPIC_API_KEY) {
    console.error('ANTHROPIC_API_KEY not set. Put it in .env and retry.')
    process.exit(1)
  }

  const anthropic = new Anthropic()
  const app = new Hono()

  mountDrillRoutes(app, { anthropic })

  app.use('/*', serveStatic({ root: './dist/web' }))
  app.notFound((c) => {
    return serveStatic({ root: './dist/web', path: 'index.html' })(c, async () => {})
  })

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    fetch: app.fetch,
  })

  console.log(`Drill dev server: http://localhost:${server.port}/drill`)
  console.log('(Use vite dev server at http://localhost:5173/drill for HMR + proxy.)')

  process.on('SIGINT', () => {
    console.log('\nShutting down...')
    server.stop()
    process.exit(0)
  })
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
