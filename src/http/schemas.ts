import { z } from 'zod'
import type { IntakeDispatchPayload, SelectTitlesPayload, ApproveResumePayload, StartInterviewPayload } from '../agents/types'

export const intakeBody = z.object({
  goals: z.string().min(1),
  experience: z.string().min(1),
  preferences: z.string().min(1),
  resumeRaw: z.string().optional(),
})

export type IntakeBody = z.infer<typeof intakeBody>
const _intakeCheck: Omit<IntakeDispatchPayload, 'sessionId'> = {} as IntakeBody
void _intakeCheck

export const selectTitlesBody = z.object({
  targetTitles: z.array(z.string()).min(1),
})
export type SelectTitlesBody = z.infer<typeof selectTitlesBody>
const _selectTitlesCheck: Omit<SelectTitlesPayload, 'sessionId'> = {} as SelectTitlesBody
void _selectTitlesCheck

export const approveResumeBody = z.object({})
export type ApproveResumeBody = z.infer<typeof approveResumeBody>
const _approveResumeCheck: Omit<ApproveResumePayload, 'sessionId'> = {} as ApproveResumeBody
void _approveResumeCheck

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
