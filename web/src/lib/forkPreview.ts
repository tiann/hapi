import { visibleBlockRole, type VisibleChatBlock } from '@/chat/toolGroups'

export type ForkPreviewTurn = {
    role: 'user' | 'assistant'
    text: string
}

export type ForkPreviewKind = 'current' | 'historical'

export type ForkPreview = {
    /** How the fork maps onto the transcript. */
    kind: ForkPreviewKind
    /** Turns copied into the new session (shown above the fork point). */
    keptTurns: ForkPreviewTurn[]
    /** Text of the selected cutoff message, which is NOT copied into the
     * new session. Null for a current-tail fork where nothing is excluded. */
    boundaryText: string | null
    /** True when the preview omits earlier copied turns. */
    prefixTruncated: boolean
}

const MAX_KEPT_TURNS = 3
const MAX_TURN_CHARS = 240

function truncate(text: string): string {
    const collapsed = text.replace(/\s+/g, ' ').trim()
    return collapsed.length > MAX_TURN_CHARS ? `${collapsed.slice(0, MAX_TURN_CHARS)}…` : collapsed
}

function blockPreviewText(block: VisibleChatBlock): { role: 'user' | 'assistant'; text: string } | null {
    const role = visibleBlockRole(block)
    if (role === 'system') return null
    let text: string | undefined
    if (block.kind === 'user-text') {
        // Attachment-only messages have empty text; surface their filenames so
        // they are not silently dropped from the preview.
        const attachments = block.attachments?.map(({ filename }) => filename).join(', ')
        text = [block.text, attachments].filter(Boolean).join(' ')
    } else if (block.kind === 'agent-text' || block.kind === 'cli-output') {
        text = block.text
    }
    if (!text || text.trim().length === 0) return null
    return { role, text }
}

/**
 * Mirrors `hub/src/sync/forkTranscript.ts#selectForkTranscriptPrefix`:
 * a historical fork copies everything BEFORE the boundary message into the
 * new session — the boundary message itself and anything after it stay out
 * of the child; a current fork (no `messageLocalId`) copies the whole
 * transcript. Queued rows (`invokedAt == null`) are never copied, matching
 * the hub filter.
 */
export function buildForkPreview(blocks: readonly VisibleChatBlock[], messageLocalId?: string): ForkPreview {
    let cutoff = blocks.length
    let boundaryText: string | null = null
    if (messageLocalId) {
        cutoff = blocks.findLastIndex((block) => block.kind !== 'agent-event' && block.kind !== 'tool-group' && block.localId === messageLocalId)
        if (cutoff < 0) return { kind: 'historical', keptTurns: [], boundaryText: null, prefixTruncated: false }
        const selected = blockPreviewText(blocks[cutoff])
        boundaryText = selected ? truncate(selected.text) : null
    }

    const turns: ForkPreviewTurn[] = []
    let previewIncomplete = false
    for (const block of blocks.slice(0, cutoff)) {
        if (block.kind === 'user-text' && (block.invokedAt ?? null) === null) continue
        const entry = blockPreviewText(block)
        if (!entry) {
            // Events are internal status rows, but other invoked blocks
            // (reasoning, tools, images, reviews) are copied by the hub and
            // intentionally omitted from this compact text preview.
            if (block.kind !== 'agent-event') previewIncomplete = true
            continue
        }
        const previous = turns[turns.length - 1]
        if (previous && previous.role === entry.role) {
            previous.text = truncate(`${previous.text} ${entry.text}`)
        } else {
            turns.push({ role: entry.role, text: truncate(entry.text) })
        }
    }
    const keptTurns = turns.slice(-MAX_KEPT_TURNS)
    return {
        kind: messageLocalId ? 'historical' : 'current',
        keptTurns,
        boundaryText,
        prefixTruncated: previewIncomplete || turns.length > keptTurns.length,
    }
}
