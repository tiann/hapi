import { describe, expect, it } from 'bun:test'
import { Store } from './index'

describe('DeliveryAttemptStore', () => {
    it('appends valid transitions and never reopens a terminal attempt', () => {
        const store = new Store(':memory:')
        const base = { namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-1', attemptId: 'attempt-1', launchNonce: 'launch-1', sequence: 1 }
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'k1', state: 'prepared', createdAt: 1 })).toEqual({ result: 'success', state: 'prepared' })
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'k2', state: 'written', createdAt: 2 })).toEqual({ result: 'success', state: 'written' })
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'k3', state: 'accepted', createdAt: 3 })).toEqual({ result: 'success', state: 'accepted' })
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'k4', state: 'written', createdAt: 4 })).toEqual({ result: 'error', reason: 'invalid-transition' })
    })

    it('never reopens the same message under a new attempt after an ambiguous terminal state', () => {
        const store = new Store(':memory:')
        const base = { namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-1', launchNonce: 'launch-1', sequence: 1 }
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'k1', attemptId: 'attempt-1', state: 'prepared', createdAt: 1 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'k2', attemptId: 'attempt-1', state: 'ambiguous', createdAt: 2 })
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'k3', attemptId: 'attempt-1', state: 'prepared', createdAt: 3 })).toMatchObject({ result: 'error' })
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'k4', attemptId: 'attempt-2', state: 'prepared', createdAt: 4 })).toMatchObject({ result: 'error' })
        expect(store.deliveryAttempts.recoverable('default', 'session-1')).toEqual([])
    })

    it('never opens a new attempt after the prior attempt reached the written boundary', () => {
        const store = new Store(':memory:')
        const base = { namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-written', launchNonce: 'launch-1', sequence: 1 }
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'w1', attemptId: 'attempt-1', state: 'prepared', createdAt: 1 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'w2', attemptId: 'attempt-1', state: 'written', createdAt: 2 })
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'w3', attemptId: 'attempt-2', state: 'prepared', createdAt: 3 })).toMatchObject({ result: 'error' })
    })

    it('allows a new attempt only after a proven definitive no-write outcome', () => {
        const store = new Store(':memory:')
        const base = { namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-retry', launchNonce: 'launch-1', sequence: 1 }
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'n1', attemptId: 'attempt-1', state: 'prepared', createdAt: 1 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'n2', attemptId: 'attempt-1', state: 'definitive-no-write', createdAt: 2 })
        expect(store.deliveryAttempts.recoverable('default', 'session-1')).toMatchObject([{ state: 'definitive-no-write' }])
        expect(store.deliveryAttempts.append({ ...base, idempotencyKey: 'n3', attemptId: 'attempt-2', state: 'prepared', createdAt: 3 }))
            .toEqual({ result: 'success', state: 'prepared' })
    })

    it('never exposes a written attempt as recoverable', () => {
        const store = new Store(':memory:')
        const base = { namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-written-recovery', launchNonce: 'launch-1', sequence: 1, attemptId: 'attempt-1' }
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'r1', state: 'prepared', createdAt: 1 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'r2', state: 'written', createdAt: 2 })
        expect(store.deliveryAttempts.recoverable('default', 'session-1')).toEqual([])
    })

    it('does not expose an older no-write attempt after a retry reaches written', () => {
        const store = new Store(':memory:')
        const base = { namespace: 'default', canonicalSessionId: 'session-1', messageId: 'message-retried', launchNonce: 'launch-1', sequence: 1 }
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'a1', attemptId: 'attempt-1', state: 'prepared', createdAt: 1 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'a2', attemptId: 'attempt-1', state: 'definitive-no-write', createdAt: 2 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'b1', attemptId: 'attempt-2', state: 'prepared', createdAt: 3 })
        store.deliveryAttempts.append({ ...base, idempotencyKey: 'b2', attemptId: 'attempt-2', state: 'written', createdAt: 4 })

        expect(store.deliveryAttempts.recoverable('default', 'session-1')).toEqual([])
    })
})
