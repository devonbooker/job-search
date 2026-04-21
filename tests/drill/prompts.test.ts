import { describe, test, expect } from 'bun:test'
import {
  DRILL_SYSTEM,
  VERDICT_SYSTEM,
  buildDrillUserMessage,
  type ModelAssessment,
  type DrillTurnResponse,
  type Verdict,
} from '../../src/drill/prompts'

// ─── Type smoke-test ──────────────────────────────────────────────────────────
// These are never called; they just need to compile cleanly.
const _assessmentValues: ModelAssessment[] = ['weak', 'partial', 'solid']
const _drillResponse: DrillTurnResponse = {
  question: 'What was your role in the incident response?',
  model_assessment: 'partial',
  early_terminate: false,
}
const _verdict: Verdict = {
  target_role: 'Senior Cloud Security Engineer',
  project_drilled: 'AWS WAF migration',
  solid: ['Described the architecture clearly'],
  weak: [
    {
      area: 'Threat modelling',
      why: 'Vague',
      example_question: 'What threat model did you use?',
      how_to_fix: 'Study STRIDE and run OWASP Threat Dragon on a real data flow diagram. Read MITRE ATT&CK T1190.',
      model_answer: 'We ran STRIDE against the auth boundary using OWASP Threat Dragon. That surfaced a spoofing risk on the token refresh endpoint.',
    },
  ],
  interviewer_verdict: 'Good phone screen candidate.',
  overall: 'Borderline',
  overall_summary: 'Strong ops knowledge, gaps in formal threat modelling.',
}
// Suppress unused-variable warnings
void _assessmentValues
void _drillResponse
void _verdict

// ─── DRILL_SYSTEM ─────────────────────────────────────────────────────────────

describe('DRILL_SYSTEM', () => {
  test('is a non-empty string', () => {
    expect(typeof DRILL_SYSTEM).toBe('string')
    expect(DRILL_SYSTEM.length).toBeGreaterThan(0)
  })

  test('contains the three rating labels', () => {
    expect(DRILL_SYSTEM).toContain('weak')
    expect(DRILL_SYSTEM).toContain('partial')
    expect(DRILL_SYSTEM).toContain('solid')
  })

  test('contains the required JSON output keys', () => {
    expect(DRILL_SYSTEM).toContain('"question"')
    expect(DRILL_SYSTEM).toContain('"model_assessment"')
    expect(DRILL_SYSTEM).toContain('"early_terminate"')
  })

  test('contains early-termination sentinel instruction', () => {
    // The prompt must instruct the model when to set early_terminate = true
    expect(DRILL_SYSTEM).toContain('early_terminate')
    expect(DRILL_SYSTEM).toContain('6 or more completed question/answer pairs')
  })

  test('instructs model to ask ONE question per turn', () => {
    const lower = DRILL_SYSTEM.toLowerCase()
    // "one question" or "1 question" must appear
    expect(lower.includes('one question') || lower.includes('1 question')).toBe(true)
  })

  test('instructs model to output strict JSON (no prose outside JSON)', () => {
    const lower = DRILL_SYSTEM.toLowerCase()
    expect(lower.includes('json') || lower.includes('no prose')).toBe(true)
  })

  test('exact-phrase regression: no prose instruction present', () => {
    expect(DRILL_SYSTEM).toContain('No prose outside the JSON object')
  })

  test('includes drill-down heuristics (vague → specific example, term → define)', () => {
    const lower = DRILL_SYSTEM.toLowerCase()
    // At least one drill-down pattern should be described
    expect(
      lower.includes('specific example') ||
      lower.includes('define') ||
      lower.includes('vague') ||
      lower.includes('alternatives')
    ).toBe(true)
  })
})

// ─── VERDICT_SYSTEM ───────────────────────────────────────────────────────────

describe('VERDICT_SYSTEM', () => {
  test('is a non-empty string', () => {
    expect(typeof VERDICT_SYSTEM).toBe('string')
    expect(VERDICT_SYSTEM.length).toBeGreaterThan(0)
  })

  test('contains required top-level schema field names', () => {
    expect(VERDICT_SYSTEM).toContain('target_role')
    expect(VERDICT_SYSTEM).toContain('project_drilled')
    expect(VERDICT_SYSTEM).toContain('solid')
    expect(VERDICT_SYSTEM).toContain('weak')
    expect(VERDICT_SYSTEM).toContain('interviewer_verdict')
    expect(VERDICT_SYSTEM).toContain('overall')
    expect(VERDICT_SYSTEM).toContain('overall_summary')
  })

  test('contains nested weak-entry field names', () => {
    expect(VERDICT_SYSTEM).toContain('area')
    expect(VERDICT_SYSTEM).toContain('why')
    expect(VERDICT_SYSTEM).toContain('example_question')
  })

  test('contains the overall rating values', () => {
    expect(VERDICT_SYSTEM).toContain('Solid')
    expect(VERDICT_SYSTEM).toContain('Borderline')
    expect(VERDICT_SYSTEM).toContain('Needs work')
  })

  test('enforces at least 1 solid entry', () => {
    const lower = VERDICT_SYSTEM.toLowerCase()
    expect(lower.includes('at least 1') || lower.includes('at least one')).toBe(true)
    expect(VERDICT_SYSTEM.toLowerCase()).toContain('solid')
  })

  test('enforces at least 1 weak entry', () => {
    const lower = VERDICT_SYSTEM.toLowerCase()
    expect(lower.includes('at least 1') || lower.includes('at least one')).toBe(true)
    expect(VERDICT_SYSTEM.toLowerCase()).toContain('weak')
  })

  test('instructs model to cite verbatim from transcript', () => {
    const lower = VERDICT_SYSTEM.toLowerCase()
    expect(lower.includes('verbatim') || lower.includes('cite')).toBe(true)
  })

  test('exact-phrase regression: no prose instruction present', () => {
    expect(VERDICT_SYSTEM).toContain('No prose outside the JSON object')
  })

  test('exact-phrase regression: solid at-least-1 constraint present', () => {
    expect(VERDICT_SYSTEM).toContain('"solid" MUST have at least 1 entry')
  })

  test('exact-phrase regression: weak at-least-1 constraint present', () => {
    expect(VERDICT_SYSTEM).toContain('"weak" MUST have at least 1 entry')
  })

  test('exact-phrase regression: solid is labeled as array of plain strings', () => {
    expect(VERDICT_SYSTEM).toContain('array of plain strings')
  })

  test('exact-phrase regression: solid must not use object keys like area or evidence', () => {
    expect(VERDICT_SYSTEM).toContain("Do not add keys like 'area' or 'evidence' to solid entries")
  })

  test('solid and weak labeled as STRING ARRAY and OBJECT ARRAY respectively', () => {
    expect(VERDICT_SYSTEM).toContain('STRING ARRAY')
    expect(VERDICT_SYSTEM).toContain('OBJECT ARRAY')
  })

  test('exact-phrase regression: how_to_fix is a required field in weak items', () => {
    expect(VERDICT_SYSTEM).toContain('how_to_fix')
  })

  test('exact-phrase regression: model_answer is a required field in weak items', () => {
    expect(VERDICT_SYSTEM).toContain('model_answer')
  })

  test('contains "For each weak item, you MUST include" instruction', () => {
    expect(VERDICT_SYSTEM).toContain('For each weak item, you MUST include')
  })
})

// ─── buildDrillUserMessage ────────────────────────────────────────────────────

describe('buildDrillUserMessage', () => {
  const RESUME = 'Senior SWE with 5 years of cloud security experience.'
  const JD = 'We are looking for a Cloud Security Engineer at a Series-B startup.'

  test('turn 1 with empty transcript includes both section markers', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
    })
    expect(msg).toContain('Resume:')
    expect(msg).toContain('Target role (JD):')
  })

  test('turn 1 with empty transcript includes the actual resume text', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
    })
    expect(msg).toContain(RESUME)
  })

  test('turn 1 with empty transcript includes the actual JD text', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
    })
    expect(msg).toContain(JD)
  })

  test('turn 1 with empty transcript ends with "Begin the drill" instruction', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
    })
    expect(msg).toContain('Begin the drill with your first question')
  })

  test('turn 5 with prior transcript includes all prior Q/A in order', () => {
    const transcript = [
      { role: 'question' as const, text: 'Q1: Describe your WAF setup.', turn: 1 },
      { role: 'answer' as const, text: 'A1: I used AWS WAF with managed rules.', turn: 1 },
      { role: 'question' as const, text: 'Q2: Which rule groups did you enable?', turn: 2 },
      { role: 'answer' as const, text: 'A2: AWSManagedRulesCommonRuleSet.', turn: 2 },
      { role: 'question' as const, text: 'Q3: Any custom rules?', turn: 3 },
      { role: 'answer' as const, text: 'A3: Yes, for rate-limiting.', turn: 3 },
      { role: 'question' as const, text: 'Q4: How did you test them?', turn: 4 },
      { role: 'answer' as const, text: 'A4: Used count mode first.', turn: 4 },
    ]

    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 5,
      priorTranscript: transcript,
    })

    // Resume and JD still present
    expect(msg).toContain(RESUME)
    expect(msg).toContain(JD)

    // All Q/A text present in order
    for (const entry of transcript) {
      expect(msg).toContain(entry.text)
    }

    // Q1 appears before A1
    expect(msg.indexOf('Q1: Describe your WAF setup.')).toBeLessThan(
      msg.indexOf('A1: I used AWS WAF with managed rules.')
    )
    // Q2 appears before A2
    expect(msg.indexOf('Q2: Which rule groups did you enable?')).toBeLessThan(
      msg.indexOf('A2: AWSManagedRulesCommonRuleSet.')
    )
  })

  test('turn 5 does NOT include "Begin the drill" instruction', () => {
    const transcript = [
      { role: 'question' as const, text: 'Q1', turn: 1 },
      { role: 'answer' as const, text: 'A1', turn: 1 },
    ]
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 5,
      priorTranscript: transcript,
    })
    expect(msg).not.toContain('Begin the drill with your first question')
  })

  test('turn 1 with project includes "Specific project" section header', () => {
    const project = 'github.com/devon/waf-project - custom WAF rules in Go'
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
      project,
    })
    expect(msg).toContain('Specific project to focus the drill on:')
    expect(msg).toContain(project)
  })

  test('turn 1 with project includes "Prioritize the pasted project" instruction', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
      project: 'My open source security scanner',
    })
    expect(msg).toContain('Prioritize the pasted project when choosing what to drill on')
  })

  test('turn 1 with empty project omits "Specific project" section', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
      project: '',
    })
    expect(msg).not.toContain('Specific project')
    expect(msg).toContain('Begin the drill with your first question.')
    expect(msg).not.toContain('Prioritize')
  })

  test('turn 1 without project arg still works (backward compat)', () => {
    const msg = buildDrillUserMessage({
      resume: RESUME,
      jobDescription: JD,
      turn: 1,
      priorTranscript: [],
    })
    expect(msg).toContain('Begin the drill with your first question.')
    expect(msg).not.toContain('Specific project')
  })
})
