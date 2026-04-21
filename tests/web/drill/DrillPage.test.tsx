import { describe, test, expect, vi, beforeEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import { DrillPage } from '../../../src/web/drill/DrillPage'
import type { DrillSessionSnapshot } from '../../../src/web/drill/api'

vi.mock('../../../src/web/drill/api', () => ({
  getDrillSession: vi.fn(),
  submitAnswer: vi.fn(),
  finishDrill: vi.fn(),
}))

import { getDrillSession, submitAnswer, finishDrill } from '../../../src/web/drill/api'

function makeSnapshot(overrides: Partial<DrillSessionSnapshot> = {}): DrillSessionSnapshot {
  return {
    sessionId: 'sess-1',
    status: 'in_progress',
    turnsCompleted: 0,
    transcript: [{ turn: 1, question: 'What is a goroutine?' }],
    ...overrides,
  }
}

function renderDrillPage(sessionId = 'sess-1') {
  return render(
    <MemoryRouter initialEntries={[`/drill/${sessionId}`]}>
      <Routes>
        <Route path="/drill/:sessionId" element={<DrillPage />} />
        <Route path="/drill" element={<div>Input Page</div>} />
      </Routes>
    </MemoryRouter>,
  )
}

describe('DrillPage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  test('shows first question from snapshot on initial render', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot(),
    })

    renderDrillPage()

    await waitFor(() => {
      expect(screen.getByText('What is a goroutine?')).toBeInTheDocument()
    })
  })

  test('submit answer calls API and renders next question', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot(),
    })
    vi.mocked(submitAnswer).mockResolvedValue({
      ok: true,
      data: { nextQuestion: 'Explain channels in Go', completed: false, turnsCompleted: 1 },
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: 'A goroutine is a lightweight thread managed by the Go runtime.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }))

    await waitFor(() => {
      expect(submitAnswer).toHaveBeenCalledWith('sess-1', 'A goroutine is a lightweight thread managed by the Go runtime.')
      expect(screen.getByText('Explain channels in Go')).toBeInTheDocument()
    })
  })

  test('prior Q/A appended to transcript after submit', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot(),
    })
    vi.mocked(submitAnswer).mockResolvedValue({
      ok: true,
      data: { nextQuestion: 'Explain channels in Go', completed: false, turnsCompleted: 1 },
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: 'A goroutine is a lightweight thread.' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }))

    await waitFor(() => {
      // The prior question appears in transcript (muted style, smaller)
      expect(screen.getByText('What is a goroutine?')).toBeInTheDocument()
      // Answer also in transcript
      expect(screen.getByText('A goroutine is a lightweight thread.')).toBeInTheDocument()
    })
  })

  test('Finish button is hidden when turnsCompleted < 3', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot({ turnsCompleted: 2 }),
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    expect(screen.queryByRole('button', { name: /Finish drill/i })).not.toBeInTheDocument()
  })

  test('Finish button is shown when turnsCompleted >= 3', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot({ turnsCompleted: 3 }),
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    expect(screen.getByRole('button', { name: /Finish drill/i })).toBeInTheDocument()
  })

  test('409 on submit triggers re-fetch and transitions to verdict', async () => {
    vi.mocked(getDrillSession)
      .mockResolvedValueOnce({ ok: true, data: makeSnapshot({ turnsCompleted: 3 }) })
      .mockResolvedValueOnce({
        ok: true,
        data: makeSnapshot({
          status: 'complete',
          turnsCompleted: 5,
          transcript: [{ turn: 1, question: 'What is a goroutine?', answer: 'A goroutine is...', assessment: 'solid' }],
          verdict: {
            target_role: 'Backend Engineer',
            project_drilled: 'Go microservice',
            solid: ['Strong goroutine understanding'],
            weak: [],
            interviewer_verdict: 'Solid candidate',
            overall: 'Solid',
            overall_summary: 'Good overall',
          },
        }),
      })
    vi.mocked(submitAnswer).mockResolvedValue({
      ok: false,
      status: 409,
      error: 'session_complete',
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: 'My answer' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }))

    await waitFor(() => {
      expect(screen.getByText('Backend Engineer')).toBeInTheDocument()
      expect(screen.getByText('SOLID')).toBeInTheDocument()
    })
  })

  test('502 on submit shows retry button', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot(),
    })
    vi.mocked(submitAnswer).mockResolvedValue({
      ok: false,
      status: 502,
      error: 'drill_turn_failed',
      message: 'Model hiccuped — please retry',
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: 'My answer' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }))

    await waitFor(() => {
      expect(screen.getByText(/Model hiccuped/i)).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Continue to retry/i })).toBeInTheDocument()
    })
  })

  test('Finish button triggers finishDrill and renders verdict', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot({ turnsCompleted: 4 }),
    })
    vi.mocked(finishDrill).mockResolvedValue({
      ok: true,
      data: {
        verdict: {
          target_role: 'Backend Engineer',
          project_drilled: 'Go microservice',
          solid: ['Strong goroutine understanding'],
          weak: [],
          interviewer_verdict: 'Solid candidate',
          overall: 'Solid',
          overall_summary: 'Good overall',
        },
      },
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    fireEvent.click(screen.getByRole('button', { name: /Finish drill/i }))

    await waitFor(() => {
      expect(finishDrill).toHaveBeenCalledWith('sess-1')
      expect(screen.getByText('SOLID')).toBeInTheDocument()
      expect(screen.getByText('Backend Engineer')).toBeInTheDocument()
    })
  })

  test('completed:true auto-finish after submit renders verdict without user clicking Finish', async () => {
    vi.mocked(getDrillSession).mockResolvedValue({
      ok: true,
      data: makeSnapshot({ turnsCompleted: 6 }),
    })
    vi.mocked(submitAnswer).mockResolvedValue({
      ok: true,
      data: { nextQuestion: null, completed: true, turnsCompleted: 7 },
    })
    vi.mocked(finishDrill).mockResolvedValue({
      ok: true,
      data: {
        verdict: {
          target_role: 'Cloud Security Engineer',
          project_drilled: 'WAF project',
          solid: ['Good security fundamentals'],
          weak: ['Needs more Kubernetes depth'],
          interviewer_verdict: 'Hire with reservations',
          overall: 'Borderline',
          overall_summary: 'Mixed bag overall',
        },
      },
    })

    renderDrillPage()
    await waitFor(() => screen.getByText('What is a goroutine?'))

    fireEvent.change(screen.getByPlaceholderText(/Type your answer/i), {
      target: { value: 'My final answer' },
    })
    fireEvent.click(screen.getByRole('button', { name: /Submit/i }))

    await waitFor(() => {
      expect(finishDrill).toHaveBeenCalledWith('sess-1')
      expect(screen.getByText('BORDERLINE')).toBeInTheDocument()
      expect(screen.getByText('Cloud Security Engineer')).toBeInTheDocument()
    })
  })
})
