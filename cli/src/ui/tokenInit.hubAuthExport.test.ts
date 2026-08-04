import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { initializeApiUrlMock, readSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
    initializeApiUrlMock: vi.fn(async (): Promise<'env' | 'settings' | 'default'> => 'default'),
    readSettingsMock: vi.fn(),
    updateSettingsMock: vi.fn()
}))

vi.mock('@/ui/apiUrlInit', () => ({
    initializeApiUrl: initializeApiUrlMock
}))

vi.mock('@/persistence', () => ({
    readSettings: readSettingsMock,
    updateSettings: updateSettingsMock
}))

import { configuration } from '@/configuration'
import { initializeToken } from './tokenInit'

describe('initializeToken hub auth export', () => {
    const previousUrl = process.env.HAPI_API_URL
    const previousToken = process.env.CLI_API_TOKEN

    beforeEach(() => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        delete process.env.HAPI_EXTRA_HEADERS_JSON
        configuration._setCliApiToken('')
        configuration._setApiUrl('http://localhost:3006')
        configuration._setExtraHeaders({})
        initializeApiUrlMock.mockReset()
        initializeApiUrlMock.mockResolvedValue('default')
        readSettingsMock.mockReset()
        updateSettingsMock.mockReset()
    })

    afterEach(() => {
        if (previousUrl === undefined) {
            delete process.env.HAPI_API_URL
        } else {
            process.env.HAPI_API_URL = previousUrl
        }
        if (previousToken === undefined) {
            delete process.env.CLI_API_TOKEN
        } else {
            process.env.CLI_API_TOKEN = previousToken
        }
        configuration._setExtraHeaders({})
    })

    it('exports neither default localhost URL nor settings token (keep auto-start + secret out of agent env)', async () => {
        configuration._setCliApiToken('')
        readSettingsMock.mockResolvedValue({
            cliApiToken: 'token-from-settings'
        })

        await initializeToken()

        expect(configuration.cliApiToken).toBe('token-from-settings')
        expect(process.env.CLI_API_TOKEN).toBeUndefined()
        expect(process.env.HAPI_API_URL).toBeUndefined()
    })

    it('exports settings hub URL without mirroring the token', async () => {
        initializeApiUrlMock.mockResolvedValue('settings')
        configuration._setApiUrl('http://remote-hub:3006')
        configuration._setCliApiToken('token-from-env')
        readSettingsMock.mockResolvedValue({})

        await initializeToken()

        expect(process.env.HAPI_API_URL).toBe('http://remote-hub:3006')
        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })
})
