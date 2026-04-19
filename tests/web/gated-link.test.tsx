import { describe, test, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { GatedLink } from '../../src/web/components/GatedLink'

describe('GatedLink', () => {
  test('renders as a link when unlocked', () => {
    render(
      <MemoryRouter>
        <GatedLink to="/research" locked={false} lockedReason="x">Research</GatedLink>
      </MemoryRouter>
    )
    expect(screen.getByRole('link', { name: 'Research' })).toBeInTheDocument()
  })

  test('renders as a disabled element with aria-disabled when locked', () => {
    render(
      <MemoryRouter>
        <GatedLink to="/research" locked={true} lockedReason="Complete intake first">Research</GatedLink>
      </MemoryRouter>
    )
    const el = screen.getByText('Research').closest('a, span, div')!
    expect(el.getAttribute('aria-disabled')).toBe('true')
    expect(el.getAttribute('title')).toBe('Complete intake first')
  })
})
