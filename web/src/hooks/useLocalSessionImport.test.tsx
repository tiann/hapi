import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { describe, expect, it, vi } from 'vitest'
import { ApiError } from '../api/client'
import { useLocalSessionImport } from './useLocalSessionImport'
import type { LocalSessionImportApi, LocalSessionListResponse } from '../lib/localSessionImport'

function api(overrides: Partial<LocalSessionImportApi> = {}): LocalSessionImportApi {
    return {
        getLocalSessions: vi.fn().mockResolvedValue({
            success: true,
            sessions: [{ id: 'pi-1', title: 'Pi session', file: '/tmp/pi-1.jsonl', modifiedAt: 1 }],
            machineId: 'm-1'
        } satisfies LocalSessionListResponse),
        importLocalSessions: vi.fn().mockResolvedValue({
            success: true,
            results: [{ sessionId: 'pi-1', piSessionId: 'pi-1', action: 'created', appended: 2 }]
        }),
        ...overrides
    }
}

function harness(apiInstance: LocalSessionImportApi, props: { directory?: string | null; machineId?: string | null } = {}) {
    let result: ReturnType<typeof useLocalSessionImport> | null = null
    function Probe() {
        result = useLocalSessionImport({ api: apiInstance, flavor: 'pi', ...props })
        return null
    }
    render(<Probe />)
    return {
        get: () => {
            if (!result) throw new Error('hook not rendered')
            return result
        }
    }
}

describe('useLocalSessionImport', () => {
    type ImportResults = Awaited<ReturnType<ReturnType<typeof useLocalSessionImport>['importSessions']>>

    it('scans sessions on mount and exposes the resolved machine id', async () => {
        const apiInstance = api()
        const { get } = harness(apiInstance, { directory: '/tmp/project' })
        await waitFor(() => expect(get().isLoading).toBe(false))
        expect(apiInstance.getLocalSessions).toHaveBeenCalledWith('pi', '/tmp/project', null)
        expect(get().sessions[0]!.id).toBe('pi-1')
        expect(get().machineId).toBe('m-1')
    })

    it('unwraps ApiError bodies into the load error message', async () => {
        const apiInstance = api()
        const body = '{"success":false,"error":"No online machine available for Pi history import"}'
        apiInstance.getLocalSessions = vi.fn().mockRejectedValue(new ApiError(`HTTP 503 Service Unavailable: ${body}`, 503, 'No online machine available for Pi history import', body))
        const { get } = harness(apiInstance, { directory: '/tmp/project' })
        await waitFor(() => expect(get().isLoading).toBe(false))
        // The raw `HTTP 503 ...: {...}` envelope must not reach the UI.
        expect(get().error).toBe('No online machine available for Pi history import')
        expect(get().sessions).toEqual([])
    })

    it('imports through the flavor REST pair with the resolved machine', async () => {
        const apiInstance = api()
        const { get } = harness(apiInstance, { directory: '/tmp/project', machineId: 'requested' })
        await waitFor(() => expect(get().isLoading).toBe(false))
        let results: ImportResults | null = null
        await act(async () => {
            results = await get().importSessions(['pi-1'])
        })
        expect(apiInstance.importLocalSessions).toHaveBeenCalledWith('pi', {
            sessionIds: ['pi-1'],
            cwd: '/tmp/project',
            machineId: 'm-1'
        })
        expect((results as ImportResults)?.[0]!.sessionId).toBe('pi-1')
    })

    it('surfaces list errors without losing the previous state', async () => {
        const apiInstance = api({
            getLocalSessions: vi.fn().mockResolvedValue({ success: false, error: 'runner offline', sessions: [] })
        })
        const { get } = harness(apiInstance)
        await waitFor(() => expect(get().error).toBe('runner offline'))
        expect(get().sessions).toEqual([])
    })

    it('ignores stale scans after a refresh', async () => {
        let resolveSecond: ((value: LocalSessionListResponse) => void) | null = null
        const apiInstance = api({
            getLocalSessions: vi.fn()
                .mockImplementationOnce(async () => ({
                    success: true,
                    sessions: [{ id: 'stale', title: 'stale', file: '/x', modifiedAt: 1 }],
                    machineId: 'm-1'
                }))
                .mockImplementationOnce(() => new Promise<LocalSessionListResponse>((resolve) => {
                    resolveSecond = resolve
                }))
        })
        const { get } = harness(apiInstance)
        await waitFor(() => expect(get().isLoading).toBe(false))
        await act(async () => {
            const refreshing = get().refresh()
            resolveSecond?.({
                success: true,
                sessions: [{ id: 'fresh', title: 'fresh', file: '/x', modifiedAt: 2 }],
                machineId: 'm-1'
            })
            await refreshing
        })
        expect(get().sessions[0]!.id).toBe('fresh')
    })

    it('does nothing when import is called with an empty selection', async () => {
        const apiInstance = api()
        const { get } = harness(apiInstance)
        await waitFor(() => expect(get().isLoading).toBe(false))
        await act(async () => {
            expect(await get().importSessions([])).toBeNull()
        })
        expect(apiInstance.importLocalSessions).not.toHaveBeenCalled()
    })

    it('fires a click on the choose button through the actions strip', async () => {
        const { LocalSessionImportActions } = await import('../components/NewSession/LocalSessionImportActions')
        const onChooseHistory = vi.fn()
        render(
            <LocalSessionImportActions
                labels={{
                    inlineTitle: 'Import Pi history',
                    inlineDescription: 'Choose history',
                    inlineClear: 'Clear',
                    inlineChoose: 'Choose history',
                    loading: 'Scanning…'
                }}
                selectedSession={null}
                isLoading={false}
                isDisabled={false}
                error={null}
                onChooseHistory={onChooseHistory}
                onClear={vi.fn()}
            />
        )
        fireEvent.click(screen.getByRole('button', { name: 'Choose history' }))
        expect(onChooseHistory).toHaveBeenCalledOnce()
    })
})