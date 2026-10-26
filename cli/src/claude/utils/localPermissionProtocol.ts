import { z } from 'zod'

// Unlike PreToolUse, PermissionRequest races the main session's native dialog.
// No decision means "leave Claude's own permission flow alone", NOT "allow".
export const LOCAL_PERMISSION_TIMEOUT_SECONDS = 3600

export const PermissionRequestHookSchema = z.object({
    hook_event_name: z.literal('PermissionRequest'),
    session_id: z.string().min(1),
    prompt_id: z.string().optional(),
    agent_id: z.string().optional(),
    tool_name: z.string().min(1),
    tool_input: z.record(z.string(), z.unknown())
})

export type PermissionRequestHook = z.infer<typeof PermissionRequestHookSchema>

export const LocalPermissionDecisionSchema = z.object({
    behavior: z.enum(['allow', 'deny']),
    updatedInput: z.record(z.string(), z.unknown()).optional(),
    message: z.string().optional(),
    updatedPermissions: z.array(z.union([
        z.object({
            type: z.literal('setMode'),
            mode: z.enum(['default', 'acceptEdits', 'auto', 'bypassPermissions', 'plan']),
            destination: z.literal('session')
        }),
        z.object({
            type: z.literal('addRules'),
            rules: z.array(z.object({ toolName: z.string(), ruleContent: z.string().optional() })),
            behavior: z.literal('allow'),
            destination: z.literal('session')
        })
    ])).optional()
})

export type LocalPermissionDecision = z.infer<typeof LocalPermissionDecisionSchema>
