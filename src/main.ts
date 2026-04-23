import { createRuntime } from './agents/runtime'
import { Orchestrator } from './agents/orchestrator'
import { IntakeLead } from './agents/intake/intake-lead'
import { ProfileBuilder } from './agents/intake/profile-builder'
import { ResearchLead } from './agents/research/research-lead'
import { JobTitleResearch } from './agents/research/job-title-research'
import { SkillsMarketResearch } from './agents/research/skills-market-research'
import { ResumeLead } from './agents/resume/resume-lead'
import { ResumeBuilder } from './agents/resume/resume-builder'
import { JobSearchLead } from './agents/job-search/job-search-lead'
import { AdzunaSearch } from './agents/job-search/adzuna-search'
import { InterviewPrepLead } from './agents/interview/interview-prep-lead'
import { TopicDrill } from './agents/interview/topic-drill'
import { HttpApiAgent } from './http/http-api-agent'
import { createApp } from './http/server'
import { loadOrCreateToken } from './http/auth'
import { runMigrations, pool } from './db/postgres'
import { SessionStore } from './agents/session-store'
import type { SessionState } from './agents/orchestrator'
import type { ResearchSession } from './agents/research/research-lead'

const DB_PATH = process.env.QUEUE_DB ?? './messages.db'
const TOKEN_PATH = process.env.SESSION_TOKEN_PATH ?? './.session-token'
const PORT = Number(process.env.PORT ?? 3000)

async function main() {
  await runMigrations()

  const runtime = createRuntime(DB_PATH)
  const { queue, anthropic } = runtime

  const orchestratorStore = new SessionStore<SessionState>({ pool, table: 'orchestrator_sessions' })
  const researchStore = new SessionStore<ResearchSession>({ pool, table: 'research_lead_sessions' })

  const agents = [
    new Orchestrator(queue, anthropic, orchestratorStore),
    new IntakeLead(queue, anthropic),
    new ProfileBuilder(queue, anthropic),
    new ResearchLead(
      queue,
      anthropic,
      researchStore,
      process.env.ADZUNA_APP_ID ?? '',
      process.env.ADZUNA_APP_KEY ?? '',
    ),
    new JobTitleResearch(queue, anthropic),
    new SkillsMarketResearch(queue, anthropic),
    new ResumeLead(queue, anthropic),
    new ResumeBuilder(queue, anthropic),
    new JobSearchLead(queue, anthropic),
    new AdzunaSearch(queue, anthropic, pool),
    new InterviewPrepLead(queue, anthropic),
    new TopicDrill(queue, anthropic),
  ]

  const httpApiAgent = new HttpApiAgent(queue, anthropic)

  for (const a of [...agents, httpApiAgent]) {
    a.run().catch(err => console.error(`[${a.role}] crashed:`, err))
  }

  const token = loadOrCreateToken(TOKEN_PATH)
  const app = createApp({ httpApiAgent, token, anthropic })

  const server = Bun.serve({
    hostname: '127.0.0.1',
    port: PORT,
    fetch: app.fetch,
    // Opus verdict calls on /drill/api/*/finish take 20-40s; default 10s drops
    // the socket mid-response.
    idleTimeout: 180,
  })

  console.log(`Server ready: http://localhost:${server.port}?token=${token}`)

  setInterval(() => httpApiAgent.purgeStaleSessions(), 5 * 60 * 1000)

  process.on('SIGINT', async () => {
    console.log('Shutting down...')
    server.stop()
    for (const a of [...agents, httpApiAgent]) await a.stop()
    queue.close()
    process.exit(0)
  })
}

main().catch(err => {
  console.error(err)
  process.exit(1)
})
