import type { PropsWithChildren } from 'react'
import { act, renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { ApiClient } from '@/api/client'
import { useSpawnSession } from './useSpawnSession'

function wrapper({ children }: PropsWithChildren) {
    return <QueryClientProvider client={new QueryClient({
        defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
    })}>{children}</QueryClientProvider>
}

afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
})

describe('useSpawnSession', () => {
    it('polls a pending spawn with the same request ID until the late webhook succeeds', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('crypto', {
            randomUUID: vi.fn(() => '11111111-1111-4111-8111-111111111111')
        })
        const api = {
            spawnSession: vi.fn(async () => ({
                type: 'pending' as const,
                spawnRequestId: '11111111-1111-4111-8111-111111111111'
            })),
            querySpawnSession: vi.fn(async () => ({
                type: 'success' as const,
                sessionId: 'session-late'
            }))
        } as unknown as ApiClient
        const { result } = renderHook(() => useSpawnSession(api), { wrapper })

        let spawnPromise!: ReturnType<typeof result.current.spawnSession>
        await act(async () => {
            spawnPromise = result.current.spawnSession({
                machineId: 'machine-1',
                directory: '/tmp/project',
                agent: 'codex'
            })
            await Promise.resolve()
        })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(750)
        })

        await expect(spawnPromise).resolves.toEqual({ type: 'success', sessionId: 'session-late' })
        expect(api.spawnSession).toHaveBeenCalledWith(
            'machine-1', '/tmp/project', 'codex',
            undefined, undefined, undefined, undefined, undefined, undefined, undefined, undefined,
            '11111111-1111-4111-8111-111111111111'
        )
        expect(api.querySpawnSession).toHaveBeenCalledWith(
            'machine-1',
            '11111111-1111-4111-8111-111111111111'
        )
    })

    it('reuses the request ID after an ambiguous transport error', async () => {
        vi.stubGlobal('crypto', {
            randomUUID: vi.fn(() => '22222222-2222-4222-8222-222222222222')
        })
        const spawnSession = vi.fn()
            .mockRejectedValueOnce(new Error('network disconnected after send'))
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-replayed' })
        const api = {
            spawnSession,
            querySpawnSession: vi.fn()
        } as unknown as ApiClient
        const { result } = renderHook(() => useSpawnSession(api), { wrapper })
        const input = { machineId: 'machine-1', directory: '/tmp/project', agent: 'codex' as const }

        await expect(result.current.spawnSession(input)).rejects.toThrow('network disconnected after send')
        await expect(result.current.spawnSession(input)).resolves.toEqual({
            type: 'success',
            sessionId: 'session-replayed'
        })

        expect(spawnSession).toHaveBeenCalledTimes(2)
        expect(spawnSession.mock.calls[0]?.at(-1)).toBe('22222222-2222-4222-8222-222222222222')
        expect(spawnSession.mock.calls[1]?.at(-1)).toBe('22222222-2222-4222-8222-222222222222')
    })

    it('reuses the request ID when polling fails after Runner accepted the spawn', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('crypto', {
            randomUUID: vi.fn(() => '25252525-2525-4525-8525-252525252525')
        })
        const spawnSession = vi.fn()
            .mockResolvedValueOnce({
                type: 'pending',
                spawnRequestId: '25252525-2525-4525-8525-252525252525'
            })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-after-query-retry' })
        const api = {
            spawnSession,
            querySpawnSession: vi.fn(async () => {
                throw new Error('query acknowledgement was lost')
            })
        } as unknown as ApiClient
        const { result } = renderHook(() => useSpawnSession(api), { wrapper })
        const input = { machineId: 'machine-1', directory: '/tmp/project', agent: 'codex' as const }

        let first!: ReturnType<typeof result.current.spawnSession>
        await act(async () => {
            first = result.current.spawnSession(input)
            await Promise.resolve()
        })
        const firstOutcome = first.catch((error: unknown) => error)
        await act(async () => {
            await vi.advanceTimersByTimeAsync(750)
        })
        expect(await firstOutcome).toEqual(new Error('query acknowledgement was lost'))
        await expect(result.current.spawnSession(input)).resolves.toEqual({
            type: 'success',
            sessionId: 'session-after-query-retry'
        })

        expect(spawnSession.mock.calls[0]?.at(-1)).toBe('25252525-2525-4525-8525-252525252525')
        expect(spawnSession.mock.calls[1]?.at(-1)).toBe('25252525-2525-4525-8525-252525252525')
    })

    it('replays the same request ID when an authoritative query says the Runner never received it', async () => {
        vi.useFakeTimers()
        vi.stubGlobal('crypto', {
            randomUUID: vi.fn(() => '26262626-2626-4626-8626-262626262626')
        })
        const spawnSession = vi.fn()
            .mockResolvedValueOnce({
                type: 'pending',
                spawnRequestId: '26262626-2626-4626-8626-262626262626'
            })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-replayed-after-not-found' })
        const api = {
            spawnSession,
            querySpawnSession: vi.fn(async () => ({
                type: 'not_found' as const,
                spawnRequestId: '26262626-2626-4626-8626-262626262626'
            }))
        } as unknown as ApiClient
        const { result } = renderHook(() => useSpawnSession(api), { wrapper })

        let spawnPromise!: ReturnType<typeof result.current.spawnSession>
        await act(async () => {
            spawnPromise = result.current.spawnSession({
                machineId: 'machine-1',
                directory: '/tmp/project',
                agent: 'codex'
            })
            await Promise.resolve()
        })
        await act(async () => {
            await vi.advanceTimersByTimeAsync(750)
        })

        await expect(spawnPromise).resolves.toEqual({
            type: 'success',
            sessionId: 'session-replayed-after-not-found'
        })
        expect(spawnSession).toHaveBeenCalledTimes(2)
        expect(spawnSession.mock.calls[0]?.at(-1)).toBe('26262626-2626-4626-8626-262626262626')
        expect(spawnSession.mock.calls[1]?.at(-1)).toBe('26262626-2626-4626-8626-262626262626')
    })

    it('uses a new request ID when retrying after a definitive spawn error', async () => {
        vi.stubGlobal('crypto', {
            randomUUID: vi.fn()
                .mockReturnValueOnce('33333333-3333-4333-8333-333333333333')
                .mockReturnValueOnce('44444444-4444-4444-8444-444444444444')
        })
        const spawnSession = vi.fn()
            .mockResolvedValueOnce({ type: 'error', error: 'child exited before startup' })
            .mockResolvedValueOnce({ type: 'success', sessionId: 'session-new-attempt' })
        const api = {
            spawnSession,
            querySpawnSession: vi.fn()
        } as unknown as ApiClient
        const { result } = renderHook(() => useSpawnSession(api), { wrapper })
        const input = { machineId: 'machine-1', directory: '/tmp/project', agent: 'codex' as const }

        await expect(result.current.spawnSession(input)).resolves.toEqual({
            type: 'error',
            error: 'child exited before startup'
        })
        await expect(result.current.spawnSession(input)).resolves.toEqual({
            type: 'success',
            sessionId: 'session-new-attempt'
        })

        expect(spawnSession).toHaveBeenCalledTimes(2)
        expect(spawnSession.mock.calls[0]?.at(-1)).toBe('33333333-3333-4333-8333-333333333333')
        expect(spawnSession.mock.calls[1]?.at(-1)).toBe('44444444-4444-4444-8444-444444444444')
    })
})
