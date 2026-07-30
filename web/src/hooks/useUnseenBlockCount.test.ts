/**
 * Tests for the "N new messages" state machine. The pure counting rules live in
 * chat/unseenBlocks.test.ts; this file covers what only shows up once React is
 * driving it: when the watermark is captured, that the render-phase setState
 * converges instead of looping, and that a session left in history mode does
 * not capture a watermark on mount.
 */
import { describe, expect, it } from 'vitest'
import { renderHook } from '@testing-library/react'
import type { ChatBlock } from '@/chat/types'
import type { VisibleChatBlock } from '@/chat/toolGroups'
import { useUnseenBlockCount } from '@/hooks/useUnseenBlockCount'

type Props = {
    mode: 'tail' | 'history'
    items: VisibleChatBlock[]
}

// user-role blocks never join with each other, so each one is exactly one
// rendered row — keeping these cases about the state machine rather than about
// assistant-card joining (covered in chat/unseenBlocks.test.ts).
function block(id: string): ChatBlock {
    return { kind: 'user-text', id, localId: null, createdAt: 1, text: id }
}

function blocks(...ids: string[]): VisibleChatBlock[] {
    return ids.map(block)
}

function setup(initialProps: Props) {
    return renderHook(
        (props: Props) => useUnseenBlockCount(props.mode, props.items),
        { initialProps }
    )
}

describe('useUnseenBlockCount', () => {
    it('reports 0 while the user sits at the tail', () => {
        const { result, rerender } = setup({ mode: 'tail', items: blocks('a') })

        expect(result.current).toBe(0)
        rerender({ mode: 'tail', items: blocks('a', 'b', 'c') })
        expect(result.current).toBe(0)
    })

    it('counts blocks that arrive after the user scrolls into history', () => {
        const { result, rerender } = setup({ mode: 'tail', items: blocks('a', 'b') })

        // Scrolling up captures the watermark; nothing is new yet.
        rerender({ mode: 'history', items: blocks('a', 'b') })
        expect(result.current).toBe(0)

        rerender({ mode: 'history', items: blocks('a', 'b', 'c') })
        expect(result.current).toBe(1)

        rerender({ mode: 'history', items: blocks('a', 'b', 'c', 'd') })
        expect(result.current).toBe(2)
    })

    it('clears the count when the user returns to the tail', () => {
        const { result, rerender } = setup({ mode: 'tail', items: blocks('a') })

        rerender({ mode: 'history', items: blocks('a') })
        rerender({ mode: 'history', items: blocks('a', 'b') })
        expect(result.current).toBe(1)

        rerender({ mode: 'tail', items: blocks('a', 'b') })
        expect(result.current).toBe(0)

        // A later arrival while at the tail still counts for nothing.
        rerender({ mode: 'tail', items: blocks('a', 'b', 'c') })
        expect(result.current).toBe(0)
    })

    it('does not capture a watermark when mounting straight into history mode', () => {
        // The store keeps view mode per session, so re-opening a session that was
        // left scrolled up starts in history without a tail -> history flip.
        const { result, rerender } = setup({ mode: 'history', items: blocks('a', 'b') })

        expect(result.current).toBe(0)

        // Without a watermark nothing is attributed as new until the user
        // actually visits the tail and scrolls away again.
        rerender({ mode: 'history', items: blocks('a', 'b', 'c') })
        expect(result.current).toBe(0)

        rerender({ mode: 'tail', items: blocks('a', 'b', 'c') })
        rerender({ mode: 'history', items: blocks('a', 'b', 'c') })
        rerender({ mode: 'history', items: blocks('a', 'b', 'c', 'd') })
        expect(result.current).toBe(1)
    })

    it('settles on a stable value instead of re-rendering forever', () => {
        let renders = 0
        const { result, rerender } = renderHook(
            (props: Props) => {
                renders += 1
                return useUnseenBlockCount(props.mode, props.items)
            },
            { initialProps: { mode: 'tail', items: blocks('a') } as Props }
        )

        const afterMount = renders
        rerender({ mode: 'history', items: blocks('a') })

        // The view-mode flip costs one extra render pass to apply the watermark;
        // it must not keep re-entering the setState branch after that.
        expect(renders - afterMount).toBeLessThanOrEqual(3)
        expect(result.current).toBe(0)
    })
})
