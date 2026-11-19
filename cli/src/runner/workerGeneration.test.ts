import { afterEach, expect, it, vi } from 'vitest'
import { inspectWorkerGeneration } from './workerGeneration'
import { getProcessStartMarker, isWindows } from '@/utils/process'
import { readWindowsProcessTable } from '@/utils/windowsProcessStop'

vi.mock('@/utils/process', () => ({ getProcessStartMarker: vi.fn(), isWindows: vi.fn() }))
vi.mock('@/utils/windowsProcessStop', () => ({ readWindowsProcessTable: vi.fn() }))

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks() })

it('distinguishes a reused PID from the original worker without signalling it', async () => {
    const kill = vi.spyOn(process, 'kill')
    vi.mocked(getProcessStartMarker).mockReturnValueOnce('old').mockReturnValueOnce('new')
    expect(await inspectWorkerGeneration(1234, 'old')).toBe('matching')
    expect(await inspectWorkerGeneration(1234, 'old')).toBe('replaced')
    expect(kill).not.toHaveBeenCalled()
    vi.mocked(getProcessStartMarker).mockReturnValue(null)
    kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'EPERM' }) })
    expect(await inspectWorkerGeneration(1234, 'old')).toBe('unknown')
    kill.mockImplementation(() => { throw Object.assign(new Error(), { code: 'ESRCH' }) })
    expect(await inspectWorkerGeneration(1234, 'old')).toBe('gone')
    expect(kill.mock.calls).toEqual([[1234, 0], [1234, 0]])
})

it('requires a complete Windows snapshot to confirm absence', async () => {
    vi.mocked(isWindows).mockReturnValue(true)
    vi.mocked(readWindowsProcessTable).mockResolvedValueOnce(null).mockResolvedValueOnce(new Map())
    expect(await inspectWorkerGeneration(1234, 'old')).toBe('unknown')
    expect(await inspectWorkerGeneration(1234, 'old')).toBe('gone')
})
