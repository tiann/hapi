import { isToolGroupBlock, visibleBlockRole, type VisibleChatBlock } from '@/chat/toolGroups'

/**
 * Snapshot of the blocks the user had already seen when they scrolled away
 * from the tail. Compared against the current blocks to answer "how much new
 * content is below me".
 *
 * Tracks localId alongside id because a block's id is not stable: an optimistic
 * row is replaced by a stored row carrying the same localId under a new server
 * id (mergeMessages in lib/messages.ts), and the rendered block uses the message
 * id. Without localId, the user's own message would read as new content the
 * moment its echo arrives.
 */
export type UnseenWatermark = {
    ids: Set<string>
    localIds: Set<string>
}

function getLocalId(block: VisibleChatBlock): string | null {
    return 'localId' in block ? block.localId : null
}

export function createUnseenWatermark(blocks: readonly VisibleChatBlock[]): UnseenWatermark {
    const ids = new Set<string>()
    const localIds = new Set<string>()
    for (const block of blocks) {
        ids.add(block.id)
        const localId = getLocalId(block)
        if (localId) {
            localIds.add(localId)
        }
    }
    return { ids, localIds }
}

function isKnownBlock(block: VisibleChatBlock, watermark: UnseenWatermark): boolean {
    if (watermark.ids.has(block.id)) {
        return true
    }
    const localId = getLocalId(block)
    if (localId && watermark.localIds.has(localId)) {
        return true
    }
    // A lone tool-call renders under its own tool id until a second eligible
    // tool arrives and absorbs it into a group, at which point the id becomes
    // `tool-group:<firstToolId>` (see createToolGroupId in toolGroups.ts).
    // Match on the member ids so that absorption doesn't look like new content.
    return isToolGroupBlock(block)
        && (watermark.ids.has(block.firstToolId) || watermark.ids.has(block.lastToolId))
}

/**
 * Counts the rows that appeared after the anchor. Blocks are not rows:
 * `@assistant-ui/react` joins a run of adjacent assistant-role blocks into one
 * card, so a response made of reasoning + text + a tool call renders as a single
 * new row. Role assignment is shared with the runtime via `visibleBlockRole` so
 * the two cannot drift apart.
 */
function countRenderedRowsAfter(blocks: readonly VisibleChatBlock[], anchor: number): number {
    let rows = 0
    let previousRole = visibleBlockRole(blocks[anchor])
    for (let index = anchor + 1; index < blocks.length; index += 1) {
        const role = visibleBlockRole(blocks[index])
        // A new row starts unless this block joins the assistant card above it.
        if (role !== 'assistant' || previousRole !== 'assistant') {
            rows += 1
        }
        previousRole = role
    }
    return rows
}

/**
 * Counts the rendered rows that appeared after the last block the watermark
 * knows about — i.e. what the user would find by scrolling down.
 *
 * Deliberately anchor-based rather than timestamp-based: the blocks array is
 * not monotonic in `createdAt` (messages sort by `invokedAt ?? createdAt`, so a
 * queued message lands at the end while carrying an old `createdAt`), and
 * optimistic rows change both id and `createdAt` when the server row replaces
 * them. Anchoring on the last recognized block sidesteps all of that, and makes
 * prepended history (loadMore) free: older blocks land before the anchor.
 *
 * Only counts blocks that are actually in the window. When the user scrolls far
 * enough back that the history window fills up (HISTORY_WINDOW_SIZE), incoming
 * messages are trimmed off the tail by mergeIntoWindow and never reach the
 * reducer, so this reports 0. That is intentional: under-reporting beats the
 * old behaviour of counting raw messages, and entering tail mode force-refetches
 * the latest page anyway.
 */
export function countUnseenBlocks(
    blocks: readonly VisibleChatBlock[],
    watermark: UnseenWatermark | null
): number {
    if (!watermark || watermark.ids.size === 0) {
        return 0
    }
    for (let index = blocks.length - 1; index >= 0; index -= 1) {
        if (isKnownBlock(blocks[index], watermark)) {
            return countRenderedRowsAfter(blocks, index)
        }
    }
    // Every seen block has been trimmed out of the window. Report nothing
    // rather than claiming the whole window is new.
    return 0
}
