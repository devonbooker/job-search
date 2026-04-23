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
  // Areas the drill didn't get to probe this session. Separate from `weak` so
  // Opus never has to invent weak entries when the transcript was genuinely clean.
  // Preserves "areas to study" output without claiming them as observed failings.
  not_probed?: string[]
  interviewer_verdict: string
  overall: 'Solid' | 'Borderline' | 'Needs work'
  overall_summary: string
}
