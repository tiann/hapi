import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../../hub/src/index', () => ({}))

import { executeHubCommand, parseHubArgs } from './hub'

const MANAGED_ENV_KEYS = [
    'HAPI_LISTEN_HOST',
    'HAPI_LISTEN_PORT',
    'WEBAPP_HOST',
    'WEBAPP_PORT',
] as const

describe('hubCommand', () => {
    const originalEnv = new Map<string, string | undefined>()

    beforeEach(() => {
        for (const key of MANAGED_ENV_KEYS) {
            originalEnv.set(key, process.env[key])
            delete process.env[key]
        }
    })

    afterEach(() => {
        for (const key of MANAGED_ENV_KEYS) {
            const value = originalEnv.get(key)
            if (value === undefined) {
                delete process.env[key]
            } else {
                process.env[key] = value
            }
        }
        originalEnv.clear()
    })

    it('maps --host and --port to the Hub configuration environment', async () => {
        const loadHub = vi.fn(async () => {})
        await executeHubCommand(['--host', '127.0.0.2', '--port', '32123'], loadHub)

        expect(process.env.HAPI_LISTEN_HOST).toBe('127.0.0.2')
        expect(process.env.HAPI_LISTEN_PORT).toBe('32123')
        expect(process.env.WEBAPP_HOST).toBeUndefined()
        expect(process.env.WEBAPP_PORT).toBeUndefined()
        expect(loadHub).toHaveBeenCalledOnce()
    })

    it('short-circuits help before loading Hub runtime assets', async () => {
        const loadHub = vi.fn(async () => {})
        const stdout = vi.spyOn(console, 'log').mockImplementation(() => {})

        await executeHubCommand(['--help'], loadHub)

        expect(loadHub).not.toHaveBeenCalled()
        expect(stdout.mock.calls.flat().join('\n')).toContain('hapi hub')
        stdout.mockRestore()
    })

    it('rejects unknown and incomplete flags instead of starting Hub', async () => {
        const loadHub = vi.fn(async () => {})

        await expect(executeHubCommand(['--definitely-unknown'], loadHub)).rejects.toThrow(
            'Unknown hapi hub option: --definitely-unknown',
        )
        await expect(executeHubCommand(['--port'], loadHub)).rejects.toThrow(
            'Missing value for hapi hub option: --port',
        )
        expect(loadHub).not.toHaveBeenCalled()
    })

    it('keeps relay flags available to the Hub entrypoint while parsing local flags', () => {
        expect(parseHubArgs(['--relay', '--host=127.0.0.3', '--port=43123'])).toEqual({
            help: false,
            host: '127.0.0.3',
            port: '43123',
        })
    })
})
