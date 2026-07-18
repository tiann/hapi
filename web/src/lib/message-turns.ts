import type { DecryptedMessage } from '@/types/api'
import {
    isNonblankAgentOutputUserTurnStart,
    isObject,
    unwrapRoleWrappedRecordEnvelope,
} from '@hapi/protocol'
import { isSkippableUserRecord } from '@/chat/normalizeUser'

export const VISIBLE_WINDOW_TURN_LIMIT = 40
export const PENDING_WINDOW_TURN_LIMIT = 8

export type SequenceRange = { startSeq: number; endSeq: number }
export type SequenceGap = { afterSeq: number; beforeSeq: number }

export type CompleteTurnTrimResult = {
    messages: DecryptedMessage[]
    dropped: DecryptedMessage[]
}

export function isMessageTurnStart(message: DecryptedMessage): boolean {
    const record = unwrapRoleWrappedRecordEnvelope(message.content)
    if (!record) {
        return false
    }
    if (record.role === 'user') {
        return !isSkippableUserRecord(record.content, message.localId, record.meta)
    }
    if (record.role !== 'agent' || !isObject(record.content) || record.content.type !== 'output') {
        return false
    }
    const data = isObject(record.content.data) ? record.content.data : null
    if (!data || data.type !== 'user') {
        return false
    }
    return isNonblankAgentOutputUserTurnStart(record.content)
}

function getTurnStartIndices(messages: DecryptedMessage[]): number[] {
    if (messages.length === 0) {
        return []
    }
    const starts = [0]
    for (let index = 1; index < messages.length; index += 1) {
        if (isMessageTurnStart(messages[index]!)) {
            starts.push(index)
        }
    }
    return starts
}

export function trimToCompleteTurns(
    messages: DecryptedMessage[],
    limit: number,
    direction: 'append' | 'prepend',
): CompleteTurnTrimResult {
    if (messages.length === 0) {
        return { messages, dropped: [] }
    }
    const safeLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1
    const starts = getTurnStartIndices(messages)
    if (starts.length <= safeLimit) {
        return { messages, dropped: [] }
    }

    if (direction === 'append') {
        const keepFrom = starts[starts.length - safeLimit]!
        return {
            messages: messages.slice(keepFrom),
            dropped: messages.slice(0, keepFrom),
        }
    }

    const keepUntil = starts[safeLimit] ?? messages.length
    return {
        messages: messages.slice(0, keepUntil),
        dropped: messages.slice(keepUntil),
    }
}

export function deriveSequenceCoverage(
    messages: DecryptedMessage[],
): { ranges: SequenceRange[]; gaps: SequenceGap[] } {
    const sequences = Array.from(new Set(
        messages
            .map((message) => message.seq)
            .filter((seq): seq is number => typeof seq === 'number' && Number.isFinite(seq)),
    )).sort((left, right) => left - right)
    if (sequences.length === 0) {
        return { ranges: [], gaps: [] }
    }

    const ranges: SequenceRange[] = []
    const gaps: SequenceGap[] = []
    let startSeq = sequences[0]!
    let endSeq = startSeq

    for (let index = 1; index < sequences.length; index += 1) {
        const seq = sequences[index]!
        if (seq === endSeq + 1) {
            endSeq = seq
            continue
        }
        ranges.push({ startSeq, endSeq })
        gaps.push({ afterSeq: endSeq, beforeSeq: seq })
        startSeq = seq
        endSeq = seq
    }
    ranges.push({ startSeq, endSeq })
    return { ranges, gaps }
}
