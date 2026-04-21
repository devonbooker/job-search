import { useState } from 'react'
import { Link } from 'react-router-dom'
import type { Verdict } from '../../drill/types'
import type { DrillTranscriptEntry } from './api'

interface VerdictPageProps {
  verdict: Verdict
  transcript: DrillTranscriptEntry[]
}

export function VerdictPage({ verdict, transcript }: VerdictPageProps) {
  const [transcriptOpen, setTranscriptOpen] = useState(false)

  const overallColor =
    verdict.overall === 'Solid' ? '#4caf81'
    : verdict.overall === 'Borderline' ? '#e0a84a'
    : 'var(--danger)'

  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace' }}>
      <h2 style={{ marginBottom: 4 }}>
        {verdict.target_role}
      </h2>
      <p style={{ color: 'var(--muted)', marginBottom: 24, fontSize: 13 }}>
        Project drilled: {verdict.project_drilled}
      </p>

      {/* Overall badge */}
      <div style={{
        display: 'inline-block',
        padding: '6px 16px',
        border: `2px solid ${overallColor}`,
        color: overallColor,
        borderRadius: 4,
        fontWeight: 700,
        fontSize: 16,
        marginBottom: 24,
      }}>
        {verdict.overall.toUpperCase()}
      </div>

      {/* Interviewer verdict */}
      <div style={{
        background: 'var(--panel)',
        border: '1px solid #333',
        borderRadius: 4,
        padding: '14px 16px',
        marginBottom: 24,
        fontSize: 14,
        lineHeight: 1.6,
      }}>
        <div style={{ fontWeight: 700, marginBottom: 6, color: 'var(--muted)', fontSize: 12, textTransform: 'uppercase' }}>
          Interviewer Verdict
        </div>
        {verdict.interviewer_verdict}
      </div>

      {/* Solid */}
      {verdict.solid.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ color: '#4caf81', marginBottom: 8, fontSize: 14, textTransform: 'uppercase' }}>Solid</h3>
          <ul style={{ paddingLeft: 20, margin: 0 }}>
            {verdict.solid.map((item, i) => {
              const text = typeof item === 'string'
                ? item
                : `${(item as any).area ?? ''}${(item as any).evidence ? ' - ' + (item as any).evidence : (item as any).why ? ' - ' + (item as any).why : ''}`
              return <li key={i} style={{ marginBottom: 6, fontSize: 14, lineHeight: 1.5 }}>{text}</li>
            })}
          </ul>
        </div>
      )}

      {/* Weak */}
      {verdict.weak.length > 0 && (
        <div style={{ marginBottom: 24 }}>
          <h3 style={{ color: 'var(--danger)', marginBottom: 8, fontSize: 14, textTransform: 'uppercase' }}>Weak</h3>
          {verdict.weak.map((item, i) => (
            <div key={i} style={{
              background: 'var(--panel)',
              border: '1px solid #3a2020',
              borderRadius: 4,
              padding: '10px 14px',
              marginBottom: 10,
              fontSize: 13,
            }}>
              <div style={{ fontWeight: 700, marginBottom: 4 }}>{item.area}</div>
              <div style={{ color: 'var(--muted)', marginBottom: 6 }}>{item.why}</div>
              <div style={{ fontSize: 12, color: '#a0a0a0', fontStyle: 'italic' }}>
                e.g. &ldquo;{item.example_question}&rdquo;
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Overall summary */}
      {verdict.overall_summary && (
        <div style={{ color: 'var(--muted)', fontSize: 13, marginBottom: 24 }}>
          {verdict.overall_summary}
        </div>
      )}

      {/* Collapsible transcript */}
      <div style={{ marginBottom: 24 }}>
        <button
          onClick={() => setTranscriptOpen(o => !o)}
          style={{
            background: 'none',
            border: '1px solid #444',
            color: 'var(--muted)',
            padding: '6px 14px',
            borderRadius: 4,
            fontFamily: 'monospace',
            cursor: 'pointer',
            fontSize: 13,
          }}
        >
          {transcriptOpen ? 'Hide' : 'Show'} full transcript
        </button>
        {transcriptOpen && (
          <div style={{ marginTop: 12 }}>
            {transcript.map((entry) => (
              <div key={entry.turn} style={{ marginBottom: 16 }}>
                <div style={{
                  color: 'var(--accent)',
                  fontSize: 12,
                  marginBottom: 4,
                }}>
                  Q{entry.turn}
                </div>
                <div style={{ fontSize: 13, marginBottom: 6 }}>{entry.question}</div>
                {entry.answer != null && (
                  <>
                    <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 2 }}>
                      A {entry.assessment && (
                        <span style={{
                          color: entry.assessment === 'solid' ? '#4caf81'
                            : entry.assessment === 'partial' ? '#e0a84a'
                            : 'var(--danger)',
                        }}>
                          [{entry.assessment}]
                        </span>
                      )}
                    </div>
                    <div style={{ fontSize: 13, color: 'var(--muted)' }}>{entry.answer}</div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <Link
        to="/drill"
        style={{
          display: 'inline-block',
          padding: '10px 20px',
          background: 'var(--panel)',
          border: '1px solid #444',
          color: 'var(--fg)',
          textDecoration: 'none',
          borderRadius: 4,
          fontFamily: 'monospace',
          fontSize: 13,
        }}
      >
        Run another drill
      </Link>
    </div>
  )
}

// ─── Fallback when verdict generation failed ──────────────────────────────────

interface VerdictFallbackProps {
  transcript: DrillTranscriptEntry[]
}

export function VerdictFallback({ transcript }: VerdictFallbackProps) {
  return (
    <div style={{ maxWidth: 720, margin: '40px auto', padding: '0 20px', fontFamily: 'monospace' }}>
      <div style={{
        background: '#2a1a0a',
        border: '1px solid #5a3a10',
        borderRadius: 4,
        padding: '12px 16px',
        marginBottom: 24,
        fontSize: 14,
        color: '#e0a84a',
      }}>
        Verdict temporarily unavailable - here's your transcript
      </div>
      {transcript.map((entry) => (
        <div key={entry.turn} style={{ marginBottom: 20 }}>
          <div style={{ color: 'var(--accent)', fontSize: 12, marginBottom: 4 }}>Q{entry.turn}</div>
          <div style={{ fontSize: 14, marginBottom: 8 }}>{entry.question}</div>
          {entry.answer != null && (
            <>
              <div style={{ color: 'var(--muted)', fontSize: 12, marginBottom: 4 }}>
                Your answer {entry.assessment && (
                  <span style={{
                    color: entry.assessment === 'solid' ? '#4caf81'
                      : entry.assessment === 'partial' ? '#e0a84a'
                      : 'var(--danger)',
                  }}>
                    [{entry.assessment}]
                  </span>
                )}
              </div>
              <div style={{ fontSize: 13, color: 'var(--muted)' }}>{entry.answer}</div>
            </>
          )}
        </div>
      ))}
      <Link
        to="/drill"
        style={{
          display: 'inline-block',
          padding: '10px 20px',
          background: 'var(--panel)',
          border: '1px solid #444',
          color: 'var(--fg)',
          textDecoration: 'none',
          borderRadius: 4,
          fontFamily: 'monospace',
          fontSize: 13,
        }}
      >
        Run another drill
      </Link>
    </div>
  )
}
