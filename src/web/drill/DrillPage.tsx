import { useEffect, useState, useRef } from 'react'
import { useParams, useNavigate } from 'react-router-dom'
import { getDrillSession, submitAnswer, finishDrill } from './api'
import type { DrillSessionSnapshot, DrillTranscriptEntry } from './api'
import { VerdictPage, VerdictFallback } from './VerdictPage'
import type { Verdict } from '../../drill/types'

// ─── Transcript display ───────────────────────────────────────────────────────

function TranscriptView({ entries }: { entries: DrillTranscriptEntry[] }) {
  if (entries.length === 0) return null
  return (
    <div style={{
      maxHeight: 280,
      overflowY: 'auto',
      marginBottom: 24,
      borderBottom: '1px solid #333',
      paddingBottom: 16,
    }}>
      {entries.map((entry) => (
        <div key={entry.turn} style={{ marginBottom: 14 }}>
          <div style={{ color: 'var(--accent)', fontSize: 12, marginBottom: 2 }}>Q{entry.turn}</div>
          <div style={{ fontSize: 13, marginBottom: 4, color: 'var(--muted)' }}>{entry.question}</div>
          {entry.answer != null && (
            <div style={{ fontSize: 13, paddingLeft: 12, borderLeft: '2px solid #333' }}>
              {entry.answer}
              {entry.assessment && (
                <span style={{
                  marginLeft: 8,
                  fontSize: 11,
                  color: entry.assessment === 'solid' ? '#4caf81'
                    : entry.assessment === 'partial' ? '#e0a84a'
                    : 'var(--danger)',
                }}>
                  [{entry.assessment}]
                </span>
              )}
            </div>
          )}
        </div>
      ))}
    </div>
  )
}

// ─── Main DrillPage ───────────────────────────────────────────────────────────

type PageState =
  | { phase: 'loading' }
  | { phase: 'error'; message: string }
  | { phase: 'drilling'; snapshot: DrillSessionSnapshot; currentQuestion: string; completedEntries: DrillTranscriptEntry[] }
  | { phase: 'verdict'; verdict: Verdict; transcript: DrillTranscriptEntry[] }
  | { phase: 'verdict_fallback'; transcript: DrillTranscriptEntry[] }

export function DrillPage() {
  const { sessionId } = useParams<{ sessionId: string }>()
  const nav = useNavigate()

  const [state, setState] = useState<PageState>({ phase: 'loading' })
  const [answer, setAnswer] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [submitError, setSubmitError] = useState<string | null>(null)
  const [retryText, setRetryText] = useState<string | null>(null)
  const [finishing, setFinishing] = useState(false)

  // Track if we've already fetched to avoid double-fetch in StrictMode
  const fetchedRef = useRef(false)

  useEffect(() => {
    if (!sessionId || fetchedRef.current) return
    fetchedRef.current = true

    getDrillSession(sessionId).then((result) => {
      if (!result.ok) {
        setState({ phase: 'error', message: result.message ?? result.error })
        return
      }
      initFromSnapshot(result.data)
    })
  }, [sessionId])

  function initFromSnapshot(snap: DrillSessionSnapshot) {
    if (snap.status === 'complete') {
      if (snap.verdict) {
        setState({ phase: 'verdict', verdict: snap.verdict, transcript: snap.transcript })
      } else {
        setState({ phase: 'verdict_fallback', transcript: snap.transcript })
      }
      return
    }

    // In-progress: last transcript entry is the current unanswered question
    const last = snap.transcript[snap.transcript.length - 1]
    const currentQuestion = last?.question ?? ''
    // All entries with answers are the prior transcript
    const completedEntries = snap.transcript.filter(e => e.answer != null)

    setState({ phase: 'drilling', snapshot: snap, currentQuestion, completedEntries })
  }

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault()
    if (!sessionId || state.phase !== 'drilling') return
    const text = answer.trim()
    if (!text) return

    setSubmitting(true)
    setSubmitError(null)
    setRetryText(null)

    const result = await submitAnswer(sessionId, text)
    setSubmitting(false)

    if (!result.ok) {
      if (result.status === 409) {
        // Session is complete — re-fetch to get verdict
        fetchedRef.current = false
        setState({ phase: 'loading' })
        const snap = await getDrillSession(sessionId)
        if (snap.ok) {
          initFromSnapshot(snap.data)
        }
        return
      }
      if (result.status === 502) {
        // Model hiccup — show retry
        setRetryText(text)
        setSubmitError("Model hiccuped - click Continue to retry")
        return
      }
      setSubmitError(result.message ?? result.error)
      return
    }

    const { nextQuestion, completed, turnsCompleted } = result.data
    const currentEntry = state.snapshot.transcript.find(
      e => e.question === state.currentQuestion && e.answer == null
    )
    const currentTurn = currentEntry?.turn ?? state.completedEntries.length + 1

    const newEntry: DrillTranscriptEntry = {
      turn: currentTurn,
      question: state.currentQuestion,
      answer: text,
    }
    const newCompleted = [...state.completedEntries, newEntry]

    if (completed || nextQuestion === null) {
      // Auto-finish
      await handleFinishInternal(sessionId, newCompleted)
      return
    }

    setState({
      phase: 'drilling',
      snapshot: { ...state.snapshot, turnsCompleted },
      currentQuestion: nextQuestion,
      completedEntries: newCompleted,
    })
    setAnswer('')
  }

  async function handleFinishInternal(sid: string, completedEntries: DrillTranscriptEntry[]) {
    const result = await finishDrill(sid)
    if (!result.ok) {
      if (result.status === 502) {
        // Verdict failed — show fallback
        setState({ phase: 'verdict_fallback', transcript: completedEntries })
        return
      }
      setSubmitError(result.message ?? result.error)
      return
    }
    setState({ phase: 'verdict', verdict: result.data.verdict, transcript: completedEntries })
  }

  async function handleFinishClick() {
    if (!sessionId || state.phase !== 'drilling') return
    setFinishing(true)
    setSubmitError(null)
    await handleFinishInternal(sessionId, state.completedEntries)
    setFinishing(false)
  }

  async function handleRetry() {
    if (!retryText || !sessionId) return
    setAnswer(retryText)
    setRetryText(null)
    setSubmitError(null)
  }

  // ─── Render phases ──────────────────────────────────────────────────────────

  if (state.phase === 'loading') {
    return (
      <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace', color: 'var(--muted)' }}>
        Loading session...
      </div>
    )
  }

  if (state.phase === 'error') {
    return (
      <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace' }}>
        <div style={{ color: 'var(--danger)', marginBottom: 12 }}>{state.message}</div>
        <button onClick={() => nav('/drill')} style={{ fontFamily: 'monospace', cursor: 'pointer' }}>
          Back to start
        </button>
      </div>
    )
  }

  if (state.phase === 'verdict') {
    return <VerdictPage verdict={state.verdict} transcript={state.transcript} />
  }

  if (state.phase === 'verdict_fallback') {
    return <VerdictFallback transcript={state.transcript} />
  }

  // Drilling phase
  const { snapshot, currentQuestion, completedEntries } = state
  const showFinish = snapshot.turnsCompleted >= 3

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace' }}>
      <TranscriptView entries={completedEntries} />

      <div style={{
        fontSize: 18,
        fontWeight: 600,
        marginBottom: 20,
        lineHeight: 1.5,
        color: 'var(--fg)',
      }}>
        {currentQuestion}
      </div>

      <form onSubmit={handleSubmit}>
        <textarea
          value={answer}
          onChange={e => setAnswer(e.target.value)}
          rows={6}
          placeholder="Type your answer..."
          disabled={submitting}
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
            opacity: submitting ? 0.6 : 1,
          }}
        />
        <div style={{ display: 'flex', gap: 10, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button
            type="submit"
            disabled={submitting || !answer.trim()}
            style={{
              padding: '8px 20px',
              background: submitting || !answer.trim() ? '#333' : 'var(--accent)',
              color: submitting || !answer.trim() ? 'var(--muted)' : '#000',
              border: 'none',
              borderRadius: 4,
              fontFamily: 'monospace',
              cursor: submitting || !answer.trim() ? 'not-allowed' : 'pointer',
            }}
          >
            {submitting ? 'Thinking...' : 'Submit'}
          </button>
          {showFinish && (
            <button
              type="button"
              onClick={handleFinishClick}
              disabled={finishing || submitting}
              style={{
                padding: '8px 20px',
                background: 'none',
                border: '1px solid #555',
                color: 'var(--muted)',
                borderRadius: 4,
                fontFamily: 'monospace',
                cursor: finishing || submitting ? 'not-allowed' : 'pointer',
              }}
            >
              {finishing ? 'Finishing...' : 'Finish drill'}
            </button>
          )}
        </div>
        {submitError && (
          <div style={{ color: 'var(--danger)', marginTop: 10, fontSize: 13 }}>
            {submitError}
            {retryText && (
              <button
                type="button"
                onClick={handleRetry}
                style={{
                  marginLeft: 10,
                  background: 'none',
                  border: '1px solid var(--danger)',
                  color: 'var(--danger)',
                  borderRadius: 4,
                  padding: '2px 10px',
                  fontFamily: 'monospace',
                  cursor: 'pointer',
                  fontSize: 13,
                }}
              >
                Continue to retry
              </button>
            )}
          </div>
        )}
      </form>

      <div style={{ marginTop: 24, fontSize: 12, color: 'var(--muted)' }}>
        Turn {snapshot.turnsCompleted + 1}
      </div>
    </div>
  )
}
