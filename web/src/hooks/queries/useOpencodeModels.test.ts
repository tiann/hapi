import { describe, expect, it } from 'vitest'
import { getOpencodeModelsRefetchInterval, shouldRetryOpencodeModelsQuery } from './useOpencodeModels'

describe('useOpencodeModels retry policy', () => {
    it('retries early failures while the session model RPC may still be registering', () => {
        expect(shouldRetryOpencodeModelsQuery(0)).toBe(true)
        expect(shouldRetryOpencodeModelsQuery(2)).toBe(true)
        expect(shouldRetryOpencodeModelsQuery(3)).toBe(false)
    })

    it('polls briefly until OpenCode session models are discovered', () => {
        expect(getOpencodeModelsRefetchInterval(true, undefined, 0)).toBe(1000)
        expect(getOpencodeModelsRefetchInterval(true, { success: true, availableModels: [] }, 1)).toBe(1000)
        expect(getOpencodeModelsRefetchInterval(true, { success: false, error: 'not ready' }, 2)).toBe(1000)
    })

    it('keeps tracking at a slower cadence once model options are available, stops when disabled', () => {
        expect(getOpencodeModelsRefetchInterval(true, {
            success: true,
            availableModels: [{ modelId: 'provider/model', name: 'Provider Model' }],
            currentModelId: 'provider/model'
        }, 1)).toBe(15_000)
        expect(getOpencodeModelsRefetchInterval(false, undefined, 0)).toBe(false)
    })

    it('stops the fast discovery polling after the poll cap, but keeps slow tracking once discovered', () => {
        expect(getOpencodeModelsRefetchInterval(true, undefined, 10)).toBe(15_000)
        expect(getOpencodeModelsRefetchInterval(true, { success: false, error: 'not ready' }, 10)).toBe(15_000)
        // A successful-but-empty catalog is also capped out of fast polling.
        expect(getOpencodeModelsRefetchInterval(true, { success: true, availableModels: [] }, 10)).toBe(15_000)
        expect(getOpencodeModelsRefetchInterval(true, { success: true, availableModels: [] }, 1)).toBe(1000)
    })
})
