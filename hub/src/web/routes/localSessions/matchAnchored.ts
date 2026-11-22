import { isDeepStrictEqual } from 'node:util'
import type { LocalTranscript, LocalTranscriptMessage } from '@hapi/protocol/localTranscript'
import type { StoredMessage } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'
import { normalizeComparableText } from './compare'

/**
 * Anchored target matching: the imported prefix P of the HAPI
 * session must still line up with the source transcript S; the delta is what
 * follows the anchor. Reproduces OpenCode's strict prefix check and Pi's
 * append-after-leaf behavior.
 *
 * R1 imported messages must appear in S in order with equal content
 * R2 a stored cursor must still be on the transcript's anchor order
 * R3 anchor = max(last imported position, cursor position)
 * R4 gaps before the anchor are only allowed with a cursor
 * R5 no imports and no cursor but stored messages -> already_in_hapi
 * R6 active session with a delta -> session_active (enforced by the importer)
 */

export type AnchoredMatchResult =
    | { status: 'ok'; delta: LocalTranscriptMessage[] }
    | { status: 'transcript_diverged'; message: string }
    | { status: 'already_in_hapi'; message: string }

type TurnSummary = {
    userText: string
    assistantText: string
    endIndex: number
}

function asObj(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function extractUserText(content: unknown): string | null {
    const rec = asObj(content)
    if (rec?.role !== 'user') return null
    const body = asObj(rec.content)
    if (body?.type !== 'text' || typeof body.text !== 'string') return null
    return normalizeComparableText(body.text)
}

function extractAssistantText(content: unknown): string | null {
    const rec = asObj(content)
    if (rec?.role !== 'agent') return null
    const body = asObj(rec.content)
    if (body?.type !== 'codex') return null
    const data = asObj(body.data)
    if (data?.type !== 'message' || typeof data.message !== 'string') return null
    return normalizeComparableText(data.message)
}

function groupIntoTurns(messages: ReadonlyArray<{ content: unknown }>): TurnSummary[] | null {
    const turns: TurnSummary[] = []
    let current: { userText: string; assistantParts: string[]; endIndex: number } | null = null
    for (let i = 0; i < messages.length; i += 1) {
        const msg = messages[i]!
        const userText = extractUserText(msg.content)
        if (userText !== null) {
            if (current) {
                turns.push({
                    userText: current.userText,
                    assistantText: normalizeComparableText(current.assistantParts.join('\n')),
                    endIndex: current.endIndex
                })
            }
            current = { userText, assistantParts: [], endIndex: i }
            continue
        }
        if (!current) {
            return null
        }
        current.endIndex = i
        const assistantText = extractAssistantText(msg.content)
        if (assistantText) {
            current.assistantParts.push(assistantText)
        }
    }
    if (current) {
        turns.push({
            userText: current.userText,
            assistantText: normalizeComparableText(current.assistantParts.join('\n')),
            endIndex: current.endIndex
        })
    }
    return turns
}

function reconcileLiveTurns(
    liveMessages: ReadonlyArray<{ content: unknown }>,
    sourceSlice: readonly LocalTranscriptMessage[],
    requireFullConsumption: boolean
): number | null {
    if (liveMessages.length === 0) {
        return requireFullConsumption ? (sourceSlice.length === 0 ? 0 : null) : 0
    }
    const liveTurns = groupIntoTurns(liveMessages)
    const sourceTurns = groupIntoTurns(sourceSlice)
    if (!liveTurns || !sourceTurns || liveTurns.length === 0) return null
    if (requireFullConsumption ? sourceTurns.length !== liveTurns.length : sourceTurns.length < liveTurns.length) {
        return null
    }
    for (let i = 0; i < liveTurns.length; i += 1) {
        const liveTurn = liveTurns[i]!
        const sourceTurn = sourceTurns[i]!
        if (liveTurn.userText !== sourceTurn.userText) return null
        if (liveTurn.assistantText && sourceTurn.assistantText && liveTurn.assistantText !== sourceTurn.assistantText) {
            return null
        }
    }
    return sourceTurns[liveTurns.length - 1]!.endIndex + 1
}

export function matchAnchored(options: {
    storedMessages: StoredMessage[]
    transcript: LocalTranscript
    importPrefix: string
    cursor: string | null
    /** Source-specific compare form (defaults to the full content). */
    canonicalContent?: (content: unknown) => unknown
    /** When true, reconcile live HAPI turns after the imported prefix against native transcript turns. */
    reconcileLiveContinuation?: boolean
}): AnchoredMatchResult {
    const { storedMessages, transcript, importPrefix, cursor } = options
    const canonical = options.canonicalContent ?? ((content: unknown) => content)
    const sameContent = (source: unknown, stored: unknown): boolean =>
        isDeepStrictEqual(canonical(source), canonical(stored))
    const sourceMessages = transcript.messages
    const sourceIndexById = new Map(sourceMessages.map((message, index) => [message.id, index]))
    const sourceContentById = new Map(sourceMessages.map((message) => [
        message.id,
        truncateOversizedMessageContent(message.content)
    ]))
    const imported = storedMessages.filter((message) => message.localId?.startsWith(importPrefix))
    const cursorValue = cursor
    if (cursorValue !== null && transcript.anchorOrder !== undefined) {
        const anchorOrder = transcript.anchorOrder
        if (!anchorOrder.includes(cursorValue)) {
            return {
                status: 'transcript_diverged',
                message: 'The local transcript no longer contains the previously imported cursor position'
            }
        }
        // R1: stored imports stay an in-order subsequence of the transcript
        // with unchanged content.
        let priorSourceIndex = -1
        for (const message of imported) {
            const sourceIndex = sourceIndexById.get(message.localId!)
            if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
                return {
                    status: 'transcript_diverged',
                    message: 'Local transcript no longer extends the previously imported history'
                }
            }
            priorSourceIndex = sourceIndex
        }
        const changed = imported.find((message) => !sameContent(sourceContentById.get(message.localId!), message.content))
        if (changed?.localId) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed imported entry ${changed.localId}`
            }
        }
        // R3: anchor is the later of the last import and the cursor.
        const positionByAnchor = new Map(anchorOrder.map((anchor, index) => [anchor, index]))
        const lastImported = imported.at(-1)
        const lastImportedAnchor = lastImported?.localId != null
            ? sourceMessages[sourceIndexById.get(lastImported.localId)!]?.anchor
            : undefined
        const lastImportedPosition = lastImportedAnchor !== undefined
            ? positionByAnchor.get(lastImportedAnchor)
            : undefined
        const cursorPosition = positionByAnchor.get(cursorValue)
        const anchorPosition = Math.max(lastImportedPosition ?? -1, cursorPosition ?? -1)
        const deltaAnchors = new Set(anchorOrder.slice(anchorPosition + 1))
        // Delta: every transcript entry after the anchor (already-imported
        // localIds are deduped again on insert).
        const delta = sourceMessages.filter((message) => message.anchor !== undefined && deltaAnchors.has(message.anchor))
        return { status: 'ok', delta }
    }

    if (options.reconcileLiveContinuation && imported.length > 0 && storedMessages.length > imported.length) {
        let priorSourceIndex = -1
        let priorStoredIndex = -1
        for (let i = 0; i < imported.length; i += 1) {
            const stored = imported[i]!
            const storedIndex = storedMessages.indexOf(stored, priorStoredIndex + 1)
            const sourceIndex = sourceIndexById.get(stored.localId!)
            if (sourceIndex === undefined || sourceIndex <= priorSourceIndex) {
                return {
                    status: 'transcript_diverged',
                    message: `Local transcript changed or dropped imported entry ${stored.localId}`
                }
            }
            if (!sameContent(sourceContentById.get(stored.localId!), stored.content)) {
                return {
                    status: 'transcript_diverged',
                    message: `Local transcript changed or dropped imported entry ${stored.localId}`
                }
            }
            const liveGap = storedMessages.slice(priorStoredIndex + 1, storedIndex)
            const sourceGap = sourceMessages.slice(priorSourceIndex + 1, sourceIndex)
            if (reconcileLiveTurns(liveGap, sourceGap, true) === null) {
                return {
                    status: 'transcript_diverged',
                    message: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages'
                }
            }
            priorStoredIndex = storedIndex
            priorSourceIndex = sourceIndex
        }
        const trailingLive = storedMessages.slice(priorStoredIndex + 1)
        const remainingSource = sourceMessages.slice(priorSourceIndex + 1)
        if (trailingLive.length > 0 && remainingSource.length > 0) {
            const consumed = reconcileLiveTurns(trailingLive, remainingSource, false)
            if (consumed === null) {
                return {
                    status: 'transcript_diverged',
                    message: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages'
                }
            }
            return { status: 'ok', delta: remainingSource.slice(consumed) }
        }
        return { status: 'ok', delta: remainingSource }
    }

    // No cursor: the imported prefix must align exactly with the head of the
    // transcript (OpenCode's strict prefix rule; Pi without a stored leaf).
    for (let index = 0; index < imported.length; index += 1) {
        const stored = imported[index]!
        const source = sourceMessages[index]
        if (!source || source.id !== stored.localId) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed or dropped imported entry ${stored.localId}`
            }
        }
        if (!sameContent(sourceContentById.get(source.id), stored.content)) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed or dropped imported entry ${stored.localId}`
            }
        }
    }
    const delta = sourceMessages.slice(imported.length)
    const storedExtras = storedMessages.length - imported.length
    if (storedExtras > 0 && delta.length > 0) {
        // R4/R5: without a cursor the HAPI side must not have messages outside
        // the imported prefix when the source still advances.
        if (imported.length === 0) {
            return {
                status: 'already_in_hapi',
                message: 'This HAPI session was not imported from the local history; importing would duplicate its messages'
            }
        }
        return {
            status: 'transcript_diverged',
            message: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages'
        }
    }
    return { status: 'ok', delta }
}