import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useSessionStore } from '../state/session'
import type { BulletItem, ResumeSection } from '../../agents/types'

function renderContent(content: string | BulletItem[]) {
  if (typeof content === 'string') return <p>{content}</p>
  return <ul>{content.map((b, i) => <li key={i}>{b.text}</li>)}</ul>
}

export function Resume() {
  const nav = useNavigate()
  const { sessionId, resumeSections } = useSessionStore()
  const [mode, setMode] = useState<'preview' | 'edit'>('preview')
  const [localSections, setLocalSections] = useState<ResumeSection[] | null>(null)
  const [submitting, setSubmitting] = useState(false)

  if (!resumeSections) return <p>No resume yet. (Still building.)</p>
  const sections = localSections ?? resumeSections

  async function approveResume() {
    if (!sessionId) return
    setSubmitting(true)
    try {
      await api.approveResume(sessionId)
      nav('/jobs')
    } finally {
      setSubmitting(false)
    }
  }

  if (mode === 'preview') {
    return (
      <div>
        <button onClick={() => setMode('edit')}>Edit</button>
        <div style={{ background: '#f5f2ec', color: '#222', padding: 40, fontFamily: 'Georgia, serif', maxWidth: 720, margin: '16px 0' }}>
          {sections.map((s, i) => (
            <section key={i}>
              <h3 style={{ textTransform: 'uppercase', letterSpacing: 1, fontSize: 12, marginTop: 18 }}>{s.title}</h3>
              {renderContent(s.content)}
            </section>
          ))}
        </div>
        <button onClick={approveResume} disabled={submitting}>
          {submitting ? 'Sending...' : 'Approve resume → start job search'}
        </button>
      </div>
    )
  }

  return (
    <div>
      <button onClick={() => setMode('preview')}>Preview</button>
      {sections.map((s, i) => (
        <div key={i} style={{ margin: '16px 0' }}>
          <input
            value={s.title}
            onChange={(e) => {
              const next = [...sections]
              next[i] = { ...next[i], title: e.target.value }
              setLocalSections(next)
            }}
            style={{ width: '100%', fontWeight: 'bold' }}
          />
          <textarea
            value={typeof s.content === 'string' ? s.content : s.content.map(b => '- ' + b.text).join('\n')}
            onChange={(e) => {
              const next = [...sections]
              next[i] = { ...next[i], content: e.target.value }
              setLocalSections(next)
            }}
            rows={5}
            style={{ width: '100%' }}
          />
        </div>
      ))}
    </div>
  )
}
