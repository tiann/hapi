import { afterEach, beforeEach, describe, expect, it, vi, type MockInstance } from 'vitest'

const { configurationMock, readSettingsMock, updateSettingsMock } = vi.hoisted(() => ({
    configurationMock: { _setApiUrl: vi.fn() },
    readSettingsMock: vi.fn(),
    updateSettingsMock: vi.fn()
}))

vi.mock('@/configuration', () => ({ configuration: configurationMock }))
vi.mock('@/persistence', () => ({
    readSettings: readSettingsMock,
    updateSettings: updateSettingsMock
}))

import { initializeApiUrl } from './apiUrlInit'

describe('initializeApiUrl', () => {
    const originalApiUrl = process.env.HAPI_API_URL
    let warnSpy: MockInstance

    beforeEach(() => {
        delete process.env.HAPI_API_URL
        configurationMock._setApiUrl.mockReset()
        readSettingsMock.mockReset()
        readSettingsMock.mockResolvedValue({})
        updateSettingsMock.mockReset()
        updateSettingsMock.mockImplementation(async (updater: (current: object) => object) => updater({}))
        warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    })

    afterEach(() => {
        warnSpy.mockRestore()
        if (originalApiUrl === undefined) {
            delete process.env.HAPI_API_URL
        } else {
            process.env.HAPI_API_URL = originalApiUrl
        }
    })

    it('normalizes a scheme-less HAPI_API_URL without persisting it', async () => {
        process.env.HAPI_API_URL = 'hapi.example.com'

        await expect(initializeApiUrl()).resolves.toBe('env')

        expect(configurationMock._setApiUrl).toHaveBeenCalledWith('https://hapi.example.com')
        expect(updateSettingsMock).not.toHaveBeenCalled()
        expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('normalized'))
    })

    it('fails with an actionable message for an unusable HAPI_API_URL', async () => {
        process.env.HAPI_API_URL = 'not a url'

        await expect(initializeApiUrl()).rejects.toThrow(/HAPI_API_URL must be an absolute http\(s\) URL/)
        expect(configurationMock._setApiUrl).not.toHaveBeenCalled()
    })

    it('rejects a HAPI_API_URL with embedded credentials', async () => {
        process.env.HAPI_API_URL = 'https://user:pass@hapi.example.com'

        await expect(initializeApiUrl()).rejects.toThrow(/without embedded credentials/)
        expect(configurationMock._setApiUrl).not.toHaveBeenCalled()
    })

    it('normalizes a stored apiUrl and writes the fix back', async () => {
        readSettingsMock.mockResolvedValue({ apiUrl: 'hapi.example.com' })

        await expect(initializeApiUrl()).resolves.toBe('settings')

        expect(configurationMock._setApiUrl).toHaveBeenCalledWith('https://hapi.example.com')
        expect(updateSettingsMock).toHaveBeenCalledTimes(1)
        const updater = updateSettingsMock.mock.calls[0]![0] as (current: object) => object
        await expect(Promise.resolve(updater({ machineId: 'machine-1' }))).resolves.toEqual({
            machineId: 'machine-1',
            apiUrl: 'https://hapi.example.com'
        })
    })

    it('leaves an already normalized stored apiUrl untouched', async () => {
        readSettingsMock.mockResolvedValue({ apiUrl: 'https://hapi.example.com' })

        await expect(initializeApiUrl()).resolves.toBe('settings')

        expect(configurationMock._setApiUrl).toHaveBeenCalledWith('https://hapi.example.com')
        expect(updateSettingsMock).not.toHaveBeenCalled()
        expect(warnSpy).not.toHaveBeenCalled()
    })

    it('normalizes and migrates the legacy serverUrl field', async () => {
        readSettingsMock.mockResolvedValue({ serverUrl: 'http://10.1.2.3:3006/' })

        await expect(initializeApiUrl()).resolves.toBe('settings')

        expect(configurationMock._setApiUrl).toHaveBeenCalledWith('http://10.1.2.3:3006')
        expect(updateSettingsMock).toHaveBeenCalledTimes(1)
        const updater = updateSettingsMock.mock.calls[0]![0] as (current: object) => object
        await expect(Promise.resolve(updater({
            machineId: 'machine-1',
            serverUrl: 'http://10.1.2.3:3006/'
        }))).resolves.toEqual({
            machineId: 'machine-1',
            apiUrl: 'http://10.1.2.3:3006'
        })
    })

    it('falls back to the legacy serverUrl when apiUrl is empty and completes the migration', async () => {
        readSettingsMock.mockResolvedValue({ apiUrl: '', serverUrl: 'http://10.1.2.3:3006' })

        await expect(initializeApiUrl()).resolves.toBe('settings')

        expect(configurationMock._setApiUrl).toHaveBeenCalledWith('http://10.1.2.3:3006')
        expect(updateSettingsMock).toHaveBeenCalledTimes(1)
        const updater = updateSettingsMock.mock.calls[0]![0] as (current: object) => object
        await expect(Promise.resolve(updater({
            machineId: 'machine-1',
            apiUrl: '',
            serverUrl: 'http://10.1.2.3:3006'
        }))).resolves.toEqual({
            machineId: 'machine-1',
            apiUrl: 'http://10.1.2.3:3006'
        })
    })

    it('rejects an unusable stored apiUrl', async () => {
        readSettingsMock.mockResolvedValue({ apiUrl: 'not a url' })

        await expect(initializeApiUrl()).rejects.toThrow(/settings.json apiUrl/)
        expect(configurationMock._setApiUrl).not.toHaveBeenCalled()
    })

    it('keeps the default when nothing is configured', async () => {
        await expect(initializeApiUrl()).resolves.toBe('default')

        expect(configurationMock._setApiUrl).not.toHaveBeenCalled()
        expect(updateSettingsMock).not.toHaveBeenCalled()
    })
})
