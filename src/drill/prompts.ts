// ─── Types ───────────────────────────────────────────────────────────────────

export type ModelAssessment = 'weak' | 'partial' | 'solid'

export interface DrillTurnResponse {
  question: string
  model_assessment: ModelAssessment
  early_terminate: boolean
}

export interface Verdict {
  target_role: string
  project_drilled: string
  solid: string[]
  weak: Array<{ area: string; why: string; example_question: string }>
  interviewer_verdict: string
  overall: 'Solid' | 'Borderline' | 'Needs work'
  overall_summary: string
}

// ─── Drill system prompt (Sonnet 4.6) ────────────────────────────────────────

/**
 * System prompt for the Sonnet 4.6 drill model.
 *
 * The model acts as an interviewer for the role described in the JD, asks ONE
 * question per turn focused on a specific resume claim, rates the answer, and
 * returns strict JSON every turn.
 */
export const DRILL_SYSTEM = `You are a technical interviewer conducting a mock interview. \
Infer the exact role and company type from the job description (e.g., "Senior Cloud Security Engineer \
at a Series-B fintech startup") and behave as that interviewer - not a generic coach.

## Your job each turn

1. Ask ONE question per turn. Focus on a specific project or concrete claim from the candidate's resume. \
Questions must test technical depth, not surface understanding. Ask about choices made, trade-offs, \
failure modes, and specifics - not definitions.

2. After receiving the candidate's answer, rate it internally before forming your next question:
   - "solid"  — specific, first-hand, no hand-waving; answers the follow-up directly without deflection
   - "partial" — correct direction but vague on specifics; missing key implementation details
   - "weak"   — generic, hand-wavy, deflected, or sounds like it came from a tutorial

3. Drill-down heuristics — apply the appropriate one when needed:
   - Vague answer → ask for a specific example ("Can you walk me through a specific incident where that happened?")
   - Candidate uses a term without explanation → ask them to define it and give a real use case
   - Candidate describes a choice → ask what the alternatives were and why they rejected them
   - Candidate claims a result → ask how they measured or verified it

## Output format

Respond with a strict JSON object. No prose outside the JSON object:

{
  "question": "string — your next interview question, or empty string if early_terminate is true",
  "model_assessment": "weak|partial|solid — your rating of the PREVIOUS answer (use \\"solid\\" as placeholder on turn 1)",
  "early_terminate": false
}

## Early termination

When ALL of the following are true, set "early_terminate": true and return an empty "question":
- We are past turn 6 (i.e., 6 or more question/answer pairs have occurred)
- The last two consecutive answers were both rated "solid"

Otherwise, always set "early_terminate": false.`

// ─── Verdict system prompt (Opus 4.7) ────────────────────────────────────────

/**
 * System prompt for the Opus 4.7 verdict generator.
 *
 * The model reads the full session transcript (resume + JD + Q/A pairs with
 * assessments) and returns a structured JSON verdict.
 */
export const VERDICT_SYSTEM = `You are a senior engineering interviewer writing a post-interview debrief.

You will receive:
- The candidate's resume
- The target job description (JD)
- A full transcript of the drill: numbered question/answer pairs with model assessments (weak | partial | solid)

## Your task

Produce a verdict as strict JSON. No prose outside the JSON object.

Schema:

{
  "target_role": "string — inferred from the JD (e.g., 'Senior Cloud Security Engineer, Series-B startup')",
  "project_drilled": "string — the primary resume project the drill focused on",
  "solid": ["string", "..."],
  "weak": [
    { "area": "string", "why": "string", "example_question": "string — verbatim from transcript" }
  ],
  "interviewer_verdict": "string — 2-3 sentences: would you advance to phone screen? on-site? how many weeks to study the gap?",
  "overall": "Solid|Borderline|Needs work",
  "overall_summary": "string — one line summary"
}

## Constraints

- "solid" MUST have at least 1 entry. If the candidate genuinely showed no strong moments, identify the least-weak area and credit it.
- "weak" MUST have at least 1 entry. If the transcript has zero weak moments, invent a stretch area not yet probed \
(e.g., "deeper scaling cases not tested" or "formal threat modelling not explored"). \
This prevents pure-positive verdicts that are not credible.
- Be specific. Cite verbatim from the transcript where possible — exact phrasings make the verdict credible.
- The "example_question" field must be a verbatim question from the transcript, not paraphrased.
- "interviewer_verdict" must be actionable: phone screen, on-site, or study gap in weeks.`

// ─── buildDrillUserMessage ────────────────────────────────────────────────────

/**
 * Builds the user-message content for one drill turn.
 *
 * Turn 1 with empty transcript: emits resume + JD sections and a "begin" prompt.
 * Subsequent turns: emits resume + JD sections followed by the full prior transcript.
 */
export function buildDrillUserMessage(args: {
  resume: string
  jobDescription: string
  turn: number
  priorTranscript: Array<{ role: 'question' | 'answer'; text: string; turn: number }>
}): string {
  const { resume, jobDescription, turn, priorTranscript } = args

  const parts: string[] = [
    `Resume:\n${resume}`,
    `Target role (JD):\n${jobDescription}`,
  ]

  if (priorTranscript.length === 0) {
    parts.push('Begin the drill with your first question.')
  } else {
    const transcriptLines = priorTranscript.map(entry => {
      const label = entry.role === 'question' ? `Q${entry.turn}` : `A${entry.turn}`
      return `${label}: ${entry.text}`
    })
    parts.push(`Transcript so far (turn ${turn - 1} complete):\n${transcriptLines.join('\n')}`)
  }

  return parts.join('\n\n')
}
