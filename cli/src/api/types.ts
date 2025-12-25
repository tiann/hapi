import { z } from 'zod'
import { UsageSchema } from '@/claude/types'
import type { PermissionMode } from '@/claude/loop'
import type {
    TerminalClosePayload,
    TerminalExitPayload,
    TerminalOpenPayload,
    TerminalOutputPayload,
    TerminalReadyPayload,
    TerminalResizePayload,
    TerminalWritePayload,
    TerminalErrorPayload
} from '@/terminal/types'

export type Usage = z.infer<typeof UsageSchema>

export type Metadata = {
    path: string
    host: string
    version?: string
    name?: string
    os?: string
    summary?: {
        text: string
        updatedAt: number
    }
    machineId?: string
    claudeSessionId?: string
    codexSessionId?: string
    tools?: string[]
    slashCommands?: string[]
    homeDir: string
    happyHomeDir: string
    happyLibDir: string
    happyToolsDir: string
    startedFromDaemon?: boolean
    hostPid?: number
    startedBy?: 'daemon' | 'terminal'
    lifecycleState?: 'running' | 'archiveRequested' | 'archived' | string
    lifecycleStateSince?: number
    archivedBy?: string
    archiveReason?: string
    flavor?: string
}

export const MetadataSchema = z.object({
    path: z.string(),
    host: z.string(),
    version: z.string().optional(),
    name: z.string().optional(),
    os: z.string().optional(),
    summary: z.object({
        text: z.string(),
        updatedAt: z.number()
    }).optional(),
    machineId: z.string().optional(),
    claudeSessionId: z.string().optional(),
    codexSessionId: z.string().optional(),
    tools: z.array(z.string()).optional(),
    slashCommands: z.array(z.string()).optional(),
    homeDir: z.string(),
    happyHomeDir: z.string(),
    happyLibDir: z.string(),
    happyToolsDir: z.string(),
    startedFromDaemon: z.boolean().optional(),
    hostPid: z.number().optional(),
    startedBy: z.enum(['daemon', 'terminal']).optional(),
    lifecycleState: z.string().optional(),
    lifecycleStateSince: z.number().optional(),
    archivedBy: z.string().optional(),
    archiveReason: z.string().optional(),
    flavor: z.string().optional()
}).passthrough()

export type AgentState = {
    controlledByUser?: boolean | null | undefined
    requests?: {
        [id: string]: {
            tool: string
            arguments?: unknown
            createdAt?: number | null | undefined
        }
    }
    completedRequests?: {
        [id: string]: {
            tool: string
            arguments?: unknown
            createdAt?: number | null | undefined
            completedAt?: number | null | undefined
            status: 'canceled' | 'denied' | 'approved'
            reason?: string
            mode?: string
            decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort'
            allowTools?: string[]
            answers?: Record<string, string[]>
        }
    }
}

export const AgentStateSchema = z.object({
    controlledByUser: z.boolean().nullish(),
    requests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.unknown(),
        createdAt: z.number().nullish()
    })).optional(),
    completedRequests: z.record(z.string(), z.object({
        tool: z.string(),
        arguments: z.unknown(),
        createdAt: z.number().nullish(),
        completedAt: z.number().nullish(),
        status: z.enum(['canceled', 'denied', 'approved']),
        reason: z.string().optional(),
        mode: z.string().optional(),
        decision: z.enum(['approved', 'approved_for_session', 'denied', 'abort']).optional(),
        allowTools: z.array(z.string()).optional(),
        answers: z.record(z.string(), z.array(z.string())).optional()
    })).optional()
}).passthrough()

export type Session = {
    id: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: Metadata | null
    metadataVersion: number
    agentState: AgentState | null
    agentStateVersion: number
    thinking?: boolean
    thinkingAt?: number
    permissionMode?: PermissionMode | null
    modelMode?: 'default' | 'sonnet' | 'opus' | null
}

export const MachineMetadataSchema = z.object({
    host: z.string(),
    platform: z.string(),
    happyCliVersion: z.string(),
    homeDir: z.string(),
    happyHomeDir: z.string(),
    happyLibDir: z.string()
}).passthrough()

export type MachineMetadata = z.infer<typeof MachineMetadataSchema>

export const DaemonStateSchema = z.object({
    status: z.union([z.enum(['running', 'shutting-down']), z.string()]),
    pid: z.number().optional(),
    httpPort: z.number().optional(),
    startedAt: z.number().optional(),
    shutdownRequestedAt: z.number().optional(),
    shutdownSource: z.union([z.enum(['mobile-app', 'cli', 'os-signal', 'unknown']), z.string()]).optional()
}).passthrough()

export type DaemonState = z.infer<typeof DaemonStateSchema>

export type Machine = {
    id: string
    seq: number
    createdAt: number
    updatedAt: number
    active: boolean
    activeAt: number
    metadata: MachineMetadata | null
    metadataVersion: number
    daemonState: DaemonState | null
    daemonStateVersion: number
}

export const UpdateNewMessageBodySchema = z.object({
    t: z.literal('new-message'),
    sid: z.string(),
    message: z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        localId: z.string().nullable().optional(),
        content: z.unknown()
    })
})

export type UpdateNewMessageBody = z.infer<typeof UpdateNewMessageBodySchema>

export const UpdateSessionBodySchema = z.object({
    t: z.literal('update-session'),
    sid: z.string(),
    metadata: z.object({
        version: z.number(),
        value: z.unknown()
    }).nullable(),
    agentState: z.object({
        version: z.number(),
        value: z.unknown().nullable()
    }).nullable()
})

export type UpdateSessionBody = z.infer<typeof UpdateSessionBodySchema>

export const UpdateMachineBodySchema = z.object({
    t: z.literal('update-machine'),
    machineId: z.string(),
    metadata: z.object({
        version: z.number(),
        value: z.unknown()
    }).nullable(),
    daemonState: z.object({
        version: z.number(),
        value: z.unknown().nullable()
    }).nullable()
})

export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>

export const UpdateSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: z.union([UpdateNewMessageBodySchema, UpdateSessionBodySchema, UpdateMachineBodySchema]),
    createdAt: z.number()
})

export type Update = z.infer<typeof UpdateSchema>

export const CreateSessionResponseSchema = z.object({
    session: z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        active: z.boolean(),
        activeAt: z.number(),
        metadata: z.unknown().nullable(),
        metadataVersion: z.number(),
        agentState: z.unknown().nullable(),
        agentStateVersion: z.number()
    })
})

export type CreateSessionResponse = z.infer<typeof CreateSessionResponseSchema>

export const CreateMachineResponseSchema = z.object({
    machine: z.object({
        id: z.string(),
        seq: z.number(),
        createdAt: z.number(),
        updatedAt: z.number(),
        active: z.boolean(),
        activeAt: z.number(),
        metadata: z.unknown().nullable(),
        metadataVersion: z.number(),
        daemonState: z.unknown().nullable(),
        daemonStateVersion: z.number()
    })
})

export type CreateMachineResponse = z.infer<typeof CreateMachineResponseSchema>

export const MessageMetaSchema = z.object({
    sentFrom: z.string().optional(),
    permissionMode: z.string().optional(),
    model: z.string().nullable().optional(),
    fallbackModel: z.string().nullable().optional(),
    customSystemPrompt: z.string().nullable().optional(),
    appendSystemPrompt: z.string().nullable().optional(),
    allowedTools: z.array(z.string()).nullable().optional(),
    disallowedTools: z.array(z.string()).nullable().optional()
}).passthrough()

export type MessageMeta = z.infer<typeof MessageMetaSchema>

export const UserMessageSchema = z.object({
    role: z.literal('user'),
    content: z.object({
        type: z.literal('text'),
        text: z.string()
    }),
    localKey: z.string().optional(),
    meta: MessageMetaSchema.optional()
}).passthrough()

export type UserMessage = z.infer<typeof UserMessageSchema>

export const AgentMessageSchema = z.object({
    role: z.literal('agent'),
    content: z.object({
        type: z.literal('output'),
        data: z.unknown()
    }),
    meta: MessageMetaSchema.optional()
}).passthrough()

export type AgentMessage = z.infer<typeof AgentMessageSchema>

export const MessageContentSchema = z.union([UserMessageSchema, AgentMessageSchema])

export type MessageContent = z.infer<typeof MessageContentSchema>

export interface ServerToClientEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    'terminal:open': (data: TerminalOpenPayload) => void
    'terminal:write': (data: TerminalWritePayload) => void
    'terminal:resize': (data: TerminalResizePayload) => void
    'terminal:close': (data: TerminalClosePayload) => void
    error: (data: { message: string }) => void
}

export interface ClientToServerEvents {
    message: (data: { sid: string; message: unknown; localId?: string }) => void
    'session-alive': (data: { sid: string; time: number; thinking: boolean; mode?: 'local' | 'remote' }) => void
    'session-end': (data: { sid: string; time: number }) => void
    'update-metadata': (data: { sid: string; expectedVersion: number; metadata: unknown }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        metadata: unknown | null
    } | {
        result: 'success'
        version: number
        metadata: unknown | null
    }) => void) => void
    'update-state': (data: { sid: string; expectedVersion: number; agentState: unknown | null }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        agentState: unknown | null
    } | {
        result: 'success'
        version: number
        agentState: unknown | null
    }) => void) => void
    'machine-alive': (data: { machineId: string; time: number }) => void
    'machine-update-metadata': (data: { machineId: string; expectedVersion: number; metadata: unknown }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        metadata: unknown | null
    } | {
        result: 'success'
        version: number
        metadata: unknown | null
    }) => void) => void
    'machine-update-state': (data: { machineId: string; expectedVersion: number; daemonState: unknown | null }, cb: (answer: {
        result: 'error'
    } | {
        result: 'version-mismatch'
        version: number
        daemonState: unknown | null
    } | {
        result: 'success'
        version: number
        daemonState: unknown | null
    }) => void) => void
    'rpc-register': (data: { method: string }) => void
    'rpc-unregister': (data: { method: string }) => void
    'terminal:ready': (data: TerminalReadyPayload) => void
    'terminal:output': (data: TerminalOutputPayload) => void
    'terminal:exit': (data: TerminalExitPayload) => void
    'terminal:error': (data: TerminalErrorPayload) => void
    ping: (callback: () => void) => void
    'usage-report': (data: unknown) => void
}
