import { afterEach, describe, expect, it } from 'vitest'
import {
    SHARE_PENDING_TRANSFER_KEY,
    consumeSharePendingTransfer,
    setSharePendingTransfer,
} from './sharePendingState'

afterEach(() => {
    try { window.sessionStorage.clear() } catch { /* noop */ }
})

describe('sharePendingState', () => {
    it('round-trips a transfer id and clears the slot on consume', () => {
        setSharePendingTransfer('xfer-1')
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).toBe('xfer-1')

        const first = consumeSharePendingTransfer()
        expect(first).toBe('xfer-1')

        const second = consumeSharePendingTransfer()
        expect(second).toBeNull()
    })

    it('returns null when no transfer is pending', () => {
        expect(consumeSharePendingTransfer()).toBeNull()
    })

    it('overwrites a stale id rather than appending', () => {
        setSharePendingTransfer('a')
        setSharePendingTransfer('b')
        expect(consumeSharePendingTransfer()).toBe('b')
        expect(consumeSharePendingTransfer()).toBeNull()
    })
})
