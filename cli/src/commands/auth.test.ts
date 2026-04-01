import { beforeEach, describe, expect, it, vi } from 'vitest'
import { configuration } from '@/configuration'

const {
    readSettingsMock,
    clearMachineIdMock,
    updateSettingsMock,
    initializeApiUrlMock
} = vi.hoisted(() => ({
    readSettingsMock: vi.fn(),
    clearMachineIdMock: vi.fn(),
    updateSettingsMock: vi.fn(),
    initializeApiUrlMock: vi.fn(async () => {
        configuration._setApiUrl('https://hapi.example.com')
    })
}))

vi.mock('@/persistence', () => ({
    readSettings: readSettingsMock,
    clearMachineId: clearMachineIdMock,
    updateSettings: updateSettingsMock
}))

vi.mock('@/ui/apiUrlInit', () => ({
    initializeApiUrl: initializeApiUrlMock
}))

import { handleAuthCommand } from './auth'

function stripAnsi(value: string): string {
    return value.replace(/\u001B\[[0-9;]*m/g, '')
}

describe('handleAuthCommand', () => {
    beforeEach(() => {
        configuration._setApiUrl('http://localhost:3006')
        readSettingsMock.mockReset()
        clearMachineIdMock.mockReset()
        updateSettingsMock.mockReset()
        initializeApiUrlMock.mockClear()
    })

    it('loads the configured api url before printing status', async () => {
        readSettingsMock.mockResolvedValue({
            apiUrl: 'https://hapi.example.com',
            cliApiToken: 'token-from-settings',
            machineId: 'machine-123'
        })

        const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {})

        try {
            await handleAuthCommand(['status'])
            expect(initializeApiUrlMock).toHaveBeenCalledOnce()

            const output = logSpy.mock.calls
                .map((call) => stripAnsi(String(call[0])))
                .join('\n')

            expect(output).toContain('HAPI_API_URL: https://hapi.example.com')
            expect(output).toContain('CLI_API_TOKEN: set')
            expect(output).toContain('Machine ID: machine-123')
        } finally {
            logSpy.mockRestore()
        }
    })
})
