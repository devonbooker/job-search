import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { mkdtemp, rm } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { existsSync, readFileSync } from 'fs'
import Anthropic from '@anthropic-ai/sdk'
import { createApp } from '../../src/http/server'
import { MessageQueue } from '../../src/agents/queue'
import { HttpApiAgent } from '../../src/http/http-api-agent'

// ─── Stub helpers ─────────────────────────────────────────────────────────────

type StubContentBlock =
  | { type: 'text'; text: string }
  | { type: 'tool_use'; id: string; name: string; input: unknown }

/** Build a fake Anthropic messages.create response. Accepts either a text string (wrapped as a text block) or a content block array. */
function fakeMessage(contentOrText: string | StubContentBlock[]): Anthropic.Message {
  const content: StubContentBlock[] = typeof contentOrText === 'string'
    ? [{ type: 'text', text: contentOrText }]
    : contentOrText
  return {
    id: 'msg_stub',
    type: 'message',
    role: 'assistant',
    content,
    model: 'claude-sonnet-4-6',
    stop_reason: 'end_turn',
    stop_sequence: null,
    usage: { input_tokens: 10, output_tokens: 10 },
  } as unknown as Anthropic.Message
}

/** Drill turn response JSON (Sonnet format, text-mode) */
function drillTurnJson(
  question: string,
  assessment: 'weak' | 'partial' | 'solid',
  earlyTerminate = false,
): string {
  return JSON.stringify({ question, model_assessment: assessment, early_terminate: earlyTerminate })
}

/** Verdict object (Opus tool-use format) */
function verdictObject(): object {
  return {
    target_role: 'Security Infrastructure Engineer',
    project_drilled: 'Container security hardening project',
    solid: ['Strong understanding of WAF rule tuning and count-mode testing methodology'],
    weak: [
      {
        area: 'Kubernetes RBAC depth',
        why: 'Named the tool but could not explain binding scopes',
        example_question: 'Walk me through how you scoped RBAC roles in that cluster.',
        how_to_fix: 'Review K8s RBAC docs.',
        model_answer: 'A solid answer would cite specific role bindings.',
      },
    ],
    interviewer_verdict: 'Advance to phone screen. Candidate owns the basics but needs 2-3 weeks on K8s RBAC specifics.',
    overall: 'Borderline',
    overall_summary: 'Solid on WAF, gaps on orchestration internals.',
  }
}

/**
 * Create a stubbed Anthropic client where messages.create returns responses in order.
 * - String responses → text block (drill turn format)
 * - Object responses → tool_use block (verdict format) when called with `tools`
 */
function createStubbedAnthropic(responses: Array<string | object>): Anthropic {
  let callIndex = 0
  const stub = {
    messages: {
      create: async (opts: { tools?: Array<{ name: string }> }) => {
        const item = responses[callIndex] ?? responses[responses.length - 1]
        callIndex++
        if (opts.tools && typeof item === 'object') {
          const toolName = opts.tools[0]?.name ?? 'submit_verdict'
          return fakeMessage([{ type: 'tool_use', id: 'stub_tool_call', name: toolName, input: item }])
        }
        const text = typeof item === 'string' ? item : JSON.stringify(item)
        return fakeMessage([{ type: 'text', text }])
      },
    },
  } as unknown as Anthropic
  return stub
}

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const RESUME = `
John Smith — Security Infrastructure Engineer

Experience:
- Led container security hardening for 40-node EKS cluster at FinCo (2022-2024)
  - Implemented AWS WAF with managed rule groups, tuned in count mode for 3 weeks
  - Deployed Falco for runtime anomaly detection across all pods
  - Enforced OPA/Gatekeeper policies: no privileged pods, image registry allowlist
  - Set up Trivy scanning in CI pipeline with blocking thresholds on critical CVEs

Skills: Kubernetes, AWS EKS, Terraform, Docker, Falco, WAF, TLS/mTLS, GitHub Actions
Education: B.S. Computer Science, State University 2020
`.trim()

const JD = `
Security Infrastructure Engineer — Series B Fintech Startup

We're looking for a security engineer to own infrastructure security across our AWS/K8s stack.
Requirements:
- 3+ years securing containerized workloads in production
- Hands-on with EKS, IAM, WAF, VPC security groups
- Experience with runtime security tooling (Falco, Sysdig, or similar)
- Strong Terraform skills for security automation
- Ability to run threat modelling sessions with eng leads
- Ownership mindset: you designed it, you shipped it, you own it
`.trim()

const TOKEN = 'd'.repeat(64)

// ─── Tests ────────────────────────────────────────────────────────────────────

describe('Drill integration: full end-to-end flow', () => {
  let tmpDir: string
  let storageFile: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'drill-test-'))
    storageFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('full drill → verdict flow end-to-end', async () => {
    // 5 answer turns + 1 finish call = 6 Sonnet calls + 1 Opus call
    // Turn 1 (start): Sonnet returns Q1
    // Turns 2-5 (answer): Sonnet returns assessment + next question
    // Turn 6 (answer): Sonnet returns assessment + earlyTerminate=false (we finish manually)
    // Finish: Opus returns verdict
    const stubbedResponses = [
      // startSession call (turn 1)
      drillTurnJson('Walk me through how you configured WAF for the EKS cluster.', 'solid'),
      // submitAnswer turn 1
      drillTurnJson('How did you tune the managed rule groups to reduce false positives?', 'solid'),
      // submitAnswer turn 2
      drillTurnJson('What RBAC roles did you define for Falco on the cluster?', 'partial'),
      // submitAnswer turn 3
      drillTurnJson('How did you handle image registry allowlist enforcement?', 'weak'),
      // submitAnswer turn 4
      drillTurnJson('Walk me through the Trivy CI pipeline blocking policy you set up.', 'solid'),
      // submitAnswer turn 5
      drillTurnJson('How did you test that the WAF rules did not break legitimate traffic?', 'partial'),
      // finishSession Opus call
      verdictObject(),
    ]

    const anthropic = createStubbedAnthropic(stubbedResponses)

    // Use mountDrillRoutes directly to inject storageFilePath for JSONL verification.
    const { Hono } = await import('hono')
    const { mountDrillRoutes } = await import('../../src/http/routes/drill')
    const drillApp = new Hono()
    mountDrillRoutes(drillApp, {
      anthropic: anthropic as unknown as InstanceType<typeof Anthropic>,
      storageFilePath: storageFile,
    })

    // 1. POST /drill/api/start
    const startRes = await drillApp.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId, firstQuestion } = await startRes.json() as { sessionId: string; firstQuestion: string }
    expect(typeof sessionId).toBe('string')
    expect(sessionId.length).toBeGreaterThan(10)
    expect(typeof firstQuestion).toBe('string')
    expect(firstQuestion.length).toBeGreaterThan(5)

    // 2. GET /drill/api/sessions/:id → in_progress
    const getRes = await drillApp.request(`/drill/api/sessions/${sessionId}`)
    expect(getRes.status).toBe(200)
    const snapshot = await getRes.json() as { status: string; turnsCompleted: number; transcript: unknown[] }
    expect(snapshot.status).toBe('in_progress')
    expect(snapshot.turnsCompleted).toBe(0)
    expect(snapshot.transcript.length).toBeGreaterThan(0)

    // 3. POST answer × 5
    const assessments: string[] = []
    for (let i = 0; i < 5; i++) {
      const ansRes = await drillApp.request(`/drill/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `My detailed answer for turn ${i + 1} explaining specifics about the implementation.` }),
      })
      expect(ansRes.status).toBe(200)
      const ansBody = await ansRes.json() as { nextQuestion: string | null; completed: boolean; turnsCompleted: number }
      expect(ansBody.turnsCompleted).toBe(i + 1)
      assessments.push(ansBody.nextQuestion ?? 'done')
    }

    // 4. POST /drill/api/sessions/:id/finish → verdict
    const finishRes = await drillApp.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
    })
    expect(finishRes.status).toBe(200)
    const { verdict } = await finishRes.json() as { verdict: { solid: string[]; weak: unknown[]; overall: string } }
    expect(Array.isArray(verdict.solid)).toBe(true)
    expect(verdict.solid.length).toBeGreaterThanOrEqual(1)
    expect(Array.isArray(verdict.weak)).toBe(true)
    expect(verdict.weak.length).toBeGreaterThanOrEqual(1)

    // 5. Verify JSONL contains events in order
    expect(existsSync(storageFile)).toBe(true)
    const lines = readFileSync(storageFile, 'utf8')
      .split('\n')
      .filter(l => l.trim() !== '')
      .map(l => JSON.parse(l) as { event: string; session_id: string })
    const sessionLines = lines.filter(l => l.session_id === sessionId)
    const eventTypes = sessionLines.map(l => l.event)

    expect(eventTypes[0]).toBe('start')
    expect(eventTypes[1]).toBe('question')
    // Should have answer events
    const answerCount = eventTypes.filter(e => e === 'answer').length
    expect(answerCount).toBe(5)
    // Should end with finish
    expect(eventTypes[eventTypes.length - 1]).toBe('finish')
  })
})

describe('Drill integration: SPA fallback', () => {
  test('GET /drill falls through to SPA (not a drill API route)', async () => {
    const anthropic = createStubbedAnthropic([])
    const queue = new MessageQueue(':memory:')
    const agent = new HttpApiAgent(queue, anthropic as unknown as InstanceType<typeof Anthropic>)
    const app = createApp({
      httpApiAgent: agent,
      token: TOKEN,
      anthropic: anthropic as unknown as InstanceType<typeof Anthropic>,
    })

    // /drill is not a drill API route — it should fall through to the static/SPA handler.
    // In test (no dist/web), Hono's serveStatic returns 404, NOT a drill API error.
    // The key assertion: it does NOT return a drill JSON error response at all.
    const res = await app.request('/drill', { method: 'GET' })
    const text = await res.text()
    // Could be 200 (static serve) or 404 (no dist/web in test env) — both acceptable.
    // What matters: NOT a JSON response from the drill API.
    expect(text).not.toMatch(/"error":\s*"session_not_found"/)
    expect(text).not.toMatch(/"error":\s*"validation_error"/)
    expect(text).not.toMatch(/^\{.*"error":/)
  })

  test('GET /drill/some-session-id falls through to SPA (not an API route)', async () => {
    const anthropic = createStubbedAnthropic([])
    const queue = new MessageQueue(':memory:')
    const agent = new HttpApiAgent(queue, anthropic as unknown as InstanceType<typeof Anthropic>)
    const app = createApp({
      httpApiAgent: agent,
      token: TOKEN,
      anthropic: anthropic as unknown as InstanceType<typeof Anthropic>,
    })

    // /drill/:sessionId is the SPA frontend route, not an API route.
    // Must not return a drill API JSON error.
    const res = await app.request('/drill/some-session-id-12345')
    const text = await res.text()
    expect(text).not.toMatch(/"error":\s*"session_not_found"/)
    expect(text).not.toMatch(/"error":\s*"validation_error"/)
    expect(text).not.toMatch(/^\{.*"error":/)
  })
})

describe('Drill integration: auth middleware does NOT apply to /drill/api', () => {
  test('POST /drill/api/start without Authorization header returns 200', async () => {
    const anthropic = createStubbedAnthropic([
      drillTurnJson('Describe a time you hardened a container workload.', 'solid'),
    ])
    const queue = new MessageQueue(':memory:')
    const agent = new HttpApiAgent(queue, anthropic as unknown as InstanceType<typeof Anthropic>)
    const app = createApp({
      httpApiAgent: agent,
      token: TOKEN,
      anthropic: anthropic as unknown as InstanceType<typeof Anthropic>,
    })

    // No Authorization header — drill routes are public.
    // Expect 200: proves the route is mounted, auth didn't block it, and the full stack worked.
    const res = await app.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(res.status).toBe(200)
  })
})

describe('Drill integration: verdict fallback on Opus failure', () => {
  let tmpDir: string
  let storageFile: string

  beforeEach(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'drill-verdict-fail-'))
    storageFile = join(tmpDir, 'sessions.jsonl')
  })

  afterEach(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  test('POST /finish returns 502 with transcript when Opus throws', async () => {
    // All Sonnet calls succeed; the Opus call (7th) throws
    let callCount = 0
    const stubbedAnthropic = {
      messages: {
        create: async (_opts: unknown) => {
          callCount++
          if (callCount <= 6) {
            // Sonnet responses for start (1) + 5 answers (2-6)
            const responses = [
              drillTurnJson('Tell me about the WAF configuration you implemented.', 'solid'),
              drillTurnJson('How did you tune it?', 'solid'),
              drillTurnJson('What Falco rules did you write?', 'partial'),
              drillTurnJson('How did you test those rules?', 'weak'),
              drillTurnJson('What did the CI Trivy scan catch?', 'solid'),
              drillTurnJson('How did you handle alerts?', 'partial'),
            ]
            return fakeMessage(responses[callCount - 1])
          }
          // 7th call is Opus — simulate failure
          throw new Error('Opus rate limit exceeded')
        },
      },
    } as unknown as Anthropic

    const { Hono } = await import('hono')
    const { mountDrillRoutes } = await import('../../src/http/routes/drill')
    const drillApp = new Hono()
    mountDrillRoutes(drillApp, {
      anthropic: stubbedAnthropic,
      storageFilePath: storageFile,
    })

    // Start session
    const startRes = await drillApp.request('/drill/api/start', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ resume: RESUME, jobDescription: JD }),
    })
    expect(startRes.status).toBe(200)
    const { sessionId } = await startRes.json() as { sessionId: string }

    // Submit 5 answers (3+ required for finish; we do 5 to be well above minimum)
    for (let i = 0; i < 5; i++) {
      const res = await drillApp.request(`/drill/api/sessions/${sessionId}/answer`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ text: `Detailed answer ${i + 1} with concrete implementation specifics.` }),
      })
      expect(res.status).toBe(200)
    }

    // Finish — Opus will throw → expect 502 with transcript in body
    const finishRes = await drillApp.request(`/drill/api/sessions/${sessionId}/finish`, {
      method: 'POST',
    })
    expect(finishRes.status).toBe(502)
    const body = await finishRes.json() as { error: string; transcript: unknown[] }
    expect(body.error).toBe('verdict_failed')
    expect(Array.isArray(body.transcript)).toBe(true)
    expect(body.transcript.length).toBeGreaterThan(0)
  })
})
