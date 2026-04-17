# Job Search Agentic System - Design Spec

**Date:** 2026-04-17
**Status:** Approved

---

## Overview

A web application that uses a hierarchical multi-agent system to assist with job searching - from intake through resume building, job discovery, and interview prep. The agent architecture borrows patterns from Overstory (orchestrator → lead → sub-agent hierarchy, SQLite message passing) but is purpose-built for API-calling agents rather than coding agents.

---

## Stack

| Layer | Technology |
|---|---|
| Runtime | Bun + TypeScript |
| HTTP Server | Hono |
| Frontend | React |
| Agent messaging | SQLite (WAL mode) |
| Persistent data | PostgreSQL |
| Prompt management | Canopy |
| Agent expertise | Mulch |
| AI | Anthropic SDK (Claude) |
| Job search | Adzuna API |
| Web search (research) | Brave Search API |

---

## Agent Hierarchy

```
Orchestrator (Opus)
├── Intake Lead (Opus)
│   └── Profile Builder Sub-Agent (Sonnet)
├── Research Lead (Opus)
│   ├── Job Title Research Sub-Agent (Sonnet)
│   └── Skills Market Research Sub-Agent (Sonnet)
├── Resume Lead (Opus)
│   └── Resume Builder Sub-Agent (Sonnet)
├── Job Search Lead (Opus)
│   └── Adzuna Search Sub-Agent (Sonnet)
└── Interview Prep Lead (Opus)
    └── Topic Drill Sub-Agent (Sonnet)
```

**Model assignment:**
- Orchestrator and all Lead Agents: Claude Opus - handles reasoning, coordination, and domain logic
- All Sub-Agents: Claude Sonnet - handles execution (API calls, data transformation, structured output)

**Communication rules:**
- Orchestrator communicates only with Lead Agents
- Lead Agents communicate with their Sub-Agents and report back to the Orchestrator
- Sub-Agents never communicate directly with the Orchestrator
- All messages pass through a SQLite message queue (WAL mode for concurrent reads)

Each agent is a Bun worker process with a typed message protocol. The Orchestrator drives a workflow state machine; Lead Agents own logic within their domain.

---

## Agent Responsibilities

### Orchestrator
- Owns the overall workflow state machine
- Dispatches work to Lead Agents based on completed stages
- Receives results from Lead Agents and decides next steps
- Never executes domain work directly

### Intake Lead + Profile Builder Sub-Agent
- Conducts a conversational intake to understand what the user wants in a job
- Accepts an optional resume upload as additional context
- Outputs a structured user profile: goals, experience, preferences, uploaded resume text

### Research Lead + Sub-Agents
- **Job Title Research Sub-Agent:** Given the user profile, uses web search (Brave Search API or similar) to find current job titles that match what the user wants to do. Does not rely solely on training knowledge.
- **Skills Market Research Sub-Agent:** For each selected job title, searches current job postings and employer listings to extract required skills. Aggregates across multiple results for signal, not noise.
- Research Lead sequences these two sub-agents and aggregates results

### Resume Lead + Resume Builder Sub-Agent
- Takes the user profile and skills research as input
- Builds a tailored resume that maps the user's existing experience to the target skills
- Outputs structured resume data (sections, bullets) that the user can edit in the UI

### Job Search Lead + Adzuna Search Sub-Agent
- Takes target job titles as search queries
- Calls Adzuna API across relevant job boards
- Deduplicates results and writes job records to PostgreSQL
- Initial stage for all jobs is "not applied"

### Interview Prep Lead + Topic Drill Sub-Agent
- Extracts topics from the approved resume (skills, roles, projects, achievements)
- User selects a topic
- Topic Drill Sub-Agent generates a targeted behavioral or technical question for that topic
- Evaluates the user's written answer for clarity and specificity
- Provides structured feedback

---

## Data Flow

1. User completes intake form, optionally uploads resume
2. Orchestrator receives profile, dispatches to Research Lead
3. Research Lead runs Job Title Sub-Agent, then Skills Market Sub-Agent sequentially
4. Results return to Orchestrator; Orchestrator dispatches to Resume Lead
5. Resume Lead builds resume via Resume Builder Sub-Agent
6. User reviews and approves resume in the web UI
7. Orchestrator dispatches to Job Search Lead
8. Adzuna Search Sub-Agent queries job boards, persists results to PostgreSQL
9. User manages application stages in the job tracker
10. User opens Interview Prep, selects a topic, drills with Topic Drill Sub-Agent

Agent state and in-flight messages are ephemeral in SQLite during a run. Resume, job tracker entries, and user profile are persisted in PostgreSQL.

---

## PostgreSQL Schema (high-level)

**users**
- id, created_at
- goals (text)
- resume_raw (text - uploaded resume)
- resume_built (text - agent-generated resume, JSON structure)
- target_job_titles (text[] - selected from research)

**jobs**
- id, created_at, updated_at
- job_title (text)
- company (text)
- link (text)
- stage (enum: not_applied, applied, phone_screening, interview, booked, offer_received, accepted, rejected)
- source (text - e.g. adzuna)
- notes (text)

**research_results**
- id, user_id, created_at
- job_titles (jsonb)
- skills_by_title (jsonb)

---

## HTTP API

```
POST   /intake                  Submit intake answers + optional resume upload
GET    /research                Get job titles and skills results
POST   /research/targets        Select which job titles to target
GET    /resume                  Get generated resume
PUT    /resume                  Save edits / approve resume
GET    /jobs                    Get all job tracker entries
POST   /jobs                    Add a job manually
PUT    /jobs/:id                Update stage or details
DELETE /jobs/:id                Remove a job
POST   /interview/session       Start an interview prep session
GET    /interview/topics        Get topics derived from resume
POST   /interview/answer        Submit answer, get feedback
GET    /agents/status           Current agent states
GET    /events                  SSE stream for real-time agent updates
```

All responses JSON. The `/events` SSE stream pushes agent status events so the UI can display a live activity feed during agent runs.

---

## Web UI

Five sections. Linear progression on first run; all sections accessible independently after initial setup.

1. **Intake** - Conversational form capturing job goals and experience. Supports resume file upload.
2. **Research** - Displays discovered job titles and a skills matrix per title. User selects which titles to target before proceeding.
3. **Resume** - Displays the agent-generated resume with inline editing. User approves before job search begins.
4. **Job Tracker** - Table view: job title, company, link, stage. Stage is a dropdown. Sortable by stage. Supports manual entry.
5. **Interview Prep** - Topic picker from resume content. Per-topic Q&A: question displayed, user types answer, agent returns structured feedback on clarity and specificity.

Real-time agent activity visible via SSE-fed status bar during any active agent run.

---

## Canopy + Mulch Integration

- **Canopy** manages prompts for each agent role. Prompts are versioned and composable - shared base behavior with role-specific overrides.
- **Mulch** persists learnings across sessions. Agents record domain knowledge (e.g. "for security engineering roles, employers consistently require Kubernetes and Terraform") so subsequent runs improve without re-researching from scratch.
