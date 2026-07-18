import { describe, expect, it } from 'bun:test'
import { Store } from '../store'
import { DeliveryOutcomeService } from './deliveryOutcomeService'

describe('DeliveryOutcomeService', () => {
    it('writes every batch member through the durable written barrier before transport', () => {
        const store = new Store(':memory:')
        const service = new DeliveryOutcomeService(store.deliveryAttempts)
        const result = service.prepareBatch([
            { idempotencyKey: 'm1:a1', namespace: 'default', canonicalSessionId: 'session-1', messageId: 'm1', attemptId: 'a1', launchNonce: 'l1', sequence: 1, createdAt: 1 },
            { idempotencyKey: 'm2:a1', namespace: 'default', canonicalSessionId: 'session-1', messageId: 'm2', attemptId: 'a1', launchNonce: 'l1', sequence: 2, createdAt: 1 }
        ])
        expect(result).toEqual({ result: 'success' })
        expect(store.deliveryAttempts.latestBatch('default', 'session-1', 'a1').map((item) => item.state)).toEqual(['written', 'written'])
    })
})
