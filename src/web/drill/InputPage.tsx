import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { startDrill } from './api'

const RESUME_MIN = 200
const JD_MIN = 100

function Counter({ value, min }: { value: number; min: number }) {
  const met = value >= min
  return (
    <span style={{ fontSize: 12, color: met ? '#4caf81' : 'var(--muted)' }}>
      {value} / {min}
    </span>
  )
}

export function InputPage() {
  const nav = useNavigate()
  const [resume, setResume] = useState('')
  const [jd, setJd] = useState('')
  const [project, setProject] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const canSubmit = resume.length >= RESUME_MIN && jd.length >= JD_MIN && !submitting

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!canSubmit) return
    setSubmitting(true)
    setError(null)
    const result = await startDrill(resume, jd, project)
    setSubmitting(false)
    if (!result.ok) {
      const msg = result.message ?? result.error ?? 'Something went wrong'
      setError(result.field ? `${result.field}: ${msg}` : msg)
      return
    }
    nav(`/drill/${result.data.sessionId}`)
  }

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace' }}>
      <h2 style={{ marginBottom: 8 }}>Interview Drill</h2>
      <p style={{ color: 'var(--muted)', marginBottom: 24, fontFamily: 'system-ui' }}>
        Paste your resume and the job description. The drill simulates a real technical interview.
      </p>
      <form onSubmit={handleSubmit}>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ fontWeight: 600 }}>Resume</label>
            <Counter value={resume.length} min={RESUME_MIN} />
          </div>
          <textarea
            value={resume}
            onChange={e => setResume(e.target.value)}
            rows={12}
            placeholder="Paste your full resume text here..."
            style={{
              width: '100%',
              background: 'var(--panel)',
              color: 'var(--fg)',
              border: '1px solid #333',
              borderRadius: 4,
              padding: 10,
              fontFamily: 'monospace',
              fontSize: 13,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ fontWeight: 600 }}>Job Description</label>
            <Counter value={jd.length} min={JD_MIN} />
          </div>
          <textarea
            value={jd}
            onChange={e => setJd(e.target.value)}
            rows={8}
            placeholder="Paste the job description here..."
            style={{
              width: '100%',
              background: 'var(--panel)',
              color: 'var(--fg)',
              border: '1px solid #333',
              borderRadius: 4,
              padding: 10,
              fontFamily: 'monospace',
              fontSize: 13,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>
        <div style={{ marginBottom: 20 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 4 }}>
            <label style={{ fontWeight: 600 }}>Specific project to drill <span style={{ fontWeight: 400, color: 'var(--muted)' }}>(optional)</span></label>
          </div>
          <p style={{ color: 'var(--muted)', fontSize: 12, margin: '0 0 6px', fontFamily: 'system-ui' }}>
            Paste one project description or a GitHub link you want the drill to focus on. Leave empty to let the drill pick from your resume.
          </p>
          <textarea
            value={project}
            onChange={e => setProject(e.target.value)}
            rows={4}
            placeholder="Paste a project description or GitHub link (optional)..."
            style={{
              width: '100%',
              background: 'var(--panel)',
              color: 'var(--fg)',
              border: '1px solid #333',
              borderRadius: 4,
              padding: 10,
              fontFamily: 'monospace',
              fontSize: 13,
              resize: 'vertical',
              boxSizing: 'border-box',
            }}
          />
        </div>
        {error && (
          <div style={{ color: 'var(--danger)', marginBottom: 12, fontSize: 14 }}>{error}</div>
        )}
        <button
          type="submit"
          disabled={!canSubmit}
          style={{
            padding: '10px 24px',
            background: canSubmit ? 'var(--accent)' : '#333',
            color: canSubmit ? '#000' : 'var(--muted)',
            border: 'none',
            borderRadius: 4,
            fontFamily: 'monospace',
            fontSize: 14,
            cursor: canSubmit ? 'pointer' : 'not-allowed',
          }}
        >
          {submitting ? 'Starting...' : 'Start drill'}
        </button>
      </form>
    </div>
  )
}
