import type { PendingSchedule } from '@/components/AssistantChat/ScheduleTimePicker'

const STORAGE_KEY = 'hapi:queued-edit-recovery'

export type QueuedEditRecovery = {
    id: string
    text: string
    pendingSchedule: PendingSchedule | null
    composerTextAtEdit: string
    pendingScheduleAtEdit: PendingSchedule | null
}
export type QueuedEditRecoveryInput = Omit<QueuedEditRecovery, 'id'>

type RecoveryMap = Record<string, QueuedEditRecovery>
export type QueuedOperationToken = symbol

let cache: RecoveryMap | null = null
let recoverySequence = 0
const listeners = new Map<string, Set<() => void>>()
const pendingOperationTokens = new Map<string, QueuedOperationToken>()
const pendingOperationListeners = new Map<string, Set<() => void>>()

const PRESETS = new Set<Extract<PendingSchedule, { type: 'preset' }>['preset']>([
    '+5m',
    '+30m',
    '+1h',
    '+4h',
])

function clonePendingSchedule(schedule: PendingSchedule | null): PendingSchedule | null {
    if (schedule === null) return null
    return schedule.type === 'preset'
        ? { type: 'preset', preset: schedule.preset }
        : { type: 'absolute', ms: schedule.ms }
}

function isPendingSchedule(value: unknown): value is PendingSchedule {
    if (!value || typeof value !== 'object') return false
    const record = value as Record<string, unknown>
    return (record.type === 'preset' && typeof record.preset === 'string' && PRESETS.has(record.preset as never))
        || (record.type === 'absolute' && typeof record.ms === 'number' && Number.isFinite(record.ms))
}

function parsePendingSchedule(value: unknown): PendingSchedule | null | undefined {
    if (value === null) return null
    if (!isPendingSchedule(value)) return undefined
    return clonePendingSchedule(value)
}

function hydrate(): RecoveryMap {
    if (cache) return cache
    if (typeof window === 'undefined') {
        cache = {}
        return cache
    }
    try {
        const raw = sessionStorage.getItem(STORAGE_KEY)
        if (!raw) {
            cache = {}
            return cache
        }
        const parsed = JSON.parse(raw) as unknown
        if (!parsed || typeof parsed !== 'object') {
            cache = {}
            return cache
        }
        const result: RecoveryMap = {}
        let sanitized = false
        for (const [sessionId, value] of Object.entries(parsed as Record<string, unknown>)) {
            if (!sessionId.trim() || !value || typeof value !== 'object') {
                sanitized = true
                continue
            }
            const record = value as Record<string, unknown>
            const pendingSchedule = parsePendingSchedule(record.pendingSchedule)
            const pendingScheduleAtEdit = parsePendingSchedule(record.pendingScheduleAtEdit)
            if (
                typeof record.id !== 'string'
                ||
                typeof record.text !== 'string'
                || typeof record.composerTextAtEdit !== 'string'
                || pendingSchedule === undefined
                || pendingScheduleAtEdit === undefined
            ) {
                sanitized = true
                continue
            }
            result[sessionId] = {
                id: record.id,
                text: record.text,
                pendingSchedule,
                composerTextAtEdit: record.composerTextAtEdit,
                pendingScheduleAtEdit,
            }
        }
        cache = result
        if (sanitized) {
            try {
                sessionStorage.setItem(STORAGE_KEY, JSON.stringify(result))
            } catch {
                // Keep the in-memory sanitized cache even if persistence fails.
            }
        }
        return cache
    } catch {
        cache = {}
        return cache
    }
}

function persist(): void {
    if (typeof window === 'undefined') return
    try {
        sessionStorage.setItem(STORAGE_KEY, JSON.stringify(hydrate()))
    } catch {
        // Recovery is best effort when sessionStorage is unavailable or full.
    }
}

function notify(sessionId: string): void {
    for (const listener of listeners.get(sessionId) ?? []) {
        listener()
    }
}

function notifyPendingOperation(sessionId: string): void {
    for (const listener of pendingOperationListeners.get(sessionId) ?? []) {
        listener()
    }
}

export function getQueuedEditRecovery(sessionId: string): QueuedEditRecovery | null {
    const recovery = hydrate()[sessionId]
    if (!recovery) return null
    return {
        id: recovery.id,
        text: recovery.text,
        pendingSchedule: clonePendingSchedule(recovery.pendingSchedule),
        composerTextAtEdit: recovery.composerTextAtEdit,
        pendingScheduleAtEdit: clonePendingSchedule(recovery.pendingScheduleAtEdit),
    }
}

export function saveQueuedEditRecovery(sessionId: string, recovery: QueuedEditRecoveryInput): void {
    const recoveries = hydrate()
    delete recoveries[sessionId]
    recoveries[sessionId] = {
        id: `${Date.now()}:${++recoverySequence}`,
        text: recovery.text,
        pendingSchedule: clonePendingSchedule(recovery.pendingSchedule),
        composerTextAtEdit: recovery.composerTextAtEdit,
        pendingScheduleAtEdit: clonePendingSchedule(recovery.pendingScheduleAtEdit),
    }
    persist()
    notify(sessionId)
    notifyPendingOperation(sessionId)
}

export function clearQueuedEditRecovery(sessionId: string): void {
    const recoveries = hydrate()
    if (!recoveries[sessionId]) return
    delete recoveries[sessionId]
    persist()
    notifyPendingOperation(sessionId)
}

export function subscribeQueuedEditRecovery(sessionId: string, listener: () => void): () => void {
    const sessionListeners = listeners.get(sessionId) ?? new Set<() => void>()
    sessionListeners.add(listener)
    listeners.set(sessionId, sessionListeners)
    return () => {
        sessionListeners.delete(listener)
        if (sessionListeners.size === 0) listeners.delete(sessionId)
    }
}

/**
 * Starts the single queued-message operation allowed for a session.
 * The opaque token prevents an older completion from releasing a newer one.
 */
export function beginQueuedOperation(sessionId: string): QueuedOperationToken | null {
    if (pendingOperationTokens.has(sessionId) || Boolean(hydrate()[sessionId])) return null
    const token = Symbol(`queued-operation:${sessionId}`)
    pendingOperationTokens.set(sessionId, token)
    notifyPendingOperation(sessionId)
    return token
}

export function endQueuedOperation(sessionId: string, token: QueuedOperationToken): void {
    if (pendingOperationTokens.get(sessionId) !== token) return
    pendingOperationTokens.delete(sessionId)
    notifyPendingOperation(sessionId)
}

export function isQueuedOperationPending(sessionId: string): boolean {
    return pendingOperationTokens.has(sessionId) || Boolean(hydrate()[sessionId])
}

export function subscribeQueuedOperation(sessionId: string, listener: () => void): () => void {
    const sessionListeners = pendingOperationListeners.get(sessionId) ?? new Set<() => void>()
    sessionListeners.add(listener)
    pendingOperationListeners.set(sessionId, sessionListeners)
    return () => {
        sessionListeners.delete(listener)
        if (sessionListeners.size === 0) pendingOperationListeners.delete(sessionId)
    }
}
