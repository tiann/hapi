import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { initializeApiUrlMock, readSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
    initializeApiUrlMock: vi.fn(async () => {}),
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

describe('initializeToken extra headers', () => {
    const originalExtraHeadersEnv = process.env.HAPI_EXTRA_HEADERS_JSON

    beforeEach(() => {
        delete process.env.HAPI_EXTRA_HEADERS_JSON
        configuration._setCliApiToken('token-from-env')
        configuration._setExtraHeaders({})
        initializeApiUrlMock.mockClear()
        readSettingsMock.mockReset()
        updateSettingsMock.mockReset()
    })

    afterEach(() => {
        if (originalExtraHeadersEnv === undefined) {
            delete process.env.HAPI_EXTRA_HEADERS_JSON
        } else {
            process.env.HAPI_EXTRA_HEADERS_JSON = originalExtraHeadersEnv
        }
        configuration._setExtraHeaders({})
    })

    it('loads extra headers from settings even when the token is already initialized', async () => {
        readSettingsMock.mockResolvedValue({
            extraHeaders: {
                'CF-Access-Client-Id': 'client-id',
                'CF-Access-Client-Secret': 'client-secret'
            }
        })

        await initializeToken()

        expect(configuration.extraHeaders).toEqual({
            'CF-Access-Client-Id': 'client-id',
            'CF-Access-Client-Secret': 'client-secret'
        })
    })

    it('loads both the token and extra headers from settings', async () => {
        configuration._setCliApiToken('')
        readSettingsMock.mockResolvedValue({
            cliApiToken: 'token-from-settings',
            extraHeaders: {
                Cookie: 'CF_Authorization=from-settings'
            }
        })

        await initializeToken()

        expect(configuration.cliApiToken).toBe('token-from-settings')
        expect(configuration.extraHeaders).toEqual({
            Cookie: 'CF_Authorization=from-settings'
        })
    })

    it('keeps environment extra headers instead of loading settings', async () => {
        process.env.HAPI_EXTRA_HEADERS_JSON = '{"X-Source":"environment"}'
        configuration._setExtraHeaders({ 'X-Source': 'environment' })
        readSettingsMock.mockResolvedValue({
            extraHeaders: { 'X-Source': 'settings' }
        })

        await initializeToken()

        expect(configuration.extraHeaders).toEqual({ 'X-Source': 'environment' })
        expect(readSettingsMock).not.toHaveBeenCalled()
    })

    it.each(['{}', '{not-json'])(
        'does not fall back to settings when the environment value is %s',
        async (environmentValue) => {
            process.env.HAPI_EXTRA_HEADERS_JSON = environmentValue
            configuration._setExtraHeaders({})
            readSettingsMock.mockResolvedValue({
                extraHeaders: { Cookie: 'CF_Authorization=from-settings' }
            })

            await initializeToken()

            expect(configuration.extraHeaders).toEqual({})
            expect(readSettingsMock).not.toHaveBeenCalled()
        }
    )

    it('drops non-string settings header values without exposing them', async () => {
        const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
        readSettingsMock.mockResolvedValue({
            extraHeaders: {
                Cookie: 'CF_Authorization=valid',
                'X-Numeric-Secret': 12345,
                'X-Boolean-Secret': true
            }
        })

        await initializeToken()

        expect(configuration.extraHeaders).toEqual({
            Cookie: 'CF_Authorization=valid'
        })
        expect(warnSpy).toHaveBeenCalledWith(
            '[WARN] settings.json extraHeaders only supports string header values. Ignoring non-string entries.'
        )
        expect(JSON.stringify(warnSpy.mock.calls)).not.toContain('12345')
        warnSpy.mockRestore()
    })
})
