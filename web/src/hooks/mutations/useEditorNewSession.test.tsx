import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiClient } from '@/api/client'
import { useEditorNewSession } from './useEditorNewSession'

function makeApi(spawnSession: ReturnType<typeof vi.fn>): ApiClient {
    return { spawnSession } as unknown as ApiClient
}

describe('useEditorNewSession', () => {
    beforeEach(() => {
        vi.clearAllMocks()
    })

    it('sets an error and skips API when required inputs are missing', () => {
        const spawnSession = vi.fn()
        const { result } = renderHook(() => useEditorNewSession({
            api: makeApi(spawnSession),
            machineId: null,
            projectPath: '/repo',
            onCreated: vi.fn()
        }))

        act(() => {
            result.current.createSession()
        })

        expect(spawnSession).not.toHaveBeenCalled()
        expect(result.current.error).toBe('Select a machine and project first')
    })

    it('spawns a codex session and reports the new session ID', async () => {
        const spawnSession = vi.fn(async () => ({ type: 'success', sessionId: 'session-new' }))
        const onCreated = vi.fn()
        const { result } = renderHook(() => useEditorNewSession({
            api: makeApi(spawnSession),
            machineId: 'machine-1',
            projectPath: '/repo',
            onCreated
        }))

        act(() => {
            result.current.createSession()
        })

        await waitFor(() => {
            expect(onCreated).toHaveBeenCalledWith('session-new')
        })
        expect(spawnSession).toHaveBeenCalledWith('machine-1', '/repo', 'codex')
    })

    it('exposes API error responses', async () => {
        const spawnSession = vi.fn(async () => ({ type: 'error', message: 'Runner unavailable' }))
        const { result } = renderHook(() => useEditorNewSession({
            api: makeApi(spawnSession),
            machineId: 'machine-1',
            projectPath: '/repo',
            onCreated: vi.fn()
        }))

        act(() => {
            result.current.createSession()
        })

        await waitFor(() => {
            expect(result.current.error).toBe('Runner unavailable')
        })
    })
})
