import { describe, expect, it } from 'bun:test'
import { requireWebhookHttpUrl } from './url'

describe('requireWebhookHttpUrl', () => {
    it('accepts http and https URLs', () => {
        expect(requireWebhookHttpUrl(' https://example.com/hook ')).toBe('https://example.com/hook')
        expect(requireWebhookHttpUrl('http://127.0.0.1:8080/hook')).toBe('http://127.0.0.1:8080/hook')
    })

    it('rejects non-http URLs without echoing the value', () => {
        expect(() => requireWebhookHttpUrl('ftp://example.com/hook', 'HAPI_WEBHOOK_URL'))
            .toThrow('HAPI_WEBHOOK_URL must be a valid http(s) URL')
        expect(() => requireWebhookHttpUrl('not-a-url')).toThrow('Webhook URL must be a valid http(s) URL')
        try {
            requireWebhookHttpUrl('ftp://secret.example/hook')
        } catch (error) {
            expect(String(error)).not.toContain('secret.example')
        }
    })
})
