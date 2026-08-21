import { describe, expect, it } from 'vitest'
import { getSessionReasoningEffortRefetchInterval, shouldRetrySessionReasoningEffortQuery } from './useSessionReasoningEffortOptions'

describe('useSessionReasoningEffortOptions retry policy', () => {
    it('retries transient failures up to three times', () => {
        expect(shouldRetrySessionReasoningEffortQuery(0)).toBe(true)
        expect(shouldRetrySessionReasoningEffortQuery(2)).toBe(true)
        expect(shouldRetrySessionReasoningEffortQuery(3)).toBe(false)
    })

    it('polls until the ACP handler returns effort options', () => {
        expect(getSessionReasoningEffortRefetchInterval(true, undefined, 0)).toBe(1000)
        expect(getSessionReasoningEffortRefetchInterval(true, { success: false, error: 'not ready' }, 2)).toBe(1000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: true,
            options: [{ value: 'low', name: 'Low' }]
        }, 1)).toBe(false)
    })

    it('stops polling when disabled or after the max poll count', () => {
        expect(getSessionReasoningEffortRefetchInterval(false, undefined, 0)).toBe(false)
        expect(getSessionReasoningEffortRefetchInterval(true, undefined, 10)).toBe(false)
    })
})
