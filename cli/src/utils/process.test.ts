import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'

const { spawnSyncMock } = vi.hoisted(() => ({
    spawnSyncMock: vi.fn()
}))

vi.mock('cross-spawn', () => ({
    default: {
        sync: spawnSyncMock
    }
}))

import { isHapiRunnerProcess } from './process'

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

describe('isHapiRunnerProcess on Windows', () => {
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

    it('rejects a foreign process when CIM identifies it', () => {
        spawnSyncMock.mockReturnValueOnce(completed('C:\\Windows\\System32\\conhost.exe'))

        expect(isHapiRunnerProcess(8328)).toBe(false)
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

    it('accepts the runner when CIM identifies it', () => {
        spawnSyncMock.mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(isHapiRunnerProcess(9124)).toBe(true)
    })

    it('falls back to WMIC when PowerShell is unavailable', () => {
        spawnSyncMock
            .mockReturnValueOnce(unavailable('powershell'))
            .mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(isHapiRunnerProcess(9124)).toBe(true)
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
            .mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(isHapiRunnerProcess(9124)).toBe(true)
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('falls back to WMIC when PowerShell exits non-zero', () => {
        spawnSyncMock
            .mockReturnValueOnce(completed('', 1))
            .mockReturnValueOnce(completed('hapi-local.exe runner start-sync'))

        expect(isHapiRunnerProcess(9124)).toBe(true)
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('preserves a live runner state when no probe reports a command line', () => {
        spawnSyncMock
            .mockReturnValueOnce(completed(''))
            .mockReturnValueOnce(unavailable('wmic'))

        expect(isHapiRunnerProcess(8328)).toBe(true)
        expect(spawnSyncMock).toHaveBeenCalledTimes(2)
    })

    it('rejects the pid when it exits while the probes run', () => {
        vi.spyOn(process, 'kill')
            .mockReturnValueOnce(true)
            .mockImplementationOnce(() => {
                throw new Error('ESRCH')
            })
        spawnSyncMock
            .mockReturnValueOnce(unavailable('powershell'))
            .mockReturnValueOnce(unavailable('wmic'))

        expect(isHapiRunnerProcess(8328)).toBe(false)
    })
})
