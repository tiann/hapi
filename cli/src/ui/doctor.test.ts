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

    it('redacts the QQ app secret without mutating the stored settings', () => {
        const qqBot = { enabled: true, appId: '12345', appSecret: 'fake-qq-app-secret' }
        const settings = { qqBot }
        const displaySettings = redactSettingsForDisplay(settings)

        expect(displaySettings).toEqual({ qqBot: { ...qqBot, appSecret: '***' } })
        expect(JSON.stringify(displaySettings)).not.toContain('fake-qq-app-secret')
        expect(settings.qqBot.appSecret).toBe('fake-qq-app-secret')
    })

    it('preserves QQ settings without an app secret', () => {
        const qqBot = { enabled: false, appId: '12345' }
        expect(redactSettingsForDisplay({ qqBot }).qqBot).toEqual(qqBot)
    })
})
