import { z } from 'zod'
import {
    MAX_AGENT_ATTACHMENT_FILES,
    type AgentAttachmentFileInput
} from './agentAttachment'

export const HAPI_MCP_TOOL_NAMES = ['change_title', 'send_attachment'] as const
export const HAPI_GOAL_MCP_TOOL_NAMES = ['get_goal', 'set_goal', 'clear_goal'] as const

export const changeTitleInputSchema = z.object({
    title: z.string().describe('The new title for the chat session')
})

export const sendAttachmentFileInputSchema = z.object({
    path: z.string().min(1).describe('Path to a generated file inside the current session working directory'),
    filename: z.string().min(1).max(255).optional().describe('Optional display filename'),
    mimeType: z.string().min(1).max(255).optional().describe('Optional MIME type override')
})

export const sendAttachmentInputSchema = z.object({
    files: z.array(sendAttachmentFileInputSchema)
        .min(1)
        .max(MAX_AGENT_ATTACHMENT_FILES)
        .describe('Generated files to send to the user as chat attachments')
})

export const goalStatusInputSchema = z.enum([
    'active',
    'paused',
    'blocked',
    'usageLimited',
    'budgetLimited',
    'complete'
])

export const getGoalInputSchema = z.object({})

export const setGoalInputSchema = z.object({
    objective: z.string().trim().min(1).max(2000).describe('The goal objective text'),
    status: goalStatusInputSchema.optional().describe('Optional goal status. Omit to set an active goal.'),
    tokenBudget: z.number().int().positive().optional().describe('Optional positive token budget for the goal')
})

export const clearGoalInputSchema = z.object({})

export type SendAttachmentInput = {
    files: AgentAttachmentFileInput[]
}

export type SetGoalInput = z.infer<typeof setGoalInputSchema>
