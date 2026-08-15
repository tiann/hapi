import { useMemo } from 'react'
import type { DecryptedMessage } from '@/types/api'
import { isObject, asString } from '@hapi/protocol'
import type { DshStateSnapshot } from '@hapi/protocol'

/**
 * Folds `dsh_state` messages from the raw message stream into one
 * whole-session snapshot (higher seq wins, matching the official
 * higher-seq-wins projection rule). Also collects the native event journal
 * (dsh_native) for fork anchors and diagnostics.
 */
export function useDshSessionState(messages: DecryptedMessage[] | undefined): {
    snapshot: DshStateSnapshot
    /** Latest native seq observed in the stream (fork anchors). */
    latestNativeSeq: number
} {
    return useMemo(() => {
        let snapshot: DshStateSnapshot = { seq: 0 }
        let latestNativeSeq = 0
        for (const message of messages ?? []) {
            const record = isObject(message.content)
                ? (message.content as { content?: unknown }).content
                : message.content
            const data = isObject(record) ? (record as { data?: unknown }).data : record
            if (!isObject(data)) continue
            if (data.type === 'dsh_state' && isObject(data.state)) {
                const candidate = data.state as DshStateSnapshot
                if (typeof candidate.seq === 'number' && candidate.seq >= snapshot.seq) {
                    // Merge per key (higher-seq wins per field): later
                    // snapshots often carry only the changed sections (queue,
                    // jobs, permissions...), so a whole-snapshot replace would
                    // drop fields the last snapshot did not restate.
                    snapshot = { ...snapshot, ...candidate, seq: candidate.seq }
                }
            }
            if (data.type === 'dsh_native' && isObject(data.event)) {
                const seq = (data.event as { seq?: unknown }).seq
                if (typeof seq === 'number' && seq > latestNativeSeq) {
                    latestNativeSeq = seq
                }
            }
        }
        return { snapshot, latestNativeSeq }
    }, [messages])
}

/** Extract the first text block of a raw user/agent message. */
export function messageText(message: DecryptedMessage): string {
    const record = isObject(message.content) ? message.content : null
    const content = record && isObject(record.content) ? (record.content as { text?: unknown }).text : null
    if (typeof content === 'string') return content
    if (isObject(record)) {
        const data = (record as { data?: unknown }).data
        if (isObject(data) && typeof (data as { text?: string }).text === 'string') {
            return (data as { text: string }).text
        }
        if (isObject(data) && typeof (data as { message?: string }).message === 'string') {
            return (data as { message: string }).message
        }
    }
    return ''
}

/** Native seq carried by a projected DSH message (fork anchor). */
export function dshMessageSeq(message: DecryptedMessage): number | undefined {
    const record = isObject(message.content) ? message.content : null
    const data = record && isObject(record.content) ? (record.content as { data?: unknown }).data : null
    if (isObject(data)) {
        const seq = (data as { dshSeq?: unknown }).dshSeq
        if (typeof seq === 'number') return seq
    }
    return undefined
}

export function dshMessageId(message: DecryptedMessage): string | undefined {
    const record = isObject(message.content) ? message.content : null
    const data = record && isObject(record.content) ? (record.content as { data?: unknown }).data : null
    if (isObject(data)) {
        const id = (data as { dshMessageId?: unknown }).dshMessageId
        if (typeof id === 'string' && id.length > 0) return id
    }
    return undefined
}

export { asString }
