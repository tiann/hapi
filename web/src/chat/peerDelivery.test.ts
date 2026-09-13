import { describe, expect, it } from 'vitest'
import { getPeerDeliveryInfo, isPeerDeliveryMeta } from './peerDelivery'

describe('peerDelivery', () => {
    it('detects peer sentFrom and extracts optional source fields', () => {
        expect(isPeerDeliveryMeta({ sentFrom: 'webapp' })).toBe(false)
        expect(isPeerDeliveryMeta({ sentFrom: 'peer' })).toBe(true)
        expect(getPeerDeliveryInfo({
            sentFrom: 'peer',
            peer: {
                sourceSessionId: '6212dae5-8a60-4284-b7a5-c09aa3571ce4',
                sourceName: 'Orchestrator'
            }
        })).toEqual({
            sourceSessionId: '6212dae5-8a60-4284-b7a5-c09aa3571ce4',
            sourceName: 'Orchestrator'
        })
        expect(getPeerDeliveryInfo({ sentFrom: 'peer', peer: {} })).toEqual({
            sourceSessionId: undefined,
            sourceName: undefined
        })
    })
})
