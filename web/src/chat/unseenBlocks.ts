import { isToolGroupBlock, type VisibleChatBlock } from '@/chat/toolGroups'

/**
 * Snapshot of the blocks the user had already seen when they scrolled away
 * from the tail. Compared against the current blocks to answer "how much new
 * content is below me".
 */
export type UnseenWatermark = {
    ids: Set<string>
}

export function createUnseenWatermark(blocks: readonly VisibleChatBlock[]): UnseenWatermark {
    return { ids: new Set(blocks.map((block) => block.id)) }
}

function isKnownBlock(block: VisibleChatBlock, ids: Set<string>): boolean {
    if (ids.has(block.id)) {
        return true
    }
    // A lone tool-call renders under its own tool id until a second eligible
    // tool arrives and absorbs it into a group, at which point the id becomes
    // `tool-group:<firstToolId>` (see createToolGroupId in toolGroups.ts).
    // Match on the member ids so that absorption doesn't look like new content.
    return isToolGroupBlock(block)
        && (ids.has(block.firstToolId) || ids.has(block.lastToolId))
}

/**
 * Counts the blocks that appeared after the last block the watermark knows
 * about — i.e. what the user would find by scrolling down.
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
        if (isKnownBlock(blocks[index], watermark.ids)) {
            return blocks.length - 1 - index
        }
    }
    // Every seen block has been trimmed out of the window. Report nothing
    // rather than claiming the whole window is new.
    return 0
}
