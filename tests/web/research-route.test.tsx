import { describe, test, expect, beforeEach, vi } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { Research } from '../../src/web/routes/Research'
import { useSessionStore } from '../../src/web/state/session'

vi.mock('../../src/web/api', () => ({
  api: {
    selectTitles: vi.fn(async () => ({ ok: true as const })),
  },
}))

import { api } from '../../src/web/api'

describe('Research route', () => {
  beforeEach(() => {
    useSessionStore.getState().reset()
    vi.clearAllMocks()
  })

  test('shows working-on-it placeholder when jobTitles undefined', () => {
    useSessionStore.setState({ sessionId: 's1', stage: 'researching' })
    render(<MemoryRouter><Research /></MemoryRouter>)
    expect(screen.getByText(/Working on it/)).toBeInTheDocument()
  })

  test('renders title rows with salary and openings when present', () => {
    useSessionStore.setState({
      sessionId: 's1',
      stage: 'awaiting_title_selection',
      jobTitles: [
        { title: 'Security Engineer', description: 'd', relevanceReason: 'r', avgSalaryUsd: 135000, openingsCount: 1247 },
      ],
      skillsByTitle: [{ jobTitle: 'Security Engineer', requiredSkills: ['AWS'], niceToHaveSkills: ['Go'] }],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    expect(screen.getByText('Security Engineer')).toBeInTheDocument()
    expect(screen.getByText(/~\$135k avg/)).toBeInTheDocument()
    expect(screen.getByText(/1,247 openings/)).toBeInTheDocument()
    expect(screen.getByText(/AWS/)).toBeInTheDocument()
  })

  test('renders fallbacks when stats are absent', () => {
    useSessionStore.setState({
      sessionId: 's1',
      stage: 'awaiting_title_selection',
      jobTitles: [{ title: 'A', description: 'd', relevanceReason: 'r' }],
      skillsByTitle: [],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    expect(screen.getByText(/Salary not reported/)).toBeInTheDocument()
  })

  test('approve button is disabled until at least one checkbox is checked', () => {
    useSessionStore.setState({
      sessionId: 's1',
      stage: 'awaiting_title_selection',
      jobTitles: [{ title: 'A', description: 'd', relevanceReason: 'r' }],
      skillsByTitle: [],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    const button = screen.getByRole('button', { name: /Approve titles/ })
    expect(button).toBeDisabled()
    fireEvent.click(screen.getByRole('checkbox'))
    expect(button).toBeEnabled()
  })

  test('approve click POSTs selected titles', async () => {
    useSessionStore.setState({
      sessionId: 'sess-x',
      stage: 'awaiting_title_selection',
      jobTitles: [
        { title: 'A', description: 'd', relevanceReason: 'r' },
        { title: 'B', description: 'd', relevanceReason: 'r' },
      ],
      skillsByTitle: [],
    })
    render(<MemoryRouter><Research /></MemoryRouter>)
    fireEvent.click(screen.getAllByRole('checkbox')[1])
    fireEvent.click(screen.getByRole('button', { name: /Approve titles/ }))
    await waitFor(() => {
      expect(api.selectTitles).toHaveBeenCalledWith('sess-x', ['B'])
    })
  })
})
