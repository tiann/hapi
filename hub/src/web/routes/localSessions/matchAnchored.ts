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

const AGY_BACKGROUND_PLACEHOLDER = 'Running in the background. The result appears when agy reports it.'

type UserPromptPart = {
    raw: string
    formatted: string
}

type AgentItemSummary =
    | { kind: 'message'; text: string; index: number }
    | { kind: 'reasoning'; text: string; index: number }
    | { kind: 'tool-call'; name: string; index: number }
    | { kind: 'tool-result'; isBackgroundPlaceholder: boolean; index: number }

type TurnSummary = {
    userParts: UserPromptPart[]
    assistantText: string
    agentItems: AgentItemSummary[]
    endIndex: number
}

function asObj(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function extractUserPromptPart(content: unknown): UserPromptPart | null {
    const rec = asObj(content)
    if (rec?.role !== 'user') return null
    const body = asObj(rec.content)
    if (body?.type !== 'text' || typeof body.text !== 'string') return null
    const raw = normalizeComparableText(body.text)
    const attachments = Array.isArray(body.attachments) ? body.attachments : []
    const refs: string[] = []
    for (const item of attachments) {
        const att = asObj(item)
        if (typeof att?.path === 'string' && att.path.trim()) {
            refs.push(`@${att.path}`)
        }
    }
    const formattedRaw = refs.length === 0
        ? body.text
        : body.text
            ? `${refs.join(' ')}\n\n${body.text}`
            : refs.join(' ')
    const formatted = normalizeComparableText(formattedRaw)
    return { raw, formatted }
}

function extractAgentItem(content: unknown, index: number): AgentItemSummary | null {
    const rec = asObj(content)
    if (rec?.role !== 'agent') return null
    const body = asObj(rec.content)
    if (body?.type !== 'codex') return null
    const data = asObj(body.data)
    if (!data || typeof data.type !== 'string') return null
    if (data.type === 'message' && typeof data.message === 'string') {
        return { kind: 'message', text: normalizeComparableText(data.message), index }
    }
    if (data.type === 'reasoning' && typeof data.message === 'string') {
        return { kind: 'reasoning', text: normalizeComparableText(data.message), index }
    }
    if (data.type === 'tool-call' && typeof data.name === 'string') {
        return { kind: 'tool-call', name: data.name, index }
    }
    if (data.type === 'tool-call-result') {
        const isBackgroundPlaceholder = data.output === AGY_BACKGROUND_PLACEHOLDER
        return { kind: 'tool-result', isBackgroundPlaceholder, index }
    }
    return null
}

function groupIntoTurns(messages: ReadonlyArray<{ content: unknown }>): TurnSummary[] | null {
    const turns: TurnSummary[] = []
    let current: {
        userParts: UserPromptPart[]
        assistantParts: string[]
        agentItems: AgentItemSummary[]
        hasAgentContent: boolean
        endIndex: number
    } | null = null
    for (let i = 0; i < messages.length; i += 1) {
        const msg = messages[i]!
        const userPart = extractUserPromptPart(msg.content)
        if (userPart !== null) {
            if (current && !current.hasAgentContent) {
                current.userParts.push(userPart)
                current.endIndex = i
                continue
            }
            if (current) {
                turns.push({
                    userParts: current.userParts,
                    assistantText: normalizeComparableText(current.assistantParts.join('\n')),
                    agentItems: current.agentItems,
                    endIndex: current.endIndex
                })
            }
            current = {
                userParts: [userPart],
                assistantParts: [],
                agentItems: [],
                hasAgentContent: false,
                endIndex: i
            }
            continue
        }
        if (!current) {
            return null
        }
        current.hasAgentContent = true
        current.endIndex = i
        const item = extractAgentItem(msg.content, i)
        if (item) {
            current.agentItems.push(item)
            if (item.kind === 'message' && item.text) {
                current.assistantParts.push(item.text)
            }
        }
    }
    if (current) {
        turns.push({
            userParts: current.userParts,
            assistantText: normalizeComparableText(current.assistantParts.join('\n')),
            agentItems: current.agentItems,
            endIndex: current.endIndex
        })
    }
    return turns
}

function buildUserPromptCandidates(parts: readonly UserPromptPart[]): Set<string> {
    const candidates = new Set<string>()
    if (parts.length === 0) return candidates
    const recurse = (index: number, acc: string[]) => {
        if (index === parts.length) {
            candidates.add(normalizeComparableText(acc.join('\n')))
            return
        }
        const part = parts[index]!
        recurse(index + 1, [...acc, part.raw])
        if (part.formatted !== part.raw) {
            recurse(index + 1, [...acc, part.formatted])
        }
    }
    recurse(0, [])
    return candidates
}

function userPromptsMatch(liveTurn: TurnSummary, sourceTurn: TurnSummary): boolean {
    const liveCandidates = buildUserPromptCandidates(liveTurn.userParts)
    const sourceCandidates = buildUserPromptCandidates(sourceTurn.userParts)
    for (const candidate of liveCandidates) {
        if (sourceCandidates.has(candidate)) return true
    }
    return false
}

function agentItemsCompatible(liveItem: AgentItemSummary, sourceItem: AgentItemSummary): boolean {
    if (liveItem.kind !== sourceItem.kind) return false
    if (liveItem.kind === 'message' && sourceItem.kind === 'message') {
        return liveItem.text === sourceItem.text
    }
    if (liveItem.kind === 'reasoning' && sourceItem.kind === 'reasoning') {
        return liveItem.text === sourceItem.text
    }
    if (liveItem.kind === 'tool-call' && sourceItem.kind === 'tool-call') {
        return liveItem.name === sourceItem.name
    }
    if (liveItem.kind === 'tool-result' && sourceItem.kind === 'tool-result') {
        return liveItem.isBackgroundPlaceholder === sourceItem.isBackgroundPlaceholder
    }
    return false
}

function alignTurnAgentItems(
    liveTurn: TurnSummary,
    sourceTurn: TurnSummary,
    requireFullConsumption: boolean
): number | null {
    let sourceCursor = 0
    let lastMatchedIndex = sourceTurn.endIndex - sourceTurn.agentItems.length
    for (const item of sourceTurn.agentItems) {
        lastMatchedIndex = Math.min(lastMatchedIndex, item.index - 1)
    }
    for (const liveItem of liveTurn.agentItems) {
        let matched = false
        while (sourceCursor < sourceTurn.agentItems.length) {
            const candidate = sourceTurn.agentItems[sourceCursor]!
            sourceCursor += 1
            if (agentItemsCompatible(liveItem, candidate)) {
                lastMatchedIndex = candidate.index
                matched = true
                break
            }
        }
        if (!matched) {
            return null
        }
    }
    if (requireFullConsumption && sourceCursor < sourceTurn.agentItems.length) {
        return null
    }
    if (sourceCursor === sourceTurn.agentItems.length) {
        return sourceTurn.endIndex + 1
    }
    return lastMatchedIndex + 1
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
    let consumed = 0
    for (let i = 0; i < liveTurns.length; i += 1) {
        const liveTurn = liveTurns[i]!
        const sourceTurn = sourceTurns[i]!
        if (!userPromptsMatch(liveTurn, sourceTurn)) return null
        if (liveTurn.assistantText && sourceTurn.assistantText && liveTurn.assistantText !== sourceTurn.assistantText) {
            return null
        }
        const isLastLiveTurn = i === liveTurns.length - 1
        const turnConsumed = alignTurnAgentItems(
            liveTurn,
            sourceTurn,
            requireFullConsumption || !isLastLiveTurn
        )
        if (turnConsumed === null) return null
        consumed = turnConsumed
    }
    return consumed
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