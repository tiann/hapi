import { describe, expect, it } from 'vitest'
import { redactSettingsForDisplay } from './doctor'

describe('redactSettingsForDisplay', () => {
    it('redacts tokens and extra headers from diagnostic output', () => {
        const displaySettings = redactSettingsForDisplay({
            apiUrl: 'https://hapi.example.com',
            cliApiToken: 'cli-secret',
            extraHeaders: {
                'CF-Access-Client-Id': 'client-id',
                'CF-Access-Client-Secret': 'client-secret'
            },
            titleProvider: {
                baseUrl: 'https://provider.example.com/v1',
                apiKey: 'title-provider-secret',
                model: 'small-model'
            }
        })

        expect(displaySettings).toEqual({
            apiUrl: 'https://hapi.example.com',
            cliApiToken: '***',
            extraHeaders: '***',
            titleProvider: {
                baseUrl: 'https://provider.example.com/v1',
                apiKey: '***',
                model: 'small-model'
            }
        })
        expect(JSON.stringify(displaySettings)).not.toContain('cli-secret')
        expect(JSON.stringify(displaySettings)).not.toContain('client-secret')
        expect(JSON.stringify(displaySettings)).not.toContain('title-provider-secret')
    })

    it('redacts malformed title provider settings without exposing unexpected fields', () => {
        const displaySettings = redactSettingsForDisplay({
            titleProvider: {
                baseUrl: 'https://provider.example.com/v1',
                apiKey: 'title-provider-secret',
                model: 'small-model',
                password: 'unexpected-secret'
            }
        })

        expect(displaySettings.titleProvider).toEqual({
            baseUrl: 'https://provider.example.com/v1',
            apiKey: '***',
            model: 'small-model'
        })
        expect(JSON.stringify(displaySettings)).not.toContain('unexpected-secret')
    })

    it('masks non-object title provider settings', () => {
        for (const titleProvider of [null, 'provider-secret', ['provider-secret'], 42]) {
            expect(redactSettingsForDisplay({ titleProvider }).titleProvider).toBe('***')
        }
    })

    it('drops malformed nested title provider fields from diagnostic output', () => {
        const displaySettings = redactSettingsForDisplay({
            titleProvider: {
                baseUrl: { password: 'base-url-secret' },
                apiKey: { value: 'api-key-secret' },
                model: ['model-secret']
            }
        })

        expect(displaySettings.titleProvider).toEqual({
            baseUrl: undefined,
            apiKey: '***',
            model: undefined
        })
        expect(JSON.stringify(displaySettings)).not.toContain('base-url-secret')
        expect(JSON.stringify(displaySettings)).not.toContain('api-key-secret')
        expect(JSON.stringify(displaySettings)).not.toContain('model-secret')
    })
})
