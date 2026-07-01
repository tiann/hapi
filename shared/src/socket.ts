import { z } from 'zod'
import type { CodexCollaborationMode, PermissionMode } from './modes'
import type { SessionEndReason } from './schemas'
export { SessionEndReasonSchema, type SessionEndReason } from './schemas'

export type SocketErrorReason = 'namespace-missing' | 'access-denied' | 'not-found'

export const TerminalOpenPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

export type TerminalOpenPayload = z.infer<typeof TerminalOpenPayloadSchema>

export const TerminalWritePayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    data: z.string()
})

export type TerminalWritePayload = z.infer<typeof TerminalWritePayloadSchema>

export const TerminalResizePayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

export type TerminalResizePayload = z.infer<typeof TerminalResizePayloadSchema>

// Read-only agent-terminal viewer controls (no terminalId — the agent PTY is the
// session's single TUI, keyed by sessionId). `resize` repaints the agent TUI at a
// given size; `refresh` forces a repaint of the current screen so a freshly
// (re)subscribed viewer sees the live state instead of a stale/black buffer.
export const AgentTerminalResizePayloadSchema = z.object({
    sessionId: z.string().min(1),
    cols: z.number().int().positive(),
    rows: z.number().int().positive()
})

export type AgentTerminalResizePayload = z.infer<typeof AgentTerminalResizePayloadSchema>

export const AgentTerminalRefreshPayloadSchema = z.object({
    sessionId: z.string().min(1)
})

export type AgentTerminalRefreshPayload = z.infer<typeof AgentTerminalRefreshPayloadSchema>

// Raw keystroke(s) typed into the agent TUI from a web viewer — the agent PTY is
// the session's single TUI, keyed by sessionId (no terminalId). Lets a remote
// viewer navigate TUI screens (e.g. answer/escape a /usage or /model dialog) that
// the structured chat composer cannot express.
export const AgentTerminalInputPayloadSchema = z.object({
    sessionId: z.string().min(1),
    data: z.string().min(1)
})

export type AgentTerminalInputPayload = z.infer<typeof AgentTerminalInputPayloadSchema>

export const TerminalClosePayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1)
})

export type TerminalClosePayload = z.infer<typeof TerminalClosePayloadSchema>

export const TerminalReadyPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1)
})

export type TerminalReadyPayload = z.infer<typeof TerminalReadyPayloadSchema>

export const TerminalOutputPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    data: z.string()
})

export type TerminalOutputPayload = z.infer<typeof TerminalOutputPayloadSchema>

export const TerminalExitPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    code: z.number().int().nullable(),
    signal: z.string().nullable()
})

export type TerminalExitPayload = z.infer<typeof TerminalExitPayloadSchema>

export const TerminalErrorPayloadSchema = z.object({
    sessionId: z.string().min(1),
    terminalId: z.string().min(1),
    message: z.string()
})

export type TerminalErrorPayload = z.infer<typeof TerminalErrorPayloadSchema>
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
    runnerState: z.object({
        version: z.number(),
        value: z.unknown().nullable()
    }).nullable()
})

export type UpdateMachineBody = z.infer<typeof UpdateMachineBodySchema>

export const UpdateCancelQueuedMessageBodySchema = z.object({
    t: z.literal('cancel-queued-message'),
    sid: z.string(),
    messageId: z.string(),
    localId: z.string().optional()
})

export type UpdateCancelQueuedMessageBody = z.infer<typeof UpdateCancelQueuedMessageBodySchema>

export const CancelQueuedMessageAckSchema = z.object({
    removed: z.boolean()
})

export type CancelQueuedMessageAck = z.infer<typeof CancelQueuedMessageAckSchema>

export const UpdateSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: z.union([UpdateNewMessageBodySchema, UpdateSessionBodySchema, UpdateMachineBodySchema, UpdateCancelQueuedMessageBodySchema]),
    createdAt: z.number()
})

export type Update = z.infer<typeof UpdateSchema>

export type UpdateMetadataAck = {
    result: 'error'
    reason?: SocketErrorReason
} | {
    result: 'version-mismatch'
    version: number
    metadata: unknown | null
} | {
    result: 'success'
    version: number
    metadata: unknown | null
}

export type UpdateStateAck = {
    result: 'error'
    reason?: SocketErrorReason
} | {
    result: 'version-mismatch'
    version: number
    agentState: unknown | null
} | {
    result: 'success'
    version: number
    agentState: unknown | null
}

export type MachineUpdateMetadataAck = {
    result: 'error'
    reason?: SocketErrorReason
} | {
    result: 'version-mismatch'
    version: number
    metadata: unknown | null
} | {
    result: 'success'
    version: number
    metadata: unknown | null
}

export type MachineUpdateStateAck = {
    result: 'error'
    reason?: SocketErrorReason
} | {
    result: 'version-mismatch'
    version: number
    runnerState: unknown | null
} | {
    result: 'success'
    version: number
    runnerState: unknown | null
}

export interface ServerToClientEvents {
    update: (data: Update, ack?: (response: CancelQueuedMessageAck) => void) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    'terminal:open': (data: TerminalOpenPayload) => void
    'terminal:write': (data: TerminalWritePayload) => void
    'terminal:resize': (data: TerminalResizePayload) => void
    'terminal:close': (data: TerminalClosePayload) => void
    'agent-terminal:resize': (data: AgentTerminalResizePayload) => void
    'agent-terminal:refresh': (data: AgentTerminalRefreshPayload) => void
    // Raw keystroke(s) from a web viewer, relayed to the CLI to write into the
    // agent PTY (interactive TUI navigation; see AgentTerminalInputPayload).
    'agent-terminal:input': (data: AgentTerminalInputPayload) => void
    // Sent to the CLI when the last agent-terminal viewer leaves, so it stops
    // streaming PTY output to the hub until someone subscribes again.
    'agent-terminal:idle': (data: AgentTerminalRefreshPayload) => void
    error: (data: { message: string; code?: SocketErrorReason; scope?: 'session' | 'machine'; id?: string }) => void
}

export interface ClientToServerEvents {
    message: (data: { sid: string; message: unknown; localId?: string }) => void
    'session-alive': (data: {
        sid: string
        time: number
        thinking: boolean
        mode?: 'local' | 'remote'
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        effort?: string | null
        serviceTier?: string | null
        collaborationMode?: CodexCollaborationMode
    }) => void
  /** CLI agent finished session/load (or equivalent) and can accept prompts. */
    'session-ready': (data: { sid: string; time: number }) => void
    'session-end': (data: { sid: string; time: number; reason?: SessionEndReason }) => void
    'messages-consumed': (data: { sid: string; localIds: string[] }) => void
    'update-metadata': (data: { sid: string; expectedVersion: number; metadata: unknown }, cb: (answer: UpdateMetadataAck) => void) => void
    'update-state': (data: { sid: string; expectedVersion: number; agentState: unknown | null }, cb: (answer: UpdateStateAck) => void) => void
    'machine-alive': (data: { machineId: string; time: number; health?: unknown }) => void
    'machine-update-metadata': (data: { machineId: string; expectedVersion: number; metadata: unknown }, cb: (answer: MachineUpdateMetadataAck) => void) => void
    'machine-update-state': (data: { machineId: string; expectedVersion: number; runnerState: unknown | null }, cb: (answer: MachineUpdateStateAck) => void) => void
    'rpc-register': (data: { method: string }) => void
    'rpc-unregister': (data: { method: string }) => void
    'terminal:ready': (data: TerminalReadyPayload) => void
    'terminal:output': (data: TerminalOutputPayload) => void
    'terminal:exit': (data: TerminalExitPayload) => void
    'terminal:error': (data: TerminalErrorPayload) => void
    'agent-terminal:output': (data: TerminalOutputPayload) => void
    // Drop the hub's scrollback buffer for this session (a new agent PTY just
    // spawned, e.g. after archive→restart, so old output must not replay).
    'agent-terminal:reset': (data: { sessionId: string }) => void
    ping: (callback: () => void) => void
    'usage-report': (data: unknown) => void
}
