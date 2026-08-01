import { describe, expect, it } from 'vitest'
import { getSupersedingSessionId } from './followSupersedingSession'

describe('getSupersedingSessionId', () => {
    it('follows a different persisted replacement identity', () => {
        expect(getSupersedingSessionId('source', { supersededBySessionId: 'fresh' })).toBe('fresh')
    })

    it('does not self-navigate for missing, blank, or identical values', () => {
        expect(getSupersedingSessionId('source', undefined)).toBeNull()
        expect(getSupersedingSessionId('source', { supersededBySessionId: '  ' })).toBeNull()
        expect(getSupersedingSessionId('source', { supersededBySessionId: 'source' })).toBeNull()
    })
})
