import type { ReactNode } from 'react'
import { useSessionStore } from '../state/session'
import { GatedLink } from './GatedLink'
import { ActivityBar } from './ActivityBar'

export function Layout({ children }: { children: ReactNode }) {
  const { jobTitles, resumeSections } = useSessionStore()

  return (
    <div style={{ display: 'flex', minHeight: '100vh' }}>
      <aside style={{ width: 180, background: 'var(--panel)', padding: 12 }}>
        <h3 style={{ margin: '4px 0 12px' }}>job-search</h3>
        <GatedLink to="/intake" locked={false} lockedReason="">Intake</GatedLink>
        <GatedLink to="/research" locked={!jobTitles} lockedReason="Complete intake first">Research</GatedLink>
        <GatedLink to="/resume" locked={!resumeSections} lockedReason="Complete research first">Resume</GatedLink>
        <GatedLink to="/jobs" locked={false} lockedReason="">Jobs</GatedLink>
        <GatedLink to="/interview" locked={!resumeSections} lockedReason="Approve resume first">Interview</GatedLink>
      </aside>
      <main style={{ flex: 1, padding: '20px 20px 64px' }}>{children}</main>
      <ActivityBar />
    </div>
  )
}
