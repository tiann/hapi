import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
    SHARE_PENDING_TRANSFER_KEY,
    peekSharePendingTransfer,
    retargetSharePendingTransfer,
    setSharePendingTransfer,
} from '@/lib/sharePendingState'

const { setText, addAttachment, getShareTransfer, deleteShareTransfer } = vi.hoisted(() => ({
    setText: vi.fn(),
    addAttachment: vi.fn(async () => undefined),
    getShareTransfer: vi.fn(),
    deleteShareTransfer: vi.fn(async () => undefined),
}))

vi.mock('@assistant-ui/react', () => ({
    useAssistantApi: () => ({
        composer: () => ({ setText, addAttachment }),
    }),
    useAssistantState: (selector: (state: { composer: { text: string } }) => unknown) =>
        selector({ composer: { text: '' } }),
}))

vi.mock('@/lib/shareTransfer', () => ({
    getShareTransfer,
    deleteShareTransfer,
}))

vi.mock('@/lib/composer-drafts', () => ({
    getDraft: () => '',
}))

import { ShareSeedConsumer } from './ShareSeedConsumer'

afterEach(() => {
    cleanup()
    setText.mockReset()
    addAttachment.mockReset()
    getShareTransfer.mockReset()
    deleteShareTransfer.mockReset()
    try { window.sessionStorage.clear() } catch { /* noop */ }
})

beforeEach(() => {
    getShareTransfer.mockResolvedValue({
        title: '',
        text: 'shared payload',
        url: '',
        files: [],
        createdAt: Date.now(),
    })
})

describe('ShareSeedConsumer', () => {
    it('leaves the pending key untouched while inactive, then seeds after retarget to a new active id', async () => {
        setSharePendingTransfer('xfer-handoff', 'session-a')

        const inactive = render(
            <ShareSeedConsumer sessionId="session-a" sessionActive={false} />,
        )
        expect(peekSharePendingTransfer()).toEqual({ transferId: 'xfer-handoff', sessionId: 'session-a' })
        expect(getShareTransfer).not.toHaveBeenCalled()

        inactive.unmount()
        expect(peekSharePendingTransfer()).toEqual({ transferId: 'xfer-handoff', sessionId: 'session-a' })

        // Unrelated active chat must not steal the pending share.
        const other = render(
            <ShareSeedConsumer sessionId="session-other" sessionActive={true} />,
        )
        await Promise.resolve()
        expect(getShareTransfer).not.toHaveBeenCalled()
        expect(peekSharePendingTransfer()).toEqual({ transferId: 'xfer-handoff', sessionId: 'session-a' })
        other.unmount()

        retargetSharePendingTransfer('session-a', 'session-b')
        render(<ShareSeedConsumer sessionId="session-b" sessionActive={true} />)

        await waitFor(() => {
            expect(getShareTransfer).toHaveBeenCalledWith('xfer-handoff')
            expect(setText).toHaveBeenCalledWith('shared payload')
        })
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBeNull()
    })

    it('consumes and seeds when the same session flips from inactive to active', async () => {
        setSharePendingTransfer('xfer-same-id', 'session-a')

        const { rerender } = render(
            <ShareSeedConsumer sessionId="session-a" sessionActive={false} />,
        )
        expect(peekSharePendingTransfer()?.transferId).toBe('xfer-same-id')
        expect(getShareTransfer).not.toHaveBeenCalled()

        rerender(<ShareSeedConsumer sessionId="session-a" sessionActive={true} />)

        await waitFor(() => {
            expect(getShareTransfer).toHaveBeenCalledWith('xfer-same-id')
            expect(setText).toHaveBeenCalledWith('shared payload')
        })
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBeNull()
    })

    it('seeds only once under StrictMode double-invoke', async () => {
        setSharePendingTransfer('xfer-strict', 'session-a')

        render(
            <StrictMode>
                <ShareSeedConsumer sessionId="session-a" sessionActive={true} />
            </StrictMode>,
        )

        await waitFor(() => {
            expect(setText).toHaveBeenCalledWith('shared payload')
        })
        expect(getShareTransfer).toHaveBeenCalledTimes(1)
        expect(setText).toHaveBeenCalledTimes(1)
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBeNull()
    })
})
