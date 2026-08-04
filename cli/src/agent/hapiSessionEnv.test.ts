import { afterEach, describe, expect, it } from 'vitest'
import { configuration } from '@/configuration'
import {
    HAPI_SESSION_ID_ENV,
    exportHapiHubAuthEnv,
    exportHapiSessionEnv
} from './hapiSessionEnv'

describe('exportHapiSessionEnv', () => {
    afterEach(() => {
        delete process.env[HAPI_SESSION_ID_ENV]
    })

    it('publishes HAPI_SESSION_ID for child agent shells', () => {
        exportHapiSessionEnv('session-abc')
        expect(process.env[HAPI_SESSION_ID_ENV]).toBe('session-abc')
    })

    it('ignores empty session ids', () => {
        delete process.env[HAPI_SESSION_ID_ENV]
        exportHapiSessionEnv('')
        expect(process.env[HAPI_SESSION_ID_ENV]).toBeUndefined()
    })
})

describe('exportHapiHubAuthEnv', () => {
    const previousUrl = process.env.HAPI_API_URL
    const previousToken = process.env.CLI_API_TOKEN
    const previousConfigUrl = configuration.apiUrl
    const previousConfigToken = configuration.cliApiToken

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
        configuration._setApiUrl(previousConfigUrl)
        configuration._setCliApiToken(previousConfigToken)
    })

    it('mirrors configured hub URL into process.env for child shells', () => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        configuration._setApiUrl('http://remote-hub:3006')
        configuration._setCliApiToken('runner-token')

        exportHapiHubAuthEnv({ exportApiUrl: true })

        expect(process.env.HAPI_API_URL).toBe('http://remote-hub:3006')
        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })

    it('does not clear an existing CLI_API_TOKEN when exporting URL only', () => {
        process.env.HAPI_API_URL = 'http://already-set:3006'
        process.env.CLI_API_TOKEN = 'already-set-token'
        configuration._setApiUrl('http://config-hub:3006')
        configuration._setCliApiToken('settings-token')

        exportHapiHubAuthEnv({ exportApiUrl: true })

        expect(process.env.HAPI_API_URL).toBe('http://config-hub:3006')
        expect(process.env.CLI_API_TOKEN).toBe('already-set-token')
    })

    it('does not export URL or token when api URL is the implicit default', () => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        configuration._setApiUrl('http://localhost:3006')
        configuration._setCliApiToken('local-token')

        exportHapiHubAuthEnv({ exportApiUrl: false })

        expect(process.env.HAPI_API_URL).toBeUndefined()
        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })

    it('never mirrors settings/prompt tokens into process.env', () => {
        delete process.env.HAPI_API_URL
        delete process.env.CLI_API_TOKEN
        configuration._setApiUrl('http://remote-hub:3006')
        configuration._setCliApiToken('settings-secret')

        exportHapiHubAuthEnv({ exportApiUrl: true })

        expect(process.env.CLI_API_TOKEN).toBeUndefined()
    })
})
