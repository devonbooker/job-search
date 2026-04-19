import { useSessionStore } from '../state/session'

export function ActivityBar() {
  const last = useSessionStore((s) => s.events[s.events.length - 1])
  if (!last) return null
  const text = (last.payload as { message?: string }).message ?? `${last.from}: ${last.type}`
  return (
    <div style={{
      position: 'fixed', bottom: 0, left: 0, right: 0,
      background: 'var(--panel)', padding: '8px 16px',
      borderTop: '1px solid #333', fontSize: 12, color: 'var(--muted)',
    }}>
      ● {text}
    </div>
  )
}
