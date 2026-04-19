function token(): string {
  return sessionStorage.getItem('auth-token') ?? ''
}

async function req<T>(path: string, init: RequestInit = {}): Promise<T> {
  const res = await fetch(path, {
    ...init,
    headers: {
      'content-type': 'application/json',
      Authorization: `Bearer ${token()}`,
      ...(init.headers ?? {}),
    },
  })
  if (!res.ok) {
    const body = await res.text()
    throw new Error(`${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export const api = {
  createSession(body: { goals: string; experience: string; preferences: string; resumeRaw?: string }) {
    return req<{ sessionId: string }>('/sessions', { method: 'POST', body: JSON.stringify(body) })
  },
  getSnapshot(sessionId: string) {
    return req<import('../agents/events').Snapshot>(`/sessions/${sessionId}`)
  },
  approve(sessionId: string, targetTitles: string[]) {
    return req<{ ok: true }>(`/sessions/${sessionId}/approve`, {
      method: 'POST',
      body: JSON.stringify({ targetTitles }),
    })
  },
  interview(sessionId: string, body: unknown) {
    return req<{ ok: true }>(`/sessions/${sessionId}/interview`, {
      method: 'POST',
      body: JSON.stringify(body),
    })
  },
  listJobs() {
    return req<unknown[]>('/jobs')
  },
  createJob(body: unknown) {
    return req<unknown>('/jobs', { method: 'POST', body: JSON.stringify(body) })
  },
  updateJob(id: number, body: unknown) {
    return req<unknown>(`/jobs/${id}`, { method: 'PUT', body: JSON.stringify(body) })
  },
  deleteJob(id: number) {
    return req<{ ok: true }>(`/jobs/${id}`, { method: 'DELETE' })
  },
}
