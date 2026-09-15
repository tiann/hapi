import { z } from 'zod'

const TokenCountSchema = z.number().int().nonnegative()

export const ContextUsageSnapshotSchema = z.object({
    contextTokens: TokenCountSchema.optional(),
    cacheReadTokens: TokenCountSchema.optional()
})

export type ContextUsageSnapshot = z.infer<typeof ContextUsageSnapshotSchema>

const ClaudeSkillSchema = z.object({
    name: z.string()
})

const ClaudeMcpToolSchema = z.object({
    name: z.string(),
    serverName: z.string().optional()
})

export const ClaudeContextDetailsSchema = z.object({
    skills: z.array(ClaudeSkillSchema).optional(),
    mcpTools: z.array(ClaudeMcpToolSchema).optional(),
    systemTools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional()
})

export type ClaudeContextDetails = z.infer<typeof ClaudeContextDetailsSchema>

const CodexSkillSchema = z.object({
    name: z.string()
})

const CodexMcpServerSchema = z.object({
    name: z.string(),
    toolNames: z.array(z.string()).optional(),
    status: z.string().optional()
})

export const CodexContextDetailsSchema = z.object({
    slashCommands: z.array(z.string()).optional(),
    skills: z.array(CodexSkillSchema).optional(),
    mcpServers: z.array(CodexMcpServerSchema).optional()
})

export type CodexContextDetails = z.infer<typeof CodexContextDetailsSchema>

export const ContextDetailsSchema = z.object({
    version: z.literal(1),
    updatedAt: z.number().int().nonnegative(),
    provider: z.enum(['claude', 'codex']),
    model: z.string().optional(),
    contextWindow: TokenCountSchema.optional(),
    usage: ContextUsageSnapshotSchema.optional(),
    claude: ClaudeContextDetailsSchema.optional(),
    codex: CodexContextDetailsSchema.optional()
})

export type ContextDetails = z.infer<typeof ContextDetailsSchema>
