import { normalizeDecryptedMessage } from '@/chat/normalize'
import { reduceChatBlocks } from '@/chat/reducer'
import { buildVisibleChatBlocks, visibleBlockRole, type VisibleChatBlock } from '@/chat/toolGroups'
import type { ForkPreviewResponse, ForkPreviewRow } from '@hapi/protocol/forkBoundary'
import type { DecryptedMessage } from '@/types/api'

export type ForkPreviewTurn = {
    role: 'user' | 'assistant'
    text: string
}

export type ForkPreviewView = {
    kind: ForkPreviewResponse['mode']
    /** Compact text turns copied into the new session (above the fork point). */
    keptTurns: ForkPreviewTurn[]
    /** Text of the first row beyond the fork cut; null when nothing is excluded. */
    boundaryText: string | null
    /** rewind only: compact text turns the source would delete. */
    excludedTurns: ForkPreviewTurn[]
    /** True when the preview omits copied content (hub window or non-text rows). */
    prefixTruncated: boolean
    /** rewind only: true when more rows would be deleted than shown. */
    excludedTruncated: boolean
    counts: { kept: number; excluded: number }
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

/** Run the regular chat normalize/reduce pipeline over preview rows. */
function rowsToBlocks(rows: ForkPreviewRow[]): VisibleChatBlock[] {
    const normalized = rows
        .map((row) => normalizeDecryptedMessage(row as DecryptedMessage))
        .filter((message): message is NonNullable<typeof message> => message !== null)
    const reduced = reduceChatBlocks(normalized, null)
    return buildVisibleChatBlocks(reduced.blocks, { hasMoreMessages: false })
}

function compactTurns(blocks: VisibleChatBlock[]): { turns: ForkPreviewTurn[]; incomplete: boolean } {
    const turns: ForkPreviewTurn[] = []
    let incomplete = false
    for (const block of blocks) {
        const entry = blockPreviewText(block)
        if (!entry) {
            // Events are internal status rows, but other invoked blocks
            // (reasoning, tools, images, reviews) are copied by the hub and
            // intentionally omitted from this compact text preview.
            if (block.kind !== 'agent-event') incomplete = true
            continue
        }
        const previous = turns[turns.length - 1]
        if (previous && previous.role === entry.role) {
            previous.text = truncate(`${previous.text} ${entry.text}`)
        } else {
            turns.push({ role: entry.role, text: truncate(entry.text) })
        }
    }
    return { turns, incomplete }
}

/**
 * Shape a hub fork-preview answer for display. The hub owns every boundary
 * rule; this only compacts the returned rows into previewable text and keeps
 * the truncation flags honest.
 */
export function buildForkPreviewView(response: ForkPreviewResponse): ForkPreviewView {
    const keptBlocks = rowsToBlocks(response.keptTail)
    const kept = compactTurns(keptBlocks)
    const excludedBlocks = rowsToBlocks(response.excluded)
    const excluded = compactTurns(excludedBlocks)
    const keptTurns = kept.turns.slice(-MAX_KEPT_TURNS)
    return {
        kind: response.mode,
        keptTurns,
        boundaryText: response.excluded.length > 0
            ? (excluded.turns[0]?.text ?? null)
            : null,
        excludedTurns: response.mode === 'rewind' ? excluded.turns : [],
        prefixTruncated: kept.incomplete
            || kept.turns.length > keptTurns.length
            || response.counts.kept > response.keptTail.length,
        excludedTruncated: response.mode === 'rewind'
            && response.counts.excluded > response.excluded.length,
        counts: response.counts
    }
}