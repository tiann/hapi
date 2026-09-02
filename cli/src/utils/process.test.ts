import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn()
}))

vi.mock('cross-spawn', () => ({
    default: {
        sync: spawnSyncMock
    }
}))

import { getHapiRunnerProcessIdentity } from './process'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

function setPlatform(value: NodeJS.Platform): void {
    Object.defineProperty(process, 'platform', {
        value,
        configurable: true
    })
}

function completed(stdout: string, status = 0) {
    return {
        status,
        stdout: Buffer.from(stdout),
        stderr: Buffer.from('')
    }
}

function unavailable(command: string) {
    const error = new Error(`spawnSync ${command} ENOENT`) as NodeJS.ErrnoException
    error.code = 'ENOENT'
    return {
        status: null,
        stdout: Buffer.from(''),
        stderr: Buffer.from(''),
        error
    }
}

describe('getHapiRunnerProcessIdentity on Windows', () => {
    beforeAll(() => {
        if (!originalPlatformDescriptor?.configurable) {
            throw new Error('process.platform is not configurable in this runtime')
        }
    })

    beforeEach(() => {
        setPlatform('win32')
        spawnSyncMock.mockReset()
        vi.spyOn(process, 'kill').mockReturnValue(true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('reports a foreign process when CIM identifies it', () => {
        spawnSyncMock.mockReturnValueOnce(completed('C:\\Windows\\System32\\conhost.exe'))

        expect(getHapiRunnerProcessIdentity(8328)).toBe('foreign')
        expect(spawnSyncMock).toHaveBeenCalledTimes(1)
        expect(spawnSyncMock).toHaveBeenNthCalledWith(
            1,
            'powershell',
            [
                '-NoProfile',
                '-NonInteractive',
                '-Command',
                '(Get-CimInstance Win32_Process -Filter "ProcessId = 8328").CommandLine'
            ],
            { stdio: 'pipe', windowsHide: true }
        )
    })

    it('reports the runner when CIM identifies it', () => {
        spawnSyncMock.mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
    })

    it('falls back to WMIC when PowerShell is unavailable', () => {
        spawnSyncMock
            .mockReturnValueOnce(unavailable('powershell'))
            .mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
        expect(spawnSyncMock).toHaveBeenNthCalledWith(
            2,
            'wmic',
            ['process', 'where', 'ProcessId=9124', 'get', 'CommandLine'],
            { stdio: 'pipe', windowsHide: true }
        )
    })

    it('falls back to WMIC when CIM reports no command line', () => {
        spawnSyncMock
            .mockReturnValueOnce(completed(''))
            .mockReturnValueOnce(completed('CommandLine\r\nhapi-local.exe runner start-sync\r\n'))

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('reports unknown when WMIC prints only the column header', () => {
        spawnSyncMock
            .mockReturnValueOnce(completed(''))
            .mockReturnValueOnce(completed('CommandLine\r\n\r\n'))

        expect(getHapiRunnerProcessIdentity(8328)).toBe('unknown')
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('falls back to WMIC when PowerShell exits non-zero', () => {
        spawnSyncMock
            .mockReturnValueOnce(completed('', 1))
            .mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('reports unknown when no probe reports a command line', () => {
        spawnSyncMock
            .mockReturnValueOnce(completed(''))
            .mockReturnValueOnce(unavailable('wmic'))

        expect(getHapiRunnerProcessIdentity(8328)).toBe('unknown')
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('reports dead when the pid exits while the probes run', () => {
        vi.spyOn(process, 'kill')
            .mockReturnValueOnce(true)
            .mockImplementationOnce(() => {
                throw new Error('ESRCH')
            })
        spawnSyncMock
            .mockReturnValueOnce(unavailable('powershell'))
            .mockReturnValueOnce(unavailable('wmic'))

        expect(getHapiRunnerProcessIdentity(8328)).toBe('dead')
    })

    it('reports dead without probing when the pid is already gone', () => {
        vi.spyOn(process, 'kill').mockImplementation(() => {
            throw new Error('ESRCH')
        })

        expect(getHapiRunnerProcessIdentity(8328)).toBe('dead')
        expect(spawnSyncMock).not.toHaveBeenCalled()
    })
})

describe('getHapiRunnerProcessIdentity on POSIX', () => {
    beforeEach(() => {
        setPlatform('linux')
        spawnSyncMock.mockReset()
        vi.spyOn(process, 'kill').mockReturnValue(true)
    })

    afterEach(() => {
        vi.restoreAllMocks()
    })

    afterAll(() => {
        if (originalPlatformDescriptor) {
            Object.defineProperty(process, 'platform', originalPlatformDescriptor)
        }
    })

    it('reports the runner from the ps command line', () => {
        spawnSyncMock.mockReturnValueOnce(completed('hapi runner start-sync'))

        expect(getHapiRunnerProcessIdentity(9124)).toBe('runner')
    })

    it('reports unknown when ps cannot report a command line', () => {
        spawnSyncMock.mockReturnValueOnce(completed(''))

        expect(getHapiRunnerProcessIdentity(8328)).toBe('unknown')
    })
})
