import { act, renderHook } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { useSubmissionLock } from './useSubmissionLock'

describe('useSubmissionLock', () => {
    it('locks synchronously before async preflight and rejects duplicate submissions', async () => {
        let release!: () => void
        const operation = vi.fn(async () => await new Promise<string>((resolve) => {
            release = () => resolve('created')
        }))
        const duplicate = vi.fn(async () => 'duplicate')
        const { result } = renderHook(() => useSubmissionLock())

        let first!: Promise<{ started: boolean; value?: string }>
        let second!: Promise<{ started: boolean; value?: string }>
        act(() => {
            first = result.current.run(operation)
            second = result.current.run(duplicate)
        })

        expect(result.current.isLocked).toBe(true)
        await expect(second).resolves.toEqual({ started: false })
        expect(duplicate).not.toHaveBeenCalled()

        await act(async () => {
            release()
            await expect(first).resolves.toEqual({ started: true, value: 'created' })
        })
        expect(result.current.isLocked).toBe(false)
        expect(operation).toHaveBeenCalledOnce()
    })
})
