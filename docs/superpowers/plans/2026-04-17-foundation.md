# Job Search Agent - Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold the project, set up PostgreSQL with migrations, build the SQLite message queue, define the typed message protocol, and implement the BaseAgent abstract class that all agents will extend.

**Architecture:** Bun + TypeScript. PostgreSQL (via `pg`) for persistent data. SQLite (`bun:sqlite`) for ephemeral in-process agent message passing with WAL mode. BaseAgent is an abstract class with a polling run loop and typed send/receive methods.

**Tech Stack:** Bun 1.0+, TypeScript, PostgreSQL, `pg`, `bun:sqlite` (built-in), `@anthropic-ai/sdk`

---

## File Map

```
job-search/
├── package.json
├── tsconfig.json
├── .env.example
├── src/
│   ├── index.ts                         entry point (placeholder)
│   ├── db/
│   │   ├── postgres.ts                  Pool + runMigrations()
│   │   └── migrations/
│   │       ├── 001_create_users.sql
│   │       ├── 002_create_jobs.sql
│   │       └── 003_create_research_results.sql
│   └── agents/
│       ├── types.ts                     AgentRole, MessageType, Message, all payload types
│       ├── queue.ts                     MessageQueue class (SQLite-backed)
│       └── base.ts                      BaseAgent abstract class
└── tests/
    ├── db/
    │   └── postgres.test.ts
    └── agents/
        ├── queue.test.ts
        └── base.test.ts
```

---

## Task 1: Project Scaffolding

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `.env.example`
- Create: `src/index.ts`

- [ ] **Step 1: Initialize Bun project**

```bash
cd /path/to/job-search
bun init -y
```

Expected: `package.json` and `tsconfig.json` created.

- [ ] **Step 2: Replace package.json**

```json
{
  "name": "job-search",
  "version": "0.1.0",
  "private": true,
  "scripts": {
    "dev": "bun run src/index.ts",
    "test": "bun test"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.39.0",
    "pg": "^8.13.0"
  },
  "devDependencies": {
    "@types/pg": "^8.11.0",
    "typescript": "^5.0.0"
  }
}
```

- [ ] **Step 3: Replace tsconfig.json**

```json
{
  "compilerOptions": {
    "target": "ESNext",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "types": ["bun-types"]
  },
  "include": ["src/**/*", "tests/**/*"]
}
```

- [ ] **Step 4: Create .gitignore**

```
node_modules/
dist/
.env
*.db
```

- [ ] **Step 5: Create .env.example**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/job_search
SQLITE_PATH=./agent-messages.db
ANTHROPIC_API_KEY=sk-ant-...
ADZUNA_APP_ID=
ADZUNA_APP_KEY=
BRAVE_SEARCH_API_KEY=
```

- [ ] **Step 6: Create src/index.ts**

```typescript
console.log('job-search agent system')
```

- [ ] **Step 7: Install dependencies**

```bash
bun install
```

Expected: `node_modules/` created, `bun.lock` created.

- [ ] **Step 8: Commit**

```bash
git init
git add package.json tsconfig.json .gitignore .env.example src/index.ts bun.lock
git commit -m "feat: scaffold project"
```

---

## Task 2: PostgreSQL Connection and Migrations

**Files:**
- Create: `src/db/postgres.ts`
- Create: `src/db/migrations/001_create_users.sql`
- Create: `src/db/migrations/002_create_jobs.sql`
- Create: `src/db/migrations/003_create_research_results.sql`
- Create: `tests/db/postgres.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/db/postgres.test.ts`:

```typescript
import { describe, test, expect, beforeAll, afterAll } from 'bun:test'
import { pool, runMigrations } from '../../src/db/postgres'

describe('postgres', () => {
  beforeAll(async () => {
    await runMigrations()
  })

  afterAll(async () => {
    await pool.end()
  })

  test('migrations table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'migrations'`
    )
    expect(rows.length).toBe(1)
  })

  test('users table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'users'`
    )
    expect(rows.length).toBe(1)
  })

  test('jobs table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'jobs'`
    )
    expect(rows.length).toBe(1)
  })

  test('research_results table exists after runMigrations', async () => {
    const { rows } = await pool.query(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = 'public' AND table_name = 'research_results'`
    )
    expect(rows.length).toBe(1)
  })

  test('runMigrations is idempotent', async () => {
    await expect(runMigrations()).resolves.toBeUndefined()
  })

  test('can insert and retrieve a user', async () => {
    const { rows } = await pool.query(
      `INSERT INTO users (goals) VALUES ($1) RETURNING id, goals`,
      ['become a security engineer']
    )
    expect(rows[0].goals).toBe('become a security engineer')
    await pool.query('DELETE FROM users WHERE id = $1', [rows[0].id])
  })

  test('can insert and retrieve a job with default stage', async () => {
    const { rows } = await pool.query(
      `INSERT INTO jobs (job_title, company, link) VALUES ($1, $2, $3) RETURNING id, stage`,
      ['Security Engineer', 'Acme Corp', 'https://example.com/job/1']
    )
    expect(rows[0].stage).toBe('not_applied')
    await pool.query('DELETE FROM jobs WHERE id = $1', [rows[0].id])
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/job_search bun test tests/db/postgres.test.ts
```

Expected: FAIL — `Cannot find module '../../src/db/postgres'`

- [ ] **Step 3: Create migration files**

Create `src/db/migrations/001_create_users.sql`:

```sql
CREATE TABLE IF NOT EXISTS users (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  goals TEXT,
  resume_raw TEXT,
  resume_built JSONB,
  target_job_titles TEXT[]
);
```

Create `src/db/migrations/002_create_jobs.sql`:

```sql
DO $$ BEGIN
  CREATE TYPE job_stage AS ENUM (
    'not_applied',
    'applied',
    'phone_screening',
    'interview',
    'booked',
    'offer_received',
    'accepted',
    'rejected'
  );
EXCEPTION
  WHEN duplicate_object THEN null;
END $$;

CREATE TABLE IF NOT EXISTS jobs (
  id SERIAL PRIMARY KEY,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  job_title TEXT NOT NULL,
  company TEXT NOT NULL,
  link TEXT NOT NULL,
  stage job_stage NOT NULL DEFAULT 'not_applied',
  source TEXT,
  notes TEXT
);
```

Create `src/db/migrations/003_create_research_results.sql`:

```sql
CREATE TABLE IF NOT EXISTS research_results (
  id SERIAL PRIMARY KEY,
  user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  job_titles JSONB NOT NULL DEFAULT '[]',
  skills_by_title JSONB NOT NULL DEFAULT '{}'
);
```

- [ ] **Step 4: Implement src/db/postgres.ts**

```typescript
import { Pool } from 'pg'
import { readdir, readFile } from 'fs/promises'
import { join } from 'path'

export const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
})

export async function runMigrations(): Promise<void> {
  const client = await pool.connect()
  try {
    await client.query(`
      CREATE TABLE IF NOT EXISTS migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT UNIQUE NOT NULL,
        ran_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `)

    const migrationsDir = join(import.meta.dir, 'migrations')
    const files = (await readdir(migrationsDir))
      .filter((f) => f.endsWith('.sql'))
      .sort()

    for (const file of files) {
      const { rows } = await client.query(
        'SELECT id FROM migrations WHERE filename = $1',
        [file]
      )
      if (rows.length === 0) {
        const sql = await readFile(join(migrationsDir, file), 'utf-8')
        await client.query(sql)
        await client.query('INSERT INTO migrations (filename) VALUES ($1)', [file])
      }
    }
  } finally {
    client.release()
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/job_search bun test tests/db/postgres.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/db/ tests/db/
git commit -m "feat: add postgres connection and migrations"
```

---

## Task 3: SQLite Message Queue

**Files:**
- Create: `src/agents/types.ts`
- Create: `src/agents/queue.ts`
- Create: `tests/agents/queue.test.ts`

- [ ] **Step 1: Create src/agents/types.ts**

```typescript
export enum AgentRole {
  ORCHESTRATOR = 'ORCHESTRATOR',
  INTAKE_LEAD = 'INTAKE_LEAD',
  PROFILE_BUILDER = 'PROFILE_BUILDER',
  RESEARCH_LEAD = 'RESEARCH_LEAD',
  JOB_TITLE_RESEARCH = 'JOB_TITLE_RESEARCH',
  SKILLS_MARKET_RESEARCH = 'SKILLS_MARKET_RESEARCH',
  RESUME_LEAD = 'RESUME_LEAD',
  RESUME_BUILDER = 'RESUME_BUILDER',
  JOB_SEARCH_LEAD = 'JOB_SEARCH_LEAD',
  ADZUNA_SEARCH = 'ADZUNA_SEARCH',
  INTERVIEW_PREP_LEAD = 'INTERVIEW_PREP_LEAD',
  TOPIC_DRILL = 'TOPIC_DRILL',
}

export enum MessageType {
  DISPATCH = 'DISPATCH',
  RESULT = 'RESULT',
  STATUS = 'STATUS',
  ERROR = 'ERROR',
}

export interface Message {
  id: string
  from_agent: AgentRole
  to_agent: AgentRole
  type: MessageType
  payload: unknown
  created_at: number
  acked_at: number | null
}

export interface UserProfile {
  goals: string
  experience: string
  resumeRaw: string | null
  preferences: string
}

export interface JobTitleResult {
  title: string
  description: string
  relevanceReason: string
}

export interface SkillsResult {
  jobTitle: string
  requiredSkills: string[]
  niceToHaveSkills: string[]
}

export interface BulletItem {
  text: string
}

export interface ResumeSection {
  title: string
  content: string | BulletItem[]
}

export interface InterviewFeedback {
  question: string
  feedback: string
  clarity: 'strong' | 'adequate' | 'weak'
  specificity: 'strong' | 'adequate' | 'weak'
}

// Dispatch payloads (Orchestrator -> Lead, Lead -> Sub)
export interface IntakeDispatchPayload {
  sessionId: string
}

export interface ResearchDispatchPayload {
  sessionId: string
  profile: UserProfile
}

export interface ResumeDispatchPayload {
  sessionId: string
  profile: UserProfile
  jobTitles: JobTitleResult[]
  skillsByTitle: SkillsResult[]
  targetTitles: string[]
}

export interface JobSearchDispatchPayload {
  sessionId: string
  targetTitles: string[]
}

export interface InterviewDispatchPayload {
  sessionId: string
  resumeSections: ResumeSection[]
  selectedTopic: string
  userAnswer?: string
}

// Result payloads (Lead -> Orchestrator, Sub -> Lead)
export interface IntakeResultPayload {
  sessionId: string
  profile: UserProfile
}

export interface ResearchResultPayload {
  sessionId: string
  jobTitles: JobTitleResult[]
  skillsByTitle: SkillsResult[]
}

export interface ResumeResultPayload {
  sessionId: string
  sections: ResumeSection[]
}

export interface JobSearchResultPayload {
  sessionId: string
  jobsFound: number
}

export interface InterviewResultPayload {
  sessionId: string
  feedback: InterviewFeedback
}

export interface StatusPayload {
  sessionId: string
  agent: AgentRole
  message: string
}

export interface ErrorPayload {
  sessionId: string
  agent: AgentRole
  error: string
}
```

- [ ] **Step 2: Write the failing test**

Create `tests/agents/queue.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import { MessageQueue } from '../../src/agents/queue'
import { AgentRole, MessageType } from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-queue.db'

describe('MessageQueue', () => {
  let queue: MessageQueue

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
  })

  afterEach(() => {
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('send adds a message to the queue', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'abc' })
    const msg = queue.receive(AgentRole.INTAKE_LEAD)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.ORCHESTRATOR)
    expect(msg!.to_agent).toBe(AgentRole.INTAKE_LEAD)
    expect(msg!.type).toBe(MessageType.DISPATCH)
    expect(msg!.payload).toEqual({ sessionId: 'abc' })
  })

  test('receive returns null when no messages', () => {
    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).toBeNull()
  })

  test('receive returns only unacked messages', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, { sessionId: '1' })
    const msg = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg).not.toBeNull()
    queue.ack(msg!.id)
    const msg2 = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg2).toBeNull()
  })

  test('receive returns oldest message first', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESUME_LEAD, MessageType.DISPATCH, { sessionId: 'first' })
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESUME_LEAD, MessageType.DISPATCH, { sessionId: 'second' })
    const msg = queue.receive(AgentRole.RESUME_LEAD)
    expect((msg!.payload as { sessionId: string }).sessionId).toBe('first')
  })

  test('receive does not return messages intended for other agents', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'x' })
    const msg = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(msg).toBeNull()
  })

  test('ack marks message as acknowledged', () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.JOB_SEARCH_LEAD, MessageType.DISPATCH, { sessionId: 'y' })
    const msg = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    queue.ack(msg!.id)
    const row = queue.receive(AgentRole.JOB_SEARCH_LEAD)
    expect(row).toBeNull()
  })

  test('payload is deserialized from JSON', () => {
    const payload = { sessionId: 'z', nested: { key: 'value' }, arr: [1, 2, 3] }
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTERVIEW_PREP_LEAD, MessageType.DISPATCH, payload)
    const msg = queue.receive(AgentRole.INTERVIEW_PREP_LEAD)
    expect(msg!.payload).toEqual(payload)
  })
})
```

- [ ] **Step 3: Run to verify it fails**

```bash
bun test tests/agents/queue.test.ts
```

Expected: FAIL — `Cannot find module '../../src/agents/queue'`

- [ ] **Step 4: Implement src/agents/queue.ts**

```typescript
import { Database } from 'bun:sqlite'
import { randomUUID } from 'crypto'
import type { AgentRole, MessageType, Message } from './types'

interface RawRow {
  id: string
  from_agent: string
  to_agent: string
  type: string
  payload: string
  created_at: number
  acked_at: number | null
}

export class MessageQueue {
  private db: Database

  constructor(dbPath: string) {
    this.db = new Database(dbPath)
    this.db.exec('PRAGMA journal_mode=WAL')
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS messages (
        id TEXT PRIMARY KEY,
        from_agent TEXT NOT NULL,
        to_agent TEXT NOT NULL,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        acked_at INTEGER
      )
    `)
    this.db.exec(`
      CREATE INDEX IF NOT EXISTS idx_messages_to_unacked
      ON messages (to_agent, created_at)
      WHERE acked_at IS NULL
    `)
  }

  send(from: AgentRole, to: AgentRole, type: MessageType, payload: unknown): void {
    this.db.run(
      'INSERT INTO messages (id, from_agent, to_agent, type, payload, created_at) VALUES (?, ?, ?, ?, ?, ?)',
      [randomUUID(), from, to, type, JSON.stringify(payload), Date.now()]
    )
  }

  receive(agent: AgentRole): Message | null {
    const row = this.db
      .query<RawRow, [string]>(
        'SELECT * FROM messages WHERE to_agent = ? AND acked_at IS NULL ORDER BY created_at ASC LIMIT 1'
      )
      .get(agent)

    if (!row) return null

    return {
      id: row.id,
      from_agent: row.from_agent as AgentRole,
      to_agent: row.to_agent as AgentRole,
      type: row.type as MessageType,
      payload: JSON.parse(row.payload),
      created_at: row.created_at,
      acked_at: row.acked_at,
    }
  }

  ack(id: string): void {
    this.db.run('UPDATE messages SET acked_at = ? WHERE id = ?', [Date.now(), id])
  }

  close(): void {
    this.db.close()
  }
}
```

- [ ] **Step 5: Run tests to verify they pass**

```bash
bun test tests/agents/queue.test.ts
```

Expected: all 7 tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/types.ts src/agents/queue.ts tests/agents/queue.test.ts
git commit -m "feat: add SQLite message queue and agent types"
```

---

## Task 4: BaseAgent Abstract Class

**Files:**
- Create: `src/agents/base.ts`
- Create: `tests/agents/base.test.ts`

- [ ] **Step 1: Write the failing test**

Create `tests/agents/base.test.ts`:

```typescript
import { describe, test, expect, beforeEach, afterEach } from 'bun:test'
import Anthropic from '@anthropic-ai/sdk'
import { BaseAgent } from '../../src/agents/base'
import { MessageQueue } from '../../src/agents/queue'
import { AgentRole, MessageType, type Message } from '../../src/agents/types'
import { unlinkSync, existsSync } from 'fs'

const TEST_DB = './test-base.db'

class TestAgent extends BaseAgent {
  readonly role = AgentRole.INTAKE_LEAD
  readonly model = 'claude-sonnet-4-6'
  receivedMessages: Message[] = []

  async handleMessage(message: Message): Promise<void> {
    this.receivedMessages.push(message)
  }
}

describe('BaseAgent', () => {
  let queue: MessageQueue
  let anthropic: Anthropic
  let agent: TestAgent

  beforeEach(() => {
    queue = new MessageQueue(TEST_DB)
    anthropic = new Anthropic({ apiKey: 'test-key' })
    agent = new TestAgent(queue, anthropic)
  })

  afterEach(() => {
    agent.stop()
    queue.close()
    if (existsSync(TEST_DB)) unlinkSync(TEST_DB)
  })

  test('agent has correct role and model', () => {
    expect(agent.role).toBe(AgentRole.INTAKE_LEAD)
    expect(agent.model).toBe('claude-sonnet-4-6')
  })

  test('send puts a message in the queue for the target agent', () => {
    agent.send(AgentRole.ORCHESTRATOR, MessageType.RESULT, { sessionId: 'abc' })
    const msg = queue.receive(AgentRole.ORCHESTRATOR)
    expect(msg).not.toBeNull()
    expect(msg!.from_agent).toBe(AgentRole.INTAKE_LEAD)
    expect(msg!.to_agent).toBe(AgentRole.ORCHESTRATOR)
    expect(msg!.type).toBe(MessageType.RESULT)
  })

  test('run processes a queued message via handleMessage', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'x' })

    const runPromise = agent.run()
    await Bun.sleep(200)
    agent.stop()
    await runPromise

    expect(agent.receivedMessages.length).toBe(1)
    expect((agent.receivedMessages[0].payload as { sessionId: string }).sessionId).toBe('x')
  })

  test('run acks the message after handling', async () => {
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.INTAKE_LEAD, MessageType.DISPATCH, { sessionId: 'y' })

    const runPromise = agent.run()
    await Bun.sleep(200)
    agent.stop()
    await runPromise

    const unacked = queue.receive(AgentRole.INTAKE_LEAD)
    expect(unacked).toBeNull()
  })

  test('stop halts the run loop', async () => {
    const runPromise = agent.run()
    agent.stop()
    await expect(runPromise).resolves.toBeUndefined()
  })

  test('run does not ack message if handleMessage throws', async () => {
    class ThrowingAgent extends BaseAgent {
      readonly role = AgentRole.RESEARCH_LEAD
      readonly model = 'claude-sonnet-4-6'
      async handleMessage(): Promise<void> {
        throw new Error('boom')
      }
    }
    const throwing = new ThrowingAgent(queue, anthropic)
    queue.send(AgentRole.ORCHESTRATOR, AgentRole.RESEARCH_LEAD, MessageType.DISPATCH, { sessionId: 'z' })

    const runPromise = throwing.run()
    await Bun.sleep(300)
    throwing.stop()
    await runPromise

    const stillThere = queue.receive(AgentRole.RESEARCH_LEAD)
    expect(stillThere).not.toBeNull()
  })
})
```

- [ ] **Step 2: Run to verify it fails**

```bash
bun test tests/agents/base.test.ts
```

Expected: FAIL — `Cannot find module '../../src/agents/base'`

- [ ] **Step 3: Implement src/agents/base.ts**

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { MessageQueue } from './queue'
import type { AgentRole, MessageType, Message } from './types'

export abstract class BaseAgent {
  abstract readonly role: AgentRole
  abstract readonly model: string

  protected queue: MessageQueue
  protected anthropic: Anthropic
  private running = false
  private readonly pollIntervalMs = 100

  constructor(queue: MessageQueue, anthropic: Anthropic) {
    this.queue = queue
    this.anthropic = anthropic
  }

  abstract handleMessage(message: Message): Promise<void>

  send(to: AgentRole, type: MessageType, payload: unknown): void {
    this.queue.send(this.role, to, type, payload)
  }

  async run(): Promise<void> {
    this.running = true
    while (this.running) {
      const message = this.queue.receive(this.role)
      if (message) {
        try {
          await this.handleMessage(message)
          this.queue.ack(message.id)
        } catch (err) {
          // Message remains unacked for retry on next poll
          console.error(`[${this.role}] handleMessage error:`, err)
        }
      } else {
        await Bun.sleep(this.pollIntervalMs)
      }
    }
  }

  stop(): void {
    this.running = false
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
bun test tests/agents/base.test.ts
```

Expected: all 5 tests PASS.

- [ ] **Step 5: Run full test suite**

```bash
DATABASE_URL=postgres://postgres:postgres@localhost:5432/job_search bun test
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add src/agents/base.ts tests/agents/base.test.ts
git commit -m "feat: add BaseAgent abstract class"
```

---

## Done

Foundation is complete when:
- `bun test` (with `DATABASE_URL` set) passes all tests
- All three PostgreSQL tables exist and accept inserts
- SQLite message queue correctly routes, delivers, and acks messages
- `BaseAgent` provides `run()`, `stop()`, `send()` for all agent implementations

**Next:** `2026-04-17-agents.md` — implement Orchestrator, all Lead Agents, and all Sub-Agents on top of this foundation.
