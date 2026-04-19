import type { ReactNode } from 'react'
import { NavLink } from 'react-router-dom'

interface Props {
  to: string
  locked: boolean
  lockedReason: string
  children: ReactNode
}

export function GatedLink({ to, locked, lockedReason, children }: Props) {
  if (locked) {
    return (
      <span
        aria-disabled="true"
        title={lockedReason}
        style={{ color: 'var(--muted)', opacity: 0.5, padding: '6px 10px', display: 'block' }}
      >
        {children}
      </span>
    )
  }
  return (
    <NavLink to={to} style={{ padding: '6px 10px', display: 'block', color: 'var(--fg)' }}>
      {children}
    </NavLink>
  )
}
