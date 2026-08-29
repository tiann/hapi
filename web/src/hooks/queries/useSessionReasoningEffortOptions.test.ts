import { describe, expect, it } from 'vitest'
import {
    getSessionReasoningEffortRefetchInterval,
    selectSessionReasoningEffortResponse,
    shouldRetrySessionReasoningEffortQuery
} from './useSessionReasoningEffortOptions'

describe('useSessionReasoningEffortOptions retry policy', () => {
    it('retries transient failures up to three times', () => {
        expect(shouldRetrySessionReasoningEffortQuery(0)).toBe(true)
        expect(shouldRetrySessionReasoningEffortQuery(2)).toBe(true)
        expect(shouldRetrySessionReasoningEffortQuery(3)).toBe(false)
    })

    it('polls until the ACP handler returns effort options', () => {
        expect(getSessionReasoningEffortRefetchInterval(true, undefined, 0)).toBe(1000)
        expect(getSessionReasoningEffortRefetchInterval(true, { success: false, error: 'not ready' }, 2)).toBe(4000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: true,
            options: [{ value: 'low', name: 'Low' }]
        }, 1)).toBe(false)
    })

    it('keeps polling until the ACP handler returns a successful response', () => {
        expect(getSessionReasoningEffortRefetchInterval(false, undefined, 0)).toBe(false)
        expect(getSessionReasoningEffortRefetchInterval(true, undefined, 10)).toBe(8000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: false,
            error: 'not ready'
        }, 20)).toBe(8000)
        expect(getSessionReasoningEffortRefetchInterval(true, {
            success: true,
            model: 'gpt-5.6',
            options: []
        }, 20)).toBe(false)
    })

    it('rejects effort options discovered for a different applied model', () => {
        const response = {
            success: true,
            model: 'gpt-5.4',
            options: [{ value: 'high', name: 'High' }]
        }

        expect(selectSessionReasoningEffortResponse(response, 'gpt-5.6')).toEqual({
            success: false,
            error: 'Session model is still switching'
        })
        expect(selectSessionReasoningEffortResponse(response, 'gpt-5.4')).toBe(response)
    })
})
