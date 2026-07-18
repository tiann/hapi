import { describe, expect, it } from 'vitest'
import { DeliveryOutcomeClient } from './deliveryOutcomeClient'

const items = [
    { messageId: 'm1', sequence: 1 },
    { messageId: 'm2', sequence: 2 }
]

describe('DeliveryOutcomeClient', () => {
    it('uses the production atomic batch barrier when available', async () => {
        const events: string[] = []
        const client = new DeliveryOutcomeClient({
            namespace: 'default', machineId: 'machine', sessionId: 'session', launchNonce: 'launch',
            prepare: async (requests) => { events.push(`batch:${requests.length}`); return 'success' },
            record: async (request) => { events.push(`${request.messageId}:${request.state}`); return true }
        })
        const result = await client.deliverBatch(items, 'attempt', async () => { events.push('transport') })
        expect(result).toEqual({ delivered: true })
        expect(events).toEqual(['batch:2', 'transport'])
    })

    it('quarantines an ambiguous atomic barrier acknowledgement', async () => {
        const client = new DeliveryOutcomeClient({
            namespace: 'default', machineId: 'machine', sessionId: 'session', launchNonce: 'launch',
            prepare: async () => 'ambiguous',
            record: async () => true
        })
        const result = await client.deliverBatch(items, 'attempt', async () => {
            throw new Error('transport must not run')
        })
        expect(result).toEqual({ delivered: false, reason: 'ambiguous-barrier' })
    })

    it('persists the complete batch through written before native transport', async () => {
        const events: string[] = []
        const client = new DeliveryOutcomeClient({
            namespace: 'default', machineId: 'machine', sessionId: 'session', launchNonce: 'launch',
            record: async (request) => { events.push(`${request.messageId}:${request.state}`); return true }
        })
        const result = await client.deliverBatch(items, 'attempt', async () => { events.push('transport') })
        expect(result).toEqual({ delivered: true })
        expect(events).toEqual(['m1:prepared', 'm2:prepared', 'm1:written', 'm2:written', 'transport'])
    })

    it('refuses transport and terminalizes a pre-write barrier failure', async () => {
        const events: string[] = []
        const client = new DeliveryOutcomeClient({
            namespace: 'default', machineId: 'machine', sessionId: 'session', launchNonce: 'launch',
            record: async (request) => {
                events.push(`${request.messageId}:${request.state}`)
                return !(request.messageId === 'm2' && request.state === 'prepared')
            }
        })
        const result = await client.deliverBatch(items, 'attempt', async () => { events.push('transport') })
        expect(result.delivered).toBe(false)
        expect(events).not.toContain('transport')
        expect(events).toContain('m1:definitive-no-write')
    })

    it('marks the batch ambiguous when written acknowledgement is partial', async () => {
        const events: string[] = []
        const client = new DeliveryOutcomeClient({
            namespace: 'default', machineId: 'machine', sessionId: 'session', launchNonce: 'launch',
            record: async (request) => {
                events.push(`${request.messageId}:${request.state}`)
                return !(request.messageId === 'm2' && request.state === 'written')
            }
        })
        const result = await client.deliverBatch(items, 'attempt', async () => { events.push('transport') })
        expect(result).toEqual({ delivered: false, reason: 'ambiguous-barrier' })
        expect(events).not.toContain('transport')
        expect(events).toEqual(expect.arrayContaining(['m1:ambiguous', 'm2:ambiguous']))
    })
})
