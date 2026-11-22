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
    batchKey: number | null
}

type AgentItemSummary =
    | { kind: 'message'; text: string; index: number }
    | { kind: 'reasoning'; text: string; index: number }
    | { kind: 'tool-call'; name: string; callId: string; input: unknown; index: number }
    | { kind: 'tool-result'; callId: string; isBackgroundPlaceholder: boolean; stdout?: string; exitCode?: number; index: number }

type TurnSummary = {
    userParts: UserPromptPart[]
    assistantText: string
    agentItems: AgentItemSummary[]
    nonSemanticIndices: number[]
    startIndex: number
    endIndex: number
}

function asObj(value: unknown): Record<string, unknown> | null {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function isUndeliveredQueuedUserMessage(msg: {
    content: unknown
    localId?: string | null
    invokedAt?: number | null
    scheduledAt?: number | null
    deliveryState?: string
}): boolean {
    if (msg.deliveryState === 'indeterminate') return true
    if (msg.scheduledAt != null && msg.invokedAt == null) return true
    return false
}

function filterDeliveredLiveMessages(
    messages: ReadonlyArray<{
        content: unknown
        localId?: string | null
        invokedAt?: number | null
        scheduledAt?: number | null
        deliveryState?: string
        createdAt?: number
        seq?: number
    }>
): Array<{
    content: unknown
    localId?: string | null
    invokedAt?: number | null
    scheduledAt?: number | null
    deliveryState?: string
    createdAt?: number
    seq?: number
}> {
    const filtered = messages.filter((msg) => {
        const rec = asObj(msg.content)
        if (rec?.role !== 'user') return true
        if (isUndeliveredQueuedUserMessage(msg)) return false
        if (msg.localId && msg.invokedAt == null) return false
        return true
    })
    const ordered = filtered.sort((a, b) => {
        const posA = a.invokedAt ?? a.createdAt ?? 0
        const posB = b.invokedAt ?? b.createdAt ?? 0
        if (posA !== posB) return posA - posB
        return (a.seq ?? 0) - (b.seq ?? 0)
    })
    const delivered: typeof ordered = []
    for (const row of ordered) {
        const record = asObj(row.content)
        const event = record?.role === 'agent' ? asObj(record.content) : null
        const data = event?.type === 'event' ? asObj(event.data) : null
        if (data?.type === 'abort-restore' && typeof data.text === 'string') {
            // Status events can intervene between the queued prompt and its restore.
            const batch: UserPromptPart[] = []
            const indices = new Set<number>()
            const restored = normalizeComparableText(data.text)
            for (let i = delivered.length - 1; i >= 0; i--) {
                const candidate = delivered[i]!
                const part = extractUserPromptPart(candidate)
                if (!part) {
                    if (extractAgentItem(candidate.content, i)) break
                    continue
                }
                if (batch.length && batch[0]!.batchKey !== part.batchKey) break
                batch.unshift(part)
                indices.add(i)
                if (matchUserPartsToPrompt(batch, restored)) {
                    for (const index of indices) delivered.splice(index, 1)
                    break
                }
                if (Math.min(part.raw.length, part.formatted.length) > restored.length) break
            }
            continue
        }
        delivered.push(row)
    }
    return delivered
}

function extractUserPromptPart(
    msg: { content: unknown; invokedAt?: number | null }
): UserPromptPart | null {
    const rec = asObj(msg.content)
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
    return {
        raw,
        formatted,
        batchKey: typeof msg.invokedAt === 'number' ? msg.invokedAt : null
    }
}

function isAgyBackgroundPlaceholderOutput(output: unknown): boolean {
    if (output === AGY_BACKGROUND_PLACEHOLDER) return true
    const obj = asObj(output)
    if (!obj) return false
    return obj.stdout === AGY_BACKGROUND_PLACEHOLDER || obj.output === AGY_BACKGROUND_PLACEHOLDER
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
        const callId = typeof data.callId === 'string' ? data.callId : ''
        return { kind: 'tool-call', name: data.name, callId, input: data.input, index }
    }
    if (data.type === 'tool-call-result') {
        const callId = typeof data.callId === 'string' ? data.callId : ''
        const isBackgroundPlaceholder = isAgyBackgroundPlaceholderOutput(data.output)
        const output = asObj(data.output)
        const text = typeof data.output === 'string' ? data.output : output?.stdout ?? output?.output
        return { kind: 'tool-result', callId, isBackgroundPlaceholder, index,
            stdout: typeof text === 'string' ? text.replace(/\r\n/g, '\n') : undefined,
            exitCode: typeof output?.exit_code === 'number' ? output.exit_code : undefined }
    }
    return null
}

function groupIntoTurns(
    messages: ReadonlyArray<{ content: unknown; invokedAt?: number | null }>,
    batchAdjacentUsers = true
): TurnSummary[] | null {
    const turns: TurnSummary[] = []
    let current: {
        userParts: UserPromptPart[]
        assistantParts: string[]
        agentItems: AgentItemSummary[]
        nonSemanticIndices: number[]
        hasAgentContent: boolean
        startIndex: number
        endIndex: number
    } | null = null
    for (let i = 0; i < messages.length; i += 1) {
        const msg = messages[i]!
        const userPart = extractUserPromptPart(msg)
        if (userPart !== null) {
            const lastUserPart = current?.userParts[current.userParts.length - 1]
            const canBatchWithCurrent = batchAdjacentUsers && current !== null
                && !current.hasAgentContent
                && (
                    lastUserPart?.batchKey === null
                    || userPart.batchKey === null
                    || lastUserPart?.batchKey === userPart.batchKey
                )
            if (current && canBatchWithCurrent) {
                current.userParts.push(userPart)
                current.nonSemanticIndices.push(i)
                current.endIndex = i
                continue
            }
            if (current) {
                turns.push({
                    userParts: current.userParts,
                    assistantText: normalizeComparableText(current.assistantParts.join('\n')),
                    agentItems: current.agentItems,
                    nonSemanticIndices: current.nonSemanticIndices,
                    startIndex: current.startIndex,
                    endIndex: current.endIndex
                })
            }
            current = {
                userParts: [userPart],
                assistantParts: [],
                agentItems: [],
                nonSemanticIndices: [i],
                hasAgentContent: false,
                startIndex: i,
                endIndex: i
            }
            continue
        }
        if (!current) {
            // Native history can begin during a tool call.
            current = { userParts: [], assistantParts: [], agentItems: [], nonSemanticIndices: [],
                hasAgentContent: true, startIndex: i, endIndex: i }
        }
        current.hasAgentContent = true
        current.endIndex = i
        const item = extractAgentItem(batchAdjacentUsers ? msg.content : truncateOversizedMessageContent(msg.content), i)
        if (item) {
            current.agentItems.push(item)
            if (item.kind === 'message' && item.text) {
                current.assistantParts.push(item.text)
            }
        } else {
            current.nonSemanticIndices.push(i)
        }
    }
    if (current) {
        turns.push({
            userParts: current.userParts,
            assistantText: normalizeComparableText(current.assistantParts.join('\n')),
            agentItems: current.agentItems,
            nonSemanticIndices: current.nonSemanticIndices,
            startIndex: current.startIndex,
            endIndex: current.endIndex
        })
    }
    return turns
}

function matchUserPartsToPrompt(parts: readonly UserPromptPart[], targetText: string): boolean {
    if (parts.length === 0) return false
    let offsets = new Set<number>([0])
    for (let i = 0; i < parts.length; i += 1) {
        const part = parts[i]!
        const isLast = i === parts.length - 1
        const nextOffsets = new Set<number>()
        const variants = part.formatted === part.raw ? [part.raw] : [part.raw, part.formatted]
        for (const offset of offsets) {
            for (const variant of variants) {
                if (!targetText.startsWith(variant, offset)) continue
                const afterPart = offset + variant.length
                if (isLast) {
                    if (afterPart === targetText.length) {
                        nextOffsets.add(afterPart)
                    }
                } else if (targetText[afterPart] === '\n') {
                    nextOffsets.add(afterPart + 1)
                }
            }
        }
        if (nextOffsets.size === 0) return false
        offsets = nextOffsets
    }
    return offsets.has(targetText.length)
}

function userPromptsMatch(liveTurn: TurnSummary, sourceTurn: TurnSummary): boolean {
    if (sourceTurn.userParts.length !== 1) return false
    const sourcePrompt = sourceTurn.userParts[0]!.raw
    return matchUserPartsToPrompt(liveTurn.userParts, sourcePrompt)
}

function rewriteToolResultCallIdContent(
    content: unknown,
    callIdMap: ReadonlyMap<string, string>
): unknown {
    if (callIdMap.size === 0) return content
    const rec = asObj(content)
    if (rec?.role !== 'agent') return content
    const body = asObj(rec.content)
    if (body?.type !== 'codex') return content
    const data = asObj(body.data)
    if (!data || data.type !== 'tool-call-result' || typeof data.callId !== 'string') return content
    const mappedCallId = callIdMap.get(data.callId)
    if (!mappedCallId || mappedCallId === data.callId) return content
    return {
        ...rec,
        content: {
            ...body,
            data: {
                ...data,
                callId: mappedCallId
            }
        }
    }
}

function rewriteToolResultCallId(
    message: LocalTranscriptMessage,
    callIdMap: ReadonlyMap<string, string>
): LocalTranscriptMessage {
    const rewritten = rewriteToolResultCallIdContent(message.content, callIdMap)
    if (rewritten === message.content) return message
    return {
        ...message,
        content: rewritten as LocalTranscriptMessage['content']
    }
}

function agentItemsCompatible(
    liveItem: AgentItemSummary,
    sourceItem: AgentItemSummary,
    callIdMap: ReadonlyMap<string, string>,
    compareResults: boolean
): boolean {
    if (liveItem.kind !== sourceItem.kind) return false
    if (liveItem.kind === 'message' && sourceItem.kind === 'message') {
        return liveItem.text === sourceItem.text
    }
    if (liveItem.kind === 'reasoning' && sourceItem.kind === 'reasoning') {
        return liveItem.text === sourceItem.text
    }
    if (liveItem.kind === 'tool-call' && sourceItem.kind === 'tool-call') {
        return liveItem.name === sourceItem.name && (liveItem.input === undefined || sourceItem.input === undefined
            || isDeepStrictEqual(liveItem.input, sourceItem.input))
    }
    if (liveItem.kind === 'tool-result' && sourceItem.kind === 'tool-result') {
        if (liveItem.isBackgroundPlaceholder !== sourceItem.isBackgroundPlaceholder) return false
        if (compareResults && !liveItem.isBackgroundPlaceholder) {
            if (liveItem.exitCode !== undefined && sourceItem.exitCode !== undefined && liveItem.exitCode !== sourceItem.exitCode) return false
            if (liveItem.stdout !== undefined && sourceItem.stdout !== undefined && liveItem.stdout !== sourceItem.stdout) return false
        }
        if (sourceItem.callId && liveItem.callId) {
            const expectedLiveCallId = callIdMap.get(sourceItem.callId)
            if ((expectedLiveCallId ?? sourceItem.callId) !== liveItem.callId) {
                return false
            }
        }
        return true
    }
    return false
}

function alignTurnAgentItems(
    liveTurn: TurnSummary,
    sourceTurn: TurnSummary,
    matchedSourceIndices: Set<number>,
    callIdMap: Map<string, string>,
    compareResults = false
): boolean {
    for (const idx of sourceTurn.nonSemanticIndices) {
        matchedSourceIndices.add(idx)
    }
    let sourceCursor = 0
    for (const liveItem of liveTurn.agentItems) {
        if (liveItem.kind === 'tool-result' && liveItem.isBackgroundPlaceholder) {
            const placeholder = sourceTurn.agentItems.find(item => item.kind === 'tool-result'
                && item.isBackgroundPlaceholder && !matchedSourceIndices.has(item.index)
                && (callIdMap.get(item.callId) ?? item.callId) === liveItem.callId)
            if (!placeholder) return false
            matchedSourceIndices.add(placeholder.index)
            continue
        }
        let matched = false
        while (sourceCursor < sourceTurn.agentItems.length) {
            const candidate = sourceTurn.agentItems[sourceCursor]!
            sourceCursor += 1
            if (matchedSourceIndices.has(candidate.index)) continue
            if (agentItemsCompatible(liveItem, candidate, callIdMap, compareResults)) {
                matchedSourceIndices.add(candidate.index)
                if (liveItem.kind === 'tool-call' && candidate.kind === 'tool-call' && candidate.callId && liveItem.callId) {
                    callIdMap.set(candidate.callId, liveItem.callId)
                }
                matched = true
                break
            }
        }
        if (!matched) {
            return false
        }
    }
    return true
}

function splitTurnUserPrefix(
    liveTurn: TurnSummary,
    partCount: number
): [TurnSummary, TurnSummary] {
    return [
        {
            userParts: liveTurn.userParts.slice(0, partCount),
            assistantText: '',
            agentItems: [],
            nonSemanticIndices: [],
            startIndex: liveTurn.startIndex,
            endIndex: liveTurn.startIndex
        },
        {
            ...liveTurn,
            userParts: liveTurn.userParts.slice(partCount)
        }
    ]
}

function reconcileLiveTurns(
    liveMessages: ReadonlyArray<{
        content: unknown
        localId?: string | null
        invokedAt?: number | null
        scheduledAt?: number | null
        deliveryState?: string
        createdAt?: number
        seq?: number
    }>,
    sourceSlice: readonly LocalTranscriptMessage[],
    importedIds: ReadonlySet<string>,
    callIdMap: Map<string, string>
): LocalTranscriptMessage[] | null {
    const deliveredLive = filterDeliveredLiveMessages(liveMessages)
    const firstPrompt = deliveredLive.findIndex(row => extractUserPromptPart(row) !== null)
    const leadingCount = firstPrompt < 0 ? deliveredLive.length : firstPrompt
    const rawLiveTurns = groupIntoTurns(deliveredLive.slice(leadingCount))
    const nativeTurns = groupIntoTurns(sourceSlice, false)
    if (!rawLiveTurns || !nativeTurns) return null
    const liveTurns = rawLiveTurns.filter(turn => !(
        turn.userParts.length === 1 && /^\/swarm\s+board(?:\s+(?:--channel(?:=|\s+)|#)[a-zA-Z0-9_-]+)?$/i.test(turn.userParts[0]!.formatted)
        && turn.agentItems.length === 1 && (turn.assistantText.startsWith('### Swarm Board')
            || turn.assistantText.startsWith('No active swarm board for this session yet.'))
    ))
    // Imported user rows still delimit native turns. Their late assistant rows
    // belong in the delta even when the user has already continued in HAPI.
    const sourceTurns = nativeTurns.filter(turn => turn.userParts.length > 0 && !importedIds.has(sourceSlice[turn.startIndex]!.id))
    const matchedSourceIndices = new Set<number>()
    for (let i = 0; i < sourceSlice.length; i++) {
        if (importedIds.has(sourceSlice[i]!.id)) matchedSourceIndices.add(i)
    }
    // Autonomous output may arrive between reopening the archive and the first user turn.
    const leading = deliveredLive.slice(0, leadingCount).flatMap((row, i) => extractAgentItem(row.content, i) ?? [])
    if (leading.length) {
        const firstNativePrompt = sourceTurns[0]?.startIndex ?? sourceSlice.length
        const anchorTurn = nativeTurns.filter(turn => turn.startIndex < firstNativePrompt).at(-1)
        if (!anchorTurn || !alignTurnAgentItems({ ...anchorTurn, agentItems: leading },
            { ...anchorTurn, nonSemanticIndices: [] }, matchedSourceIndices, callIdMap)) return null
    }
    const indicesByPrompt = new Map<string, number[]>()
    for (const [index, turn] of sourceTurns.entries()) {
        const prompt = turn.userParts[0]!.raw
        const bucket = indicesByPrompt.get(prompt)
        if (bucket) bucket.push(index)
        else indicesByPrompt.set(prompt, [index])
    }
    let sIdx = 0
    for (let lIdx = 0; lIdx < liveTurns.length; lIdx += 1) {
        if (sIdx >= sourceTurns.length) return null
        let liveTurn = liveTurns[lIdx]!
        const sourceTurn = sourceTurns[sIdx]!
        if (!userPromptsMatch(liveTurn, sourceTurn)) {
            // If two adjacent user rows had no invokedAt or shared a timestamp
            // before the first turn produced agent output, try splitting the
            // prefix that matches `sourceTurn` when `sourceTurn` had no agent
            // messages of its own or when the remaining parts belong to the next turn.
            let splitPrefix = 0
            for (let k = 1; k < liveTurn.userParts.length; k += 1) {
                if (matchUserPartsToPrompt(liveTurn.userParts.slice(0, k), sourceTurn.userParts[0]?.raw ?? '')) {
                    splitPrefix = k
                    break
                }
            }
            if (splitPrefix) {
                const [firstTurn, restTurn] = splitTurnUserPrefix(liveTurn, splitPrefix)
                liveTurn = firstTurn
                liveTurns.splice(lIdx, 1, firstTurn, restTurn)
            }
        }
        // Normalize legacy adjacent batches before searching the entire sequence.
        sIdx += 1
    }

    // The final possible prompt for each live turn bounds every complete alignment.
    const latestSource: number[] = []
    let latest = sourceTurns.length - 1
    for (let i = liveTurns.length - 1; i >= 0; i--) {
        while (latest >= 0 && !userPromptsMatch(liveTurns[i]!, sourceTurns[latest]!)) latest--
        if (latest < 0) return null
        latestSource[i] = latest--
    }
    const allIndices = sourceTurns.map((_, i) => i)
    type Choice = { source: number; indices: Set<number>; ids: Map<string, string> }
    const choices: Choice[] = []
    let compareResults = false
    let solution: Choice[] | undefined
    // Inconsistent repeated exchanges can have exponentially many partial alignments.
    // Fail closed once the search exceeds a linear allowance for this transcript.
    let remainingComparisons = 4096 + 32 * (sourceSlice.length + liveMessages.length)
    function* matches(liveIndex: number, after: number): Generator<Choice> {
        const live = liveTurns[liveIndex]!
        const part = live.userParts[0]!
        const candidates = live.userParts.length === 1
            ? part.formatted === part.raw ? indicesByPrompt.get(part.raw) ?? []
                : [...new Set([...(indicesByPrompt.get(part.raw) ?? []), ...(indicesByPrompt.get(part.formatted) ?? [])])].sort((a, b) => a - b)
            : allIndices
        let lo = 0
        let hi = candidates.length
        while (lo < hi) {
            const mid = Math.floor((lo + hi) / 2)
            if (candidates[mid]! <= after) lo = mid + 1
            else hi = mid
        }
        for (let position = lo; position < candidates.length; position++) {
            const i = candidates[position]!
            if (i > latestSource[liveIndex]!) break
            if (--remainingComparisons < 0) return
            const candidate = sourceTurns[i]!
            if (!userPromptsMatch(live, candidate)) continue
            const indices = new Set(candidate.agentItems.map(item => item.index).filter(index => matchedSourceIndices.has(index)))
            const ids = new Map<string, string>()
            for (const item of candidate.agentItems) {
                if (item.kind !== 'tool-result') continue
                let prior = callIdMap.get(item.callId)
                for (let j = choices.length - 1; prior === undefined && j >= 0; j--) prior = choices[j]!.ids.get(item.callId)
                if (prior) ids.set(item.callId, prior)
            }
            if (alignTurnAgentItems(live, candidate, indices, ids, compareResults)) yield { source: i, indices, ids }
        }
    }
    // A choice is ambiguous only when two complete ordered histories fit. Use
    // an explicit stack so long transcripts do not exhaust the JS call stack.
    const stack = liveTurns.length ? [matches(0, -1)] : []
    while (stack.length) {
        const next = stack[stack.length - 1]!.next()
        if (remainingComparisons < 0) return null
        if (next.done) {
            stack.pop()
            choices.pop()
            continue
        }
        choices.push(next.value)
        if (choices.length < liveTurns.length) {
            stack.push(matches(choices.length, next.value.source))
        } else {
            if (solution) {
                if (compareResults) return null
                // Two complete histories fit. Retry with terminal result evidence,
                // sharing the original work limit and preserving unique legacy matches.
                compareResults = true
                solution = undefined
                choices.length = 0
                stack.splice(0, stack.length, matches(0, -1))
                continue
            }
            solution = [...choices]
            choices.pop()
        }
    }
    if (liveTurns.length && !solution) return null
    for (const choice of solution ?? []) {
        for (const index of choice.indices) matchedSourceIndices.add(index)
        for (const [nativeId, liveId] of choice.ids) callIdMap.set(nativeId, liveId)
    }

    const unconsumed: LocalTranscriptMessage[] = []
    for (let i = 0; i < sourceSlice.length; i += 1) {
        if (matchedSourceIndices.has(i)) continue
        unconsumed.push(rewriteToolResultCallId(sourceSlice[i]!, callIdMap))
    }
    return unconsumed
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
            priorStoredIndex = storedIndex
            priorSourceIndex = sourceIndex
        }
        const callIdMap = new Map<string, string>()
        const importedLocalIds = new Set(imported.map((imp) => imp.localId!))
        const firstImportedSourceIndex = sourceIndexById.get(imported[0]!.localId!) ?? 0
        if (firstImportedSourceIndex > 0) {
            return {
                status: 'transcript_diverged',
                message: `Local transcript changed or dropped imported entry ${imported[0]!.localId}`
            }
        }
        const allLiveMessages = storedMessages.filter((message) => !message.localId?.startsWith(importPrefix))
        const unconsumed = reconcileLiveTurns(allLiveMessages, sourceMessages, importedLocalIds, callIdMap)
        if (unconsumed === null) {
            return {
                status: 'transcript_diverged',
                message: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages'
            }
        }
        for (const stored of imported) {
            const sourceContent = rewriteToolResultCallIdContent(
                sourceContentById.get(stored.localId!),
                callIdMap
            )
            if (!sameContent(sourceContent, stored.content)) {
                return {
                    status: 'transcript_diverged',
                    message: `Local transcript changed or dropped imported entry ${stored.localId}`
                }
            }
        }
        const lastImportedSourceIndex = sourceIndexById.get(imported[imported.length - 1]!.localId!) ?? -1
        for (const msg of unconsumed) {
            const sIdx = sourceIndexById.get(msg.id) ?? -1
            if (sIdx < lastImportedSourceIndex) {
                const rec = asObj(msg.content)
                const body = rec?.role === 'agent' ? asObj(rec.content) : null
                const data = body?.type === 'codex' ? asObj(body.data) : null
                const isLateCompletionForLiveCall = data?.type === 'tool-call-result'
                if (!isLateCompletionForLiveCall) {
                    return {
                        status: 'transcript_diverged',
                        message: 'The HAPI session continued past the imported history; re-importing would duplicate or reorder messages'
                    }
                }
            }
        }
        return { status: 'ok', delta: unconsumed }
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