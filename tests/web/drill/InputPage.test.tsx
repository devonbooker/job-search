import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { InputPage } from '../../../src/web/drill/InputPage'

// Mock the drill API module
vi.mock('../../../src/web/drill/api', () => ({
  startDrill: vi.fn(),
}))

import { startDrill } from '../../../src/web/drill/api'

// Mock useNavigate
const mockNavigate = vi.fn()
vi.mock('react-router-dom', async () => {
  const actual = await vi.importActual<typeof import('react-router-dom')>('react-router-dom')
  return { ...actual, useNavigate: () => mockNavigate }
})

function makeResume(len: number) {
  return 'a'.repeat(len)
}
function makeJd(len: number) {
  return 'b'.repeat(len)
}

describe('InputPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  function renderPage() {
    return render(
      <MemoryRouter>
        <InputPage />
      </MemoryRouter>,
    )
  }

  test('Start drill button is disabled when resume < 200 chars', () => {
    renderPage()
    const btn = screen.getByRole('button', { name: /Start drill/i })
    expect(btn).toBeDisabled()
  })

  test('Start drill button is disabled when JD < 100 chars even if resume is long enough', () => {
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/Paste your full resume/i), {
      target: { value: makeResume(200) },
    })
    const btn = screen.getByRole('button', { name: /Start drill/i })
    expect(btn).toBeDisabled()
  })

  test('Start drill button is enabled when both thresholds are met', () => {
    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/Paste your full resume/i), {
      target: { value: makeResume(200) },
    })
    fireEvent.change(screen.getByPlaceholderText(/Paste the job description/i), {
      target: { value: makeJd(100) },
    })
    const btn = screen.getByRole('button', { name: /Start drill/i })
    expect(btn).not.toBeDisabled()
  })

  test('shows counters for resume and JD', () => {
    renderPage()
    // Both counters start at 0
    expect(screen.getByText('0 / 200')).toBeInTheDocument()
    expect(screen.getByText('0 / 100')).toBeInTheDocument()
  })

  test('navigates to /drill/:id on successful submit without project', async () => {
    vi.mocked(startDrill).mockResolvedValue({
      ok: true,
      data: { sessionId: 'sess-abc', firstQuestion: 'Tell me about yourself' },
    })

    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/Paste your full resume/i), {
      target: { value: makeResume(200) },
    })
    fireEvent.change(screen.getByPlaceholderText(/Paste the job description/i), {
      target: { value: makeJd(100) },
    })
    fireEvent.click(screen.getByRole('button', { name: /Start drill/i }))

    await waitFor(() => {
      expect(startDrill).toHaveBeenCalledWith(makeResume(200), makeJd(100), '')
      expect(mockNavigate).toHaveBeenCalledWith('/drill/sess-abc')
    })
  })

  test('passes project text to startDrill when provided', async () => {
    vi.mocked(startDrill).mockResolvedValue({
      ok: true,
      data: { sessionId: 'sess-xyz', firstQuestion: 'Tell me about your project' },
    })

    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/Paste your full resume/i), {
      target: { value: makeResume(200) },
    })
    fireEvent.change(screen.getByPlaceholderText(/Paste the job description/i), {
      target: { value: makeJd(100) },
    })
    fireEvent.change(screen.getByPlaceholderText(/Paste a project description or GitHub link/i), {
      target: { value: 'github.com/devon/my-waf' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Start drill/i }))

    await waitFor(() => {
      expect(startDrill).toHaveBeenCalledWith(makeResume(200), makeJd(100), 'github.com/devon/my-waf')
    })
  })

  test('renders the optional project textarea with label and helper text', () => {
    renderPage()
    expect(screen.getByText(/Specific project to drill/i)).toBeInTheDocument()
    expect(screen.getByText(/Leave empty to let the drill pick from your resume/i)).toBeInTheDocument()
    expect(screen.getByPlaceholderText(/Paste a project description or GitHub link/i)).toBeInTheDocument()
  })

  test('displays error message on API 400 response', async () => {
    vi.mocked(startDrill).mockResolvedValue({
      ok: false,
      status: 400,
      error: 'validation_error',
      field: 'resume',
      message: 'Resume must be at least 200 characters',
    })

    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/Paste your full resume/i), {
      target: { value: makeResume(200) },
    })
    fireEvent.change(screen.getByPlaceholderText(/Paste the job description/i), {
      target: { value: makeJd(100) },
    })
    fireEvent.click(screen.getByRole('button', { name: /Start drill/i }))

    await waitFor(() => {
      expect(screen.getByText(/resume.*Resume must be at least 200 characters/i)).toBeInTheDocument()
    })
  })

  test('displays 502 error message', async () => {
    vi.mocked(startDrill).mockResolvedValue({
      ok: false,
      status: 502,
      error: 'drill_start_failed',
      message: 'Model hiccuped — please retry',
    })

    renderPage()
    fireEvent.change(screen.getByPlaceholderText(/Paste your full resume/i), {
      target: { value: makeResume(200) },
    })
    fireEvent.change(screen.getByPlaceholderText(/Paste the job description/i), {
      target: { value: makeJd(100) },
    })
    fireEvent.click(screen.getByRole('button', { name: /Start drill/i }))

    await waitFor(() => {
      expect(screen.getByText(/Model hiccuped/i)).toBeInTheDocument()
    })
  })
})
