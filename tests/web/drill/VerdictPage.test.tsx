import { describe, test, expect } from 'vitest'
import { render, screen, fireEvent } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { VerdictPage, VerdictFallback } from '../../../src/web/drill/VerdictPage'
import type { Verdict } from '../../../src/drill/types'
import type { DrillTranscriptEntry } from '../../../src/web/drill/api'

const baseVerdict: Verdict = {
  target_role: 'Security Infrastructure Engineer',
  project_drilled: 'AWS WAF deployment',
  solid: ['Strong Terraform knowledge', 'Clear understanding of IAM roles'],
  weak: [
    {
      area: 'Container security',
      why: 'Could not explain seccomp profiles',
      example_question: 'How would you restrict syscalls in a container?',
      how_to_fix: 'Read the Linux seccomp man page and the Docker seccomp profile docs. Write a custom seccomp profile that blocks ptrace. Test it with strace on a running container.',
      model_answer: 'We applied a custom seccomp profile that whitelisted only the syscalls our app needed. We used Docker audit mode first to capture the full syscall surface, then stripped everything else. The profile blocked ptrace and mount entirely.',
    },
  ],
  interviewer_verdict: 'Devon showed solid infra fundamentals but container security depth needs work.',
  overall: 'Borderline',
  overall_summary: 'Good foundation, needs more depth in container security.',
}

const baseTranscript: DrillTranscriptEntry[] = [
  { turn: 1, question: 'Tell me about Terraform.', answer: 'I use it daily.', assessment: 'solid' },
  { turn: 2, question: 'What is seccomp?', answer: 'I am not sure.', assessment: 'weak' },
]

function renderVerdict(verdict = baseVerdict, transcript = baseTranscript) {
  return render(
    <MemoryRouter>
      <VerdictPage verdict={verdict} transcript={transcript} />
    </MemoryRouter>,
  )
}

describe('VerdictPage', () => {
  test('renders target role and project drilled', () => {
    renderVerdict()
    expect(screen.getByText('Security Infrastructure Engineer')).toBeInTheDocument()
    expect(screen.getByText(/AWS WAF deployment/)).toBeInTheDocument()
  })

  test('renders overall badge', () => {
    renderVerdict()
    expect(screen.getByText('BORDERLINE')).toBeInTheDocument()
  })

  test('renders solid items', () => {
    renderVerdict()
    expect(screen.getByText('Strong Terraform knowledge')).toBeInTheDocument()
    expect(screen.getByText('Clear understanding of IAM roles')).toBeInTheDocument()
  })

  test('renders weak items with area, why, and example_question', () => {
    renderVerdict()
    expect(screen.getByText('Container security')).toBeInTheDocument()
    expect(screen.getByText('Could not explain seccomp profiles')).toBeInTheDocument()
    expect(screen.getByText(/How would you restrict syscalls/)).toBeInTheDocument()
  })

  test('renders interviewer verdict block', () => {
    renderVerdict()
    expect(screen.getByText(/Devon showed solid infra fundamentals/)).toBeInTheDocument()
  })

  test('transcript is collapsed by default and expands on click', () => {
    renderVerdict()
    // Questions should not be visible in transcript section yet
    const showBtn = screen.getByRole('button', { name: /Show full transcript/i })
    expect(showBtn).toBeInTheDocument()

    fireEvent.click(showBtn)

    expect(screen.getAllByText('Tell me about Terraform.').length).toBeGreaterThan(0)
    expect(screen.getAllByText('I use it daily.').length).toBeGreaterThan(0)
  })

  test('transcript entries show assessment tags when expanded', () => {
    renderVerdict()
    fireEvent.click(screen.getByRole('button', { name: /Show full transcript/i }))
    expect(screen.getByText('[solid]')).toBeInTheDocument()
    expect(screen.getByText('[weak]')).toBeInTheDocument()
  })

  test('Run another drill link goes to /drill', () => {
    renderVerdict()
    const link = screen.getByRole('link', { name: /Run another drill/i })
    expect(link).toHaveAttribute('href', '/drill')
  })

  test('renders how_to_fix subsection when present', () => {
    renderVerdict()
    expect(screen.getByText(/How to close this gap/i)).toBeInTheDocument()
    expect(screen.getByText(/Read the Linux seccomp man page/i)).toBeInTheDocument()
  })

  test('renders model_answer subsection when present', () => {
    renderVerdict()
    expect(screen.getByText(/What a solid answer looks like/i)).toBeInTheDocument()
    expect(screen.getByText(/We applied a custom seccomp profile/i)).toBeInTheDocument()
  })

  test('does not crash when how_to_fix and model_answer are absent (backward compat)', () => {
    const oldStyleVerdict: Verdict = {
      ...baseVerdict,
      weak: [
        {
          area: 'Container security',
          why: 'Could not explain seccomp profiles',
          example_question: 'How would you restrict syscalls in a container?',
          // no how_to_fix, no model_answer
        },
      ],
    }
    expect(() => renderVerdict(oldStyleVerdict)).not.toThrow()
    // Neither new subsection should appear
    expect(screen.queryByText(/How to close this gap/i)).not.toBeInTheDocument()
    expect(screen.queryByText(/What a solid answer looks like/i)).not.toBeInTheDocument()
  })

  test('renders Solid overall in green-ish styling', () => {
    const verdict = { ...baseVerdict, overall: 'Solid' as const }
    renderVerdict(verdict)
    expect(screen.getByText('SOLID')).toBeInTheDocument()
  })

  test('renders Needs work overall', () => {
    const verdict = { ...baseVerdict, overall: 'Needs work' as const }
    renderVerdict(verdict)
    expect(screen.getByText('NEEDS WORK')).toBeInTheDocument()
  })
})

describe('VerdictFallback', () => {
  test('renders fallback banner', () => {
    render(
      <MemoryRouter>
        <VerdictFallback transcript={baseTranscript} />
      </MemoryRouter>,
    )
    expect(screen.getByText(/Verdict temporarily unavailable/i)).toBeInTheDocument()
  })

  test('renders full transcript', () => {
    render(
      <MemoryRouter>
        <VerdictFallback transcript={baseTranscript} />
      </MemoryRouter>,
    )
    expect(screen.getByText('Tell me about Terraform.')).toBeInTheDocument()
    expect(screen.getByText('I use it daily.')).toBeInTheDocument()
    expect(screen.getByText('What is seccomp?')).toBeInTheDocument()
  })

  test('Run another drill link present in fallback', () => {
    render(
      <MemoryRouter>
        <VerdictFallback transcript={baseTranscript} />
      </MemoryRouter>,
    )
    expect(screen.getByRole('link', { name: /Run another drill/i })).toHaveAttribute('href', '/drill')
  })
})
