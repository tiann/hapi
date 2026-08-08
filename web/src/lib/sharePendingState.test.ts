import { afterEach, describe, expect, it } from 'vitest'
import {
    SHARE_PENDING_TRANSFER_KEY,
    consumeSharePendingTransfer,
    peekSharePendingTransfer,
    retargetSharePendingTransfer,
    setSharePendingTransfer,
} from './sharePendingState'

afterEach(() => {
    try { window.sessionStorage.clear() } catch { /* noop */ }
})

describe('sharePendingState', () => {
    it('round-trips a transfer id bound to a session and clears on consume', () => {
        setSharePendingTransfer('xfer-1', 'session-a')
        expect(peekSharePendingTransfer()).toEqual({ transferId: 'xfer-1', sessionId: 'session-a' })

        const first = consumeSharePendingTransfer('session-a')
        expect(first).toBe('xfer-1')

        const second = consumeSharePendingTransfer('session-a')
        expect(second).toBeNull()
    })

    it('does not let a different session steal a bound pending transfer', () => {
        setSharePendingTransfer('xfer-bound', 'session-a')
        expect(consumeSharePendingTransfer('session-b')).toBeNull()
        expect(window.sessionStorage.getItem(SHARE_PENDING_TRANSFER_KEY)).not.toBeNull()
        expect(consumeSharePendingTransfer('session-a')).toBe('xfer-bound')
    })

    it('retargets the pending session id across reopen id-swap', () => {
        setSharePendingTransfer('xfer-1', 'session-a')
        retargetSharePendingTransfer('session-a', 'session-b')
        expect(peekSharePendingTransfer()).toEqual({ transferId: 'xfer-1', sessionId: 'session-b' })
        expect(consumeSharePendingTransfer('session-a')).toBeNull()
        expect(consumeSharePendingTransfer('session-b')).toBe('xfer-1')
    })

    it('returns null when no transfer is pending', () => {
        expect(consumeSharePendingTransfer('any')).toBeNull()
    })

    it('overwrites a stale id rather than appending', () => {
        setSharePendingTransfer('a', 'session-a')
        setSharePendingTransfer('b', 'session-a')
        expect(consumeSharePendingTransfer('session-a')).toBe('b')
        expect(consumeSharePendingTransfer('session-a')).toBeNull()
    })

    it('claims a legacy unbound bare transfer id string', () => {
        window.sessionStorage.setItem(SHARE_PENDING_TRANSFER_KEY, 'legacy-xfer')
        expect(consumeSharePendingTransfer('session-any')).toBe('legacy-xfer')
        expect(consumeSharePendingTransfer('session-any')).toBeNull()
    })
})
