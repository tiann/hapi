import { StrictMode } from 'react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { cleanup, render, waitFor } from '@testing-library/react'
import {
    SHARE_PENDING_TRANSFER_KEY,
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
    it('leaves the pending key untouched while inactive, then seeds on a new active session id', async () => {
        setSharePendingTransfer('xfer-handoff')

        const inactive = render(
            <ShareSeedConsumer sessionId="session-a" sessionActive={false} />,
        )
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBe('xfer-handoff')
        expect(getShareTransfer).not.toHaveBeenCalled()

        inactive.unmount()
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBe('xfer-handoff')

        render(<ShareSeedConsumer sessionId="session-b" sessionActive={true} />)

        await waitFor(() => {
            expect(getShareTransfer).toHaveBeenCalledWith('xfer-handoff')
            expect(setText).toHaveBeenCalledWith('shared payload')
        })
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBeNull()
    })

    it('consumes and seeds when the same session flips from inactive to active', async () => {
        setSharePendingTransfer('xfer-same-id')

        const { rerender } = render(
            <ShareSeedConsumer sessionId="session-a" sessionActive={false} />,
        )
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBe('xfer-same-id')
        expect(getShareTransfer).not.toHaveBeenCalled()

        rerender(<ShareSeedConsumer sessionId="session-a" sessionActive={true} />)

        await waitFor(() => {
            expect(getShareTransfer).toHaveBeenCalledWith('xfer-same-id')
            expect(setText).toHaveBeenCalledWith('shared payload')
        })
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBeNull()
    })

    it('seeds only once under StrictMode double-invoke', async () => {
        setSharePendingTransfer('xfer-strict')

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
