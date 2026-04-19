import { EventEmitter } from 'events'
import { BaseAgent } from '../agents/base'
import { AgentRole, MessageType, type Message } from '../agents/types'
import type {
  ResumeResultPayload,
  ResearchResultPayload,
  InterviewResultPayload,
  IntakeDispatchPayload,
  ApproveResumePayload,
  StartInterviewPayload,
} from '../agents/types'
import type { AgentEvent, AgentEventType, OrchestratorStage, Snapshot } from '../agents/events'

const BUFFER_CAP = 200

interface SessionMeta {
  stage: OrchestratorStage
  emitter: EventEmitter
  buffer: AgentEvent[]
  nextId: number
  subscriberCount: number
  lastActivityAt: number
  jobTitles?: ResearchResultPayload['jobTitles']
  skillsByTitle?: ResearchResultPayload['skillsByTitle']
  resumeSections?: ResumeResultPayload['sections']
  interviewFeedback?: InterviewResultPayload['feedback']
}

function messageTypeToEventType(t: MessageType): AgentEventType {
  switch (t) {
    case MessageType.STATUS: return 'status'
    case MessageType.RESULT: return 'result'
    case MessageType.ERROR: return 'error'
    default: return 'status'
  }
}

function extractSessionId(payload: unknown): string | null {
  if (payload && typeof payload === 'object' && 'sessionId' in payload) {
    const sid = (payload as { sessionId: unknown }).sessionId
    return typeof sid === 'string' ? sid : null
  }
  return null
}

export class HttpApiAgent extends BaseAgent {
  readonly role = AgentRole.HTTP_API
  readonly model = ''
  private sessions = new Map<string, SessionMeta>()
  private static readonly TTL_MS = 60 * 60 * 1000  // 1 hour

  private ensureSession(sessionId: string): SessionMeta {
    let s = this.sessions.get(sessionId)
    if (!s) {
      s = {
        stage: 'idle',
        emitter: new EventEmitter(),
        buffer: [],
        nextId: 1,
        subscriberCount: 0,
        lastActivityAt: Date.now(),
      }
      s.emitter.setMaxListeners(50)
      this.sessions.set(sessionId, s)
    }
    return s
  }

  async handleMessage(msg: Message): Promise<void> {
    const sessionId = extractSessionId(msg.payload)
    if (!sessionId) return

    const session = this.ensureSession(sessionId)

    const event: AgentEvent = {
      id: session.nextId++,
      type: messageTypeToEventType(msg.type),
      from: msg.from_agent,
      payload: msg.payload,
      timestamp: Date.now(),
    }

    session.buffer.push(event)
    while (session.buffer.length > BUFFER_CAP) session.buffer.shift()
    session.lastActivityAt = event.timestamp

    const p = msg.payload as Record<string, unknown>
    if (typeof p.stage === 'string') session.stage = p.stage as OrchestratorStage
    if (msg.from_agent === AgentRole.RESEARCH_LEAD && msg.type === MessageType.RESULT) {
      const r = msg.payload as ResearchResultPayload
      session.jobTitles = r.jobTitles
      session.skillsByTitle = r.skillsByTitle
    }
    if (msg.from_agent === AgentRole.RESUME_LEAD && msg.type === MessageType.RESULT) {
      session.resumeSections = (msg.payload as ResumeResultPayload).sections
    }
    if (msg.from_agent === AgentRole.INTERVIEW_PREP_LEAD && msg.type === MessageType.RESULT) {
      session.interviewFeedback = (msg.payload as InterviewResultPayload).feedback
    }

    session.emitter.emit('event', event)
  }

  getSnapshot(sessionId: string): Snapshot | null {
    const s = this.sessions.get(sessionId)
    if (!s) return null
    return {
      sessionId,
      stage: s.stage,
      events: [...s.buffer],
      jobTitles: s.jobTitles,
      skillsByTitle: s.skillsByTitle,
      resumeSections: s.resumeSections,
      interviewFeedback: s.interviewFeedback,
    }
  }

  startSession(payload: IntakeDispatchPayload): void {
    this.ensureSession(payload.sessionId)
    this.send(AgentRole.ORCHESTRATOR, MessageType.DISPATCH, payload)
  }

  sendCommand(
    sessionId: string,
    payload: ApproveResumePayload | StartInterviewPayload,
  ): void {
    this.ensureSession(sessionId)
    this.send(AgentRole.ORCHESTRATOR, MessageType.DISPATCH, payload)
  }

  subscribe(sessionId: string, lastEventId = 0): AsyncIterable<AgentEvent> {
    const session = this.ensureSession(sessionId)
    return (async function* () {
      session.subscriberCount++
      try {
        for (const e of session.buffer) {
          if (e.id > lastEventId) yield e
        }
        while (true) {
          const next = await new Promise<AgentEvent>((resolve) => {
            session.emitter.once('event', resolve)
          })
          yield next
        }
      } finally {
        session.subscriberCount--
      }
    })()
  }

  purgeStaleSessions(now = Date.now()): void {
    for (const [id, s] of this.sessions) {
      if (s.subscriberCount === 0 && now - s.lastActivityAt > HttpApiAgent.TTL_MS) {
        this.sessions.delete(id)
      }
    }
  }
}
