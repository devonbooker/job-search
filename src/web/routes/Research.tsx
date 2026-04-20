import { useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api'
import { useSessionStore } from '../state/session'

function formatSalary(avg?: number): string {
  if (!avg) return 'Salary not reported'
  return `~$${Math.round(avg / 1000)}k avg`
}

function formatOpenings(count?: number): string {
  if (count === undefined) return '—'
  return `${new Intl.NumberFormat('en-US').format(count)} openings`
}

export function Research() {
  const nav = useNavigate()
  const { sessionId, jobTitles, skillsByTitle, stage } = useSessionStore()
  const [checked, setChecked] = useState<Set<string>>(new Set())
  const [submitting, setSubmitting] = useState(false)

  if (!jobTitles) {
    return <div><h2>Research</h2><p>Working on it... (stage: {stage})</p></div>
  }

  function toggle(title: string) {
    const next = new Set(checked)
    if (next.has(title)) next.delete(title)
    else next.add(title)
    setChecked(next)
  }

  async function approve() {
    if (!sessionId || checked.size === 0) return
    setSubmitting(true)
    try {
      await api.selectTitles(sessionId, Array.from(checked))
      nav('/resume')
    } finally { setSubmitting(false) }
  }

  return (
    <div>
      <h2>Research</h2>
      {jobTitles.map((jt) => {
        const skills = skillsByTitle?.find(s => s.jobTitle === jt.title)
        return (
          <div key={jt.title} style={{ border: '1px solid #333', borderRadius: 6, padding: 12, marginBottom: 12 }}>
            <label style={{ display: 'flex', alignItems: 'flex-start', gap: 8 }}>
              <input
                type="checkbox"
                checked={checked.has(jt.title)}
                onChange={() => toggle(jt.title)}
                style={{ marginTop: 4 }}
              />
              <div style={{ flex: 1 }}>
                <strong>{jt.title}</strong>
                <div style={{ fontSize: 14, marginTop: 4 }}>{jt.description}</div>
                <div style={{ fontSize: 12, color: 'var(--muted)', marginTop: 4 }}>{jt.relevanceReason}</div>
                <div style={{ fontSize: 12, marginTop: 8 }}>
                  <span>{formatSalary(jt.avgSalaryUsd)}</span>
                  <span style={{ marginLeft: 12 }}>{formatOpenings(jt.openingsCount)}</span>
                </div>
                {skills ? (
                  <div style={{ fontSize: 12, marginTop: 8 }}>
                    <div>Required: {skills.requiredSkills.join(', ')}</div>
                    <div>Nice-to-have: {skills.niceToHaveSkills.join(', ')}</div>
                  </div>
                ) : (
                  <div style={{ fontSize: 12, marginTop: 8, color: 'var(--muted)' }}>Skills loading...</div>
                )}
              </div>
            </label>
          </div>
        )
      })}
      <button onClick={approve} disabled={submitting || checked.size === 0}>
        {submitting ? 'Sending...' : 'Approve titles & build resume'}
      </button>
    </div>
  )
}
