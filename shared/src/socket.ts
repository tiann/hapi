import { z } from 'zod'
import type { CodexCollaborationMode, CodexServiceTier, PermissionMode } from './modes'
import {
    DeliveryAttemptStateSchema,
    ManagedLifecycleStateSchema,
    ManagedStopReasonSchema,
    ManagedStoppedBySchema,
    type DeliveryAttemptState,
    type ManagedLifecycleState,
    type ManagedStopReason,
    type ManagedStoppedBy
} from './schemas'

export type SocketErrorReason = 'namespace-missing' | 'access-denied' | 'not-found' | 'invalid-request' | 'internal-error'

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

export const UpdateSchema = z.object({
    id: z.string(),
    seq: z.number(),
    body: z.union([UpdateNewMessageBodySchema, UpdateSessionBodySchema, UpdateMachineBodySchema]),
    createdAt: z.number()
})

export type Update = z.infer<typeof UpdateSchema>

export interface ServerToClientEvents {
    update: (data: Update) => void
    'rpc-request': (data: { method: string; params: string }, callback: (response: string) => void) => void
    'terminal:open': (data: TerminalOpenPayload) => void
    'terminal:write': (data: TerminalWritePayload) => void
    'terminal:resize': (data: TerminalResizePayload) => void
    'terminal:close': (data: TerminalClosePayload) => void
    error: (data: { message: string; code?: SocketErrorReason; scope?: 'session' | 'machine'; id?: string }) => void
}

export type SyncMessageAck = {
    inserted: true
} | {
    inserted: false
    reason: 'stale-generation' | 'metadata-conflict' | 'duplicate'
}

export type ManagedSessionOutcomeRequest = {
    idempotencyKey: string
    namespace: string
    machineId: string
    sessionId: string | null
    launchNonce: string
    runnerInstanceId: string
    expectedVersion: number | null
    lifecycleState: ManagedLifecycleState
    active: boolean
    stoppedBy?: ManagedStoppedBy
    stopReasonCode?: ManagedStopReason
    lifecycleStateSince: number
}

export const ManagedSessionOutcomeRequestSchema = z.object({
    idempotencyKey: z.string().min(1),
    namespace: z.string().min(1),
    machineId: z.string().min(1),
    sessionId: z.string().min(1).nullable(),
    launchNonce: z.string().min(1),
    runnerInstanceId: z.string().min(1),
    expectedVersion: z.number().int().nonnegative().nullable(),
    lifecycleState: ManagedLifecycleStateSchema,
    active: z.boolean(),
    stoppedBy: ManagedStoppedBySchema.optional(),
    stopReasonCode: ManagedStopReasonSchema.optional(),
    lifecycleStateSince: z.number().finite()
}).strict().superRefine((value, context) => {
    const expectedActive = value.lifecycleState === 'running'
    if (value.active !== expectedActive) {
        context.addIssue({ code: 'custom', path: ['active'], message: 'active must match lifecycleState' })
    }
})

export type ManagedSessionOutcomeAck = {
    result: 'success'
    canonicalSessionId: string
    version: number
} | {
    result: 'deferred'
    launchNonce: string
} | {
    result: 'error'
    reason: SocketErrorReason | 'launch-mismatch' | 'version-mismatch'
}

export const ManagedStopBarrierRequestSchema = z.object({
    namespace: z.string().min(1),
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    launchNonce: z.string().min(1),
    runnerInstanceId: z.string().min(1)
}).strict()
export type ManagedStopBarrierRequest = z.infer<typeof ManagedStopBarrierRequestSchema>
export type ManagedStopBarrierAck = { eligible: boolean; reason: string }

export type DeliveryAttemptRequest = {
    idempotencyKey: string
    namespace: string
    machineId: string
    sessionId: string
    messageId: string
    sequence: number
    attemptId: string
    launchNonce: string
    state: DeliveryAttemptState
    createdAt: number
}

export const DeliveryAttemptRequestSchema = z.object({
    idempotencyKey: z.string().min(1),
    namespace: z.string().min(1),
    machineId: z.string().min(1),
    sessionId: z.string().min(1),
    messageId: z.string().min(1),
    sequence: z.number().int().nonnegative(),
    attemptId: z.string().min(1),
    launchNonce: z.string().min(1),
    state: DeliveryAttemptStateSchema,
    createdAt: z.number().finite()
}).strict()

export const DeliveryBatchRequestSchema = z.object({
    attempts: z.array(DeliveryAttemptRequestSchema.omit({ state: true })).min(1).max(100)
}).strict()
export type DeliveryBatchRequest = z.infer<typeof DeliveryBatchRequestSchema>
export type DeliveryBatchAck = {
    result: 'success'
    canonicalSessionId: string
} | {
    result: 'error'
    reason: SocketErrorReason | 'launch-mismatch' | 'invalid-transition'
}

export type DeliveryAttemptAck = {
    result: 'success'
    canonicalSessionId: string
    state: DeliveryAttemptState
} | {
    result: 'error'
    reason: SocketErrorReason | 'launch-mismatch' | 'invalid-transition'
}

export interface ClientToServerEvents {
    message: (data: { sid: string; message: unknown; localId?: string }) => void
    'sync-message': (
        data: { sid: string; message: unknown; localId?: string; source?: 'cli' | 'codex-desktop-sync'; generation?: number },
        cb?: (answer: SyncMessageAck) => void
    ) => void
    'session-alive': (data: {
        sid: string
        time: number
        thinking?: boolean
        mode?: 'local' | 'remote'
        source?: 'cli' | 'codex-desktop-sync'
        generation?: number
        permissionMode?: PermissionMode
        model?: string | null
        modelReasoningEffort?: string | null
        serviceTier?: CodexServiceTier | null
        effort?: string | null
        collaborationMode?: CodexCollaborationMode
    }) => void
    'session-end': (data: { sid: string; time: number; source?: 'cli' | 'codex-desktop-sync'; generation?: number }) => void
    'mark-managed-session-outcome': (data: ManagedSessionOutcomeRequest, cb: (answer: ManagedSessionOutcomeAck) => void) => void
    'runner-managed-session-outcome': (data: ManagedSessionOutcomeRequest, cb: (answer: ManagedSessionOutcomeAck) => void) => void
    'runner-managed-stop-barrier': (data: ManagedStopBarrierRequest, cb: (answer: ManagedStopBarrierAck) => void) => void
    'record-delivery-attempt': (data: DeliveryAttemptRequest, cb: (answer: DeliveryAttemptAck) => void) => void
    'prepare-delivery-batch': (data: DeliveryBatchRequest, cb: (answer: DeliveryBatchAck) => void) => void
    'update-metadata': (data: { sid: string; expectedVersion: number; metadata: unknown }, cb: (answer: {
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
    }) => void) => void
    'update-state': (data: { sid: string; expectedVersion: number; agentState: unknown | null }, cb: (answer: {
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
    }) => void) => void
    'machine-alive': (data: { machineId: string; time: number }) => void
    'machine-update-metadata': (data: { machineId: string; expectedVersion: number; metadata: unknown }, cb: (answer: {
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
    }) => void) => void
    'machine-update-state': (data: { machineId: string; expectedVersion: number; runnerState: unknown | null }, cb: (answer: {
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
