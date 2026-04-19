import { z } from 'zod'
import type { IntakeDispatchPayload, ApproveResumePayload, StartInterviewPayload } from '../agents/types'

export const intakeBody = z.object({
  goals: z.string().min(1),
  experience: z.string().min(1),
  preferences: z.string().min(1),
  resumeRaw: z.string().optional(),
})

export type IntakeBody = z.infer<typeof intakeBody>

// Compile-time check that schema matches dispatch minus sessionId
const _intakeCheck: Omit<IntakeDispatchPayload, 'sessionId'> = {} as IntakeBody
void _intakeCheck

export const approveBody = z.object({
  targetTitles: z.array(z.string()).min(1),
})
export type ApproveBody = z.infer<typeof approveBody>
const _approveCheck: Omit<ApproveResumePayload, 'sessionId'> = {} as ApproveBody
void _approveCheck

export const interviewBody = z.object({
  resumeSections: z.array(z.object({
    title: z.string(),
    content: z.union([z.string(), z.array(z.object({ text: z.string() }))]),
  })),
  selectedTopic: z.string().min(1),
  userAnswer: z.string().optional(),
  question: z.string().optional(),
})
export type InterviewBody = z.infer<typeof interviewBody>
const _interviewCheck: Omit<StartInterviewPayload, 'sessionId'> = {} as InterviewBody
void _interviewCheck
