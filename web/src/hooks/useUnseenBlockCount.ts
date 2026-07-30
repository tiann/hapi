import { useMemo, useState } from 'react'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { countUnseenBlocks, createUnseenWatermark, type UnseenWatermark } from '@/chat/unseenBlocks'

/**
 * Tracks how many rendered blocks appeared since the user scrolled away from
 * the tail, for the "N new messages" pill.
 *
 * The watermark is captured during render rather than in an effect so the first
 * frame after leaving the tail already reports 0 instead of briefly showing a
 * stale count. This is React's "adjust state during render" pattern: the
 * setState pair runs only on the frame where viewMode actually flips, and
 * updating prevViewMode makes the condition false on the immediate re-render,
 * so it converges instead of looping.
 *
 * viewMode is seeded from the caller's current value because the message window
 * store keeps view mode per session in a module-level map — returning to a
 * session that was left in history mode must not be mistaken for a fresh
 * tail -> history transition and capture a watermark the user never saw.
 */
export function useUnseenBlockCount(
    viewMode: 'tail' | 'history',
    blocks: readonly VisibleChatBlock[]
): number {
    const [prevViewMode, setPrevViewMode] = useState(viewMode)
    const [watermark, setWatermark] = useState<UnseenWatermark | null>(null)

    if (viewMode !== prevViewMode) {
        setPrevViewMode(viewMode)
        setWatermark(viewMode === 'history' ? createUnseenWatermark(blocks) : null)
    }

    return useMemo(() => countUnseenBlocks(blocks, watermark), [blocks, watermark])
}
