import { useSessionStore } from '../state/session'

export function Research() {
  const { jobTitles, skillsByTitle, stage } = useSessionStore()

  if (!jobTitles) {
    return <div><h2>Research</h2><p>Working on it... (stage: {stage})</p></div>
  }

  return (
    <div>
      <h2>Research</h2>
      <section>
        <h3>Job titles</h3>
        <ul>
          {jobTitles.map((jt) => (
            <li key={jt.title}>
              <strong>{jt.title}</strong> — {jt.description}
              <div style={{ color: 'var(--muted)', fontSize: 12 }}>{jt.relevanceReason}</div>
            </li>
          ))}
        </ul>
      </section>
      <section>
        <h3>Skills by title</h3>
        {skillsByTitle?.map((s) => (
          <div key={s.jobTitle} style={{ marginBottom: 16 }}>
            <strong>{s.jobTitle}</strong>
            <div>Required: {s.requiredSkills.join(', ')}</div>
            <div>Nice-to-have: {s.niceToHaveSkills.join(', ')}</div>
          </div>
        ))}
      </section>
    </div>
  )
}
