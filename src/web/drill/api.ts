import type { Verdict, ModelAssessment } from '../../drill/types'

// ─── Snapshot type (mirrors engine.ts SessionSnapshot) ────────────────────────

export interface DrillTranscriptEntry {
  turn: number
  question: string
  answer?: string
  assessment?: ModelAssessment
}

export interface DrillSessionSnapshot {
  sessionId: string
  status: 'in_progress' | 'complete'
  turnsCompleted: number
  transcript: DrillTranscriptEntry[]
  verdict?: Verdict
}

// ─── Typed result union ───────────────────────────────────────────────────────

export type DrillResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number; error: string; field?: string; message?: string }

// ─── Raw fetch helper (no auth header — drill is unauthenticated) ─────────────

async function drillFetch<T>(path: string, init: RequestInit = {}): Promise<DrillResult<T>> {
  let res: Response
  try {
    res = await fetch(path, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.headers ?? {}),
      },
    })
  } catch (e) {
    return { ok: false, status: 0, error: 'Network error', message: String(e) }
  }

  if (res.ok) {
    const data = await res.json() as T
    return { ok: true, data }
  }

  let body: Record<string, unknown> = {}
  try {
    body = await res.json() as Record<string, unknown>
  } catch {
    // ignore parse failure
  }

  return {
    ok: false,
    status: res.status,
    error: typeof body.error === 'string' ? body.error : `HTTP ${res.status}`,
    field: typeof body.field === 'string' ? body.field : undefined,
    message: typeof body.message === 'string' ? body.message : undefined,
  }
}

// ─── API functions ────────────────────────────────────────────────────────────

export function startDrill(
  resume: string,
  jobDescription: string,
  project?: string,
): Promise<DrillResult<{ sessionId: string; firstQuestion: string }>> {
  return drillFetch('/drill/api/start', {
    method: 'POST',
    body: JSON.stringify({ resume, jobDescription, project: project ?? '' }),
  })
}

export function getDrillSession(
  id: string,
): Promise<DrillResult<DrillSessionSnapshot>> {
  return drillFetch(`/drill/api/sessions/${id}`)
}

export function submitAnswer(
  id: string,
  text: string,
): Promise<DrillResult<{ nextQuestion: string | null; completed: boolean; turnsCompleted: number }>> {
  return drillFetch(`/drill/api/sessions/${id}/answer`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  })
}

export function finishDrill(
  id: string,
): Promise<DrillResult<{ verdict: Verdict }>> {
  return drillFetch(`/drill/api/sessions/${id}/finish`, { method: 'POST' })
}
