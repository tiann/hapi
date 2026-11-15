import type { LocalTranscript } from '@hapi/protocol/localTranscript'
import type { Store } from '../../../store'
import type { StoredMessage } from '../../../store'
import type { SyncEngine } from '../../../sync/syncEngine'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'
import { stableSerializeContent } from './compare'

/**
 * Content-prefix target matching: pick the reusable HAPI session whose
 * stored comparable keys form a prefix of the source transcript's keys.
 * Codex's current behavior, with one tolerance for duplicate runs.
 *
 * Alignment rules (stored keys against transcript keys, left to right):
 * - Equal keys are consumed together. There are no other gaps: a stored key
 *   separated from its transcript twin by any other content does not match,
 *   so a rewritten middle or prepended history never passes as a prefix.
 * - Duplicate runs: runners from before the source-side dedupe change
 *   collapsed adjacent identical messages, so the same run can have a
 *   different length on each side. Inside the prefix, an extra copy of the
 *   key just consumed is skipped on whichever side has it.
 * - The match ends when the stored keys run out; every transcript message
 *   after the last consumed key is the delta. A transcript copy past the
 *   stored end is growth, so an appended identical turn is kept.
 * - When the transcript runs out first, the stored session still matches
 *   (with nothing to append) only if its remaining keys repeat the key just
 *   consumed.
 */

export type ImportCandidate = {
    sessionId: string
    active: boolean
    updatedAt: number
    metadata: Record<string, unknown> | null
    persisted: boolean
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

/**
 * Canonical import-candidate collection shared by the generic importer and
 * the Codex duplicate-merge sidecar: store rows first, then engine cache
 * entries merged in by session id.
 */
export function collectImportCandidates(
    store: Store,
    namespace: string,
    getSyncEngine?: () => SyncEngine | null
): ImportCandidate[] {
    const candidatesBySessionId = new Map<string, ImportCandidate>()
    for (const session of store.sessions.getSessionsByNamespace(namespace)) {
        candidatesBySessionId.set(session.id, {
            sessionId: session.id,
            active: session.active,
            updatedAt: session.updatedAt,
            metadata: asRecord(session.metadata),
            persisted: true
        })
    }

    const engineSessions = getSyncEngine?.()?.getSessionsByNamespace(namespace) ?? []
    for (const session of engineSessions) {
        const existing = candidatesBySessionId.get(session.id)
        candidatesBySessionId.set(session.id, {
            sessionId: session.id,
            active: session.active || Boolean(existing?.active),
            updatedAt: Math.max(session.updatedAt, existing?.updatedAt ?? 0),
            metadata: asRecord(session.metadata) ?? existing?.metadata ?? null,
            persisted: Boolean(existing?.persisted)
        })
    }

    return Array.from(candidatesBySessionId.values())
}

export type ContentPrefixMatchResult =
    | { status: 'ok'; targetSessionId: string | null; deltaStartIndex: number }
    | { status: 'session_active'; message: string }

function defaultCompareKey(content: unknown): string | null {
    return stableSerializeContent(truncateOversizedMessageContent(content))
}

type KeyEntry = { key: string; messageIndex: number }

function comparableKeys(messages: Array<{ content: unknown }>, compareKey: (content: unknown) => string | null): KeyEntry[] {
    const entries: KeyEntry[] = []
    messages.forEach((message, index) => {
        const key = compareKey(message.content)
        if (key !== null) entries.push({ key, messageIndex: index })
    })
    return entries
}

/**
 * Aligns the stored keys against the start of the transcript keys under the
 * rules above. Returns the transcript entry index of the last consumed key
 * (-1 when nothing was stored), or null when the stored session is not a
 * prefix of the transcript.
 */
function alignStoredPrefix(stored: KeyEntry[], transcript: KeyEntry[]): number | null {
    let storedIndex = 0
    let transcriptIndex = 0
    let lastConsumed = -1
    let lastKey: string | null = null
    while (storedIndex < stored.length) {
        const storedKey = stored[storedIndex]!.key
        if (transcriptIndex < transcript.length) {
            const transcriptKey = transcript[transcriptIndex]!.key
            if (storedKey === transcriptKey) {
                lastConsumed = transcriptIndex
                lastKey = storedKey
                storedIndex += 1
                transcriptIndex += 1
                continue
            }
            if (transcriptKey === lastKey) {
                transcriptIndex += 1
                continue
            }
        }
        if (storedKey === lastKey) {
            storedIndex += 1
            continue
        }
        return null
    }
    return lastConsumed
}

export function matchContentPrefix(options: {
    candidates: ImportCandidate[]
    transcript: LocalTranscript
    nativeIdKeys: string[]
    sourceMachineId?: string | null
    compareKey?: (content: unknown) => string | null
    getAllMessages: (sessionId: string) => StoredMessage[]
}): ContentPrefixMatchResult {
    const { candidates, transcript, nativeIdKeys, sourceMachineId } = options
    const compareKey = options.compareKey ?? defaultCompareKey

    const related = candidates
        .filter((candidate) => candidate.persisted)
        .filter((candidate) => {
            const lifecycleState = candidate.metadata?.lifecycleState
            return lifecycleState !== 'archived' && lifecycleState !== 'deleted'
        })
        .filter((candidate) => nativeIdKeys.some((key) => candidate.metadata?.[key] === transcript.id))
        .filter((candidate) => (
            !sourceMachineId
            || typeof candidate.metadata?.machineId !== 'string'
            || candidate.metadata.machineId === sourceMachineId
        ))

    // Any related candidate being active blocks the sync, delta or not.
    if (related.some((candidate) => candidate.active)) {
        return {
            status: 'session_active',
            message: 'Cannot sync the local transcript while the matching HAPI session is active'
        }
    }

    const transcriptKeys = comparableKeys(transcript.messages, compareKey)

    let bestSessionId: string | null = null
    let bestDeltaStart = -1

    // Most recently updated first: on a tie the newest session wins.
    const ordered = [...related].sort((a, b) => b.updatedAt - a.updatedAt)
    for (const candidate of ordered) {
        const storedKeys = comparableKeys(options.getAllMessages(candidate.sessionId), compareKey)
        const lastConsumed = alignStoredPrefix(storedKeys, transcriptKeys)
        if (lastConsumed === null) continue
        const deltaStart = lastConsumed === -1 ? 0 : transcriptKeys[lastConsumed]!.messageIndex + 1
        // The candidate explaining the largest transcript prefix wins.
        if (deltaStart > bestDeltaStart) {
            bestDeltaStart = deltaStart
            bestSessionId = candidate.sessionId
        }
    }

    if (bestSessionId === null || bestDeltaStart < 0) {
        return { status: 'ok', targetSessionId: null, deltaStartIndex: 0 }
    }
    return { status: 'ok', targetSessionId: bestSessionId, deltaStartIndex: bestDeltaStart }
}