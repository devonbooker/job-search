import { useMemo, useState } from 'react'
import { api } from '../api'
import { useSessionStore } from '../state/session'

export function Interview() {
  const { sessionId, resumeSections, skillsByTitle, interviewFeedback, interviewQuestion, setInterviewQuestion } = useSessionStore()
  const [selectedTopic, setSelectedTopic] = useState<string | null>(null)
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)

  const topics = useMemo(() => {
    const fromSections = resumeSections?.map(s => s.title) ?? []
    const fromSkills = skillsByTitle?.flatMap(s => s.requiredSkills) ?? []
    return Array.from(new Set([...fromSections, ...fromSkills]))
  }, [resumeSections, skillsByTitle])

  async function pick(topic: string) {
    if (!sessionId || !resumeSections) return
    setInterviewQuestion('')
    setAnswer('')
    setSelectedTopic(topic)
    setSubmitting(true)
    try {
      await api.interview(sessionId, { resumeSections, selectedTopic: topic })
    } finally { setSubmitting(false) }
  }

  async function submit() {
    if (!sessionId || !resumeSections || !selectedTopic || !interviewQuestion) return
    setSubmitting(true)
    try {
      await api.interview(sessionId, { resumeSections, selectedTopic, userAnswer: answer, question: interviewQuestion })
    } finally { setSubmitting(false) }
  }

  function reset() {
    setSelectedTopic(null)
    setAnswer('')
    setInterviewQuestion('')
  }

  if (!resumeSections) return <p>Finish the resume first.</p>
  if (!selectedTopic) {
    return (
      <div>
        <h2>Interview prep</h2>
        <p>Pick a topic:</p>
        <ul>{topics.map(t => <li key={t}><button onClick={() => pick(t)}>{t}</button></li>)}</ul>
      </div>
    )
  }

  if (!interviewQuestion) {
    return (
      <div>
        <h2>{selectedTopic}</h2>
        <p>Waiting for question... {submitting && '(in flight)'}</p>
        <button onClick={reset}>Cancel</button>
      </div>
    )
  }

  if (!interviewFeedback) {
    return (
      <div>
        <h2>{selectedTopic}</h2>
        <p><strong>Q:</strong> {interviewQuestion}</p>
        <textarea value={answer} onChange={e => setAnswer(e.target.value)} rows={8} style={{ width: '100%' }} />
        <button onClick={submit} disabled={submitting || !answer}>Submit</button>
      </div>
    )
  }

  return (
    <div>
      <h2>Feedback</h2>
      <p><strong>Q:</strong> {interviewFeedback.question}</p>
      <p>{interviewFeedback.feedback}</p>
      <p>Clarity: {interviewFeedback.clarity} - Specificity: {interviewFeedback.specificity}</p>
      <button onClick={reset}>New question</button>
    </div>
  )
}
