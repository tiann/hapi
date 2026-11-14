import { isDeepStrictEqual } from 'node:util'
import type { LocalTranscript, LocalTranscriptMessage } from '@hapi/protocol/localTranscript'
import type { StoredMessage } from '../../../store'
import { truncateOversizedMessageContent } from '../../../store/contentCodec'

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

export function matchAnchored(options: {
    storedMessages: StoredMessage[]
    transcript: LocalTranscript
    importPrefix: string
    cursor: string | null
    /** Source-specific compare form (defaults to the full content). */
    canonicalContent?: (content: unknown) => unknown
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