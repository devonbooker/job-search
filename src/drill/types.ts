// ─── Shared drill types ───────────────────────────────────────────────────────
// Kept in a separate file so storage.ts can import Verdict without depending on
// prompts.ts (which imports from the Anthropic SDK and carries all the prompt
// strings). This prevents circular deps: storage → types, prompts → types,
// engine → storage + prompts + types.

export type ModelAssessment = 'weak' | 'partial' | 'solid'

export interface Verdict {
  target_role: string
  project_drilled: string
  solid: string[]
  weak: Array<{
    area: string
    why: string
    example_question: string
    how_to_fix?: string      // 3-5 sentences: concepts to study, specific resources, practice reps
    model_answer?: string    // 2-4 sentences showing what a 'solid' answer would have sounded like
  }>
  interviewer_verdict: string
  overall: 'Solid' | 'Borderline' | 'Needs work'
  overall_summary: string
}
