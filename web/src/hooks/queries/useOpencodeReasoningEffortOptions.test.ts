import { describe, expect, it } from 'vitest'
import { getOpencodeReasoningEffortRefetchInterval, shouldRetryOpencodeReasoningEffortQuery } from './useOpencodeReasoningEffortOptions'

describe('useOpencodeReasoningEffortOptions retry policy', () => {
    it('retries transient failures up to three times', () => {
        expect(shouldRetryOpencodeReasoningEffortQuery(0)).toBe(true)
        expect(shouldRetryOpencodeReasoningEffortQuery(2)).toBe(true)
        expect(shouldRetryOpencodeReasoningEffortQuery(3)).toBe(false)
    })

    it('polls until options are available', () => {
        expect(getOpencodeReasoningEffortRefetchInterval(true, undefined, 0)).toBe(1000)
        expect(getOpencodeReasoningEffortRefetchInterval(true, { success: false, error: 'not ready' }, 2)).toBe(1000)
        expect(getOpencodeReasoningEffortRefetchInterval(true, {
            success: true,
            options: [{ value: 'low', name: 'Low' }]
        }, 1)).toBe(false)
    })

    it('stops polling when disabled or after the max poll count', () => {
        expect(getOpencodeReasoningEffortRefetchInterval(false, undefined, 0)).toBe(false)
        expect(getOpencodeReasoningEffortRefetchInterval(true, undefined, 10)).toBe(false)
    })
})
