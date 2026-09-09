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

    it('keeps polling while the reported options belong to a previous model, bounded', () => {
        const staleData = {
            success: true,
            options: [{ value: 'low', name: 'Low' }],
            currentModelId: 'opencode/big-pickle'
        }
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 12, 'opencode/hy3-free')).toBe(1000)
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 60, 'opencode/hy3-free')).toBe(30_000)
        // Matching model: options are current, no mismatch polling.
        expect(getOpencodeReasoningEffortRefetchInterval(true, { ...staleData, currentModelId: 'opencode/hy3-free' }, 12, 'opencode/hy3-free')).toBe(false)
        // No target model to compare against: fall back to discovery behavior.
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 12)).toBe(false)
    })

    it('polls toward the resolved Default target when the session model is null', () => {
        const staleData = {
            success: true,
            options: [{ value: 'low', name: 'Low' }],
            currentModelId: 'opencode/previous',
            targetModelId: 'opencode/default'
        }
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 12)).toBe(1000)
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 60)).toBe(30_000)
    })

    it('keeps polling when a variant-less previous model reports no options', () => {
        const staleData = {
            success: false,
            error: 'not available',
            currentModelId: 'opencode/big-pickle'
        }
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 12, 'opencode-go/ox-alpha-free')).toBe(1000)
        expect(getOpencodeReasoningEffortRefetchInterval(true, staleData, 60, 'opencode-go/ox-alpha-free')).toBe(30_000)
    })
})
