import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { openEventStream } from '../sse'
import { useSessionStore } from '../state/session'

export function Intake() {
  const nav = useNavigate()
  const setSessionId = useSessionStore(s => s.setSessionId)
  const setFromEvent = useSessionStore(s => s.setFromEvent)

  const [goals, setGoals] = useState('')
  const [experience, setExperience] = useState('')
  const [preferences, setPreferences] = useState('')
  const [resumeRaw, setResumeRaw] = useState<string>('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function submit(e: React.FormEvent) {
    e.preventDefault()
    setSubmitting(true)
    setError(null)
    try {
      const { sessionId } = await api.createSession({ goals, experience, preferences, resumeRaw: resumeRaw || undefined })
      sessionStorage.setItem('sessionId', sessionId)
      setSessionId(sessionId)
      openEventStream(sessionId, setFromEvent)
      nav('/research')
    } catch (err: any) {
      setError(err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function onResumeFile(e: React.ChangeEvent<HTMLInputElement>) {
    const f = e.target.files?.[0]
    if (!f) return
    setResumeRaw(await f.text())
  }

  return (
    <form onSubmit={submit} style={{ maxWidth: 640 }}>
      <h2>Intake</h2>
      <label>Goals<textarea value={goals} onChange={e => setGoals(e.target.value)} required rows={3} style={{ width: '100%' }} /></label>
      <label>Experience<textarea value={experience} onChange={e => setExperience(e.target.value)} required rows={3} style={{ width: '100%' }} /></label>
      <label>Preferences<textarea value={preferences} onChange={e => setPreferences(e.target.value)} required rows={2} style={{ width: '100%' }} /></label>
      <label>Resume (optional .txt / .md)<input type="file" accept=".txt,.md" onChange={onResumeFile} /></label>
      {error && <div style={{ color: 'var(--danger)', margin: '8px 0' }}>{error}</div>}
      <button type="submit" disabled={submitting}>{submitting ? 'Starting...' : 'Start'}</button>
    </form>
  )
}
