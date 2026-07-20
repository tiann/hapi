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
            }
        })

        expect(displaySettings).toEqual({
            apiUrl: 'https://hapi.example.com',
            cliApiToken: '***',
            extraHeaders: '***'
        })
        expect(JSON.stringify(displaySettings)).not.toContain('cli-secret')
        expect(JSON.stringify(displaySettings)).not.toContain('client-secret')
    })
})
