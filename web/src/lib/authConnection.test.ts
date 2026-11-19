import { describe, expect, it } from 'vitest'
import { authConnectionMessage } from './authConnection'

describe('authentication connection diagnostics', () => {
    it('identifies device offline even after an earlier server error', () => {
        expect(authConnectionMessage({ status: 503 }, false)).toBe('Your device is offline. Reconnect to the internet to reach the hub.')
    })
    it('identifies an HTTP server failure without blaming the device', () => {
        expect(authConnectionMessage({ status: 503 }, true)).toContain('hub or its gateway is temporarily unavailable (HTTP 503)')
    })
    it('does not assign a side to a browser fetch failure', () => {
        expect(authConnectionMessage({}, true)).toBe('Cannot reach the hub. Check your connection or the hub\'s availability.')
    })
    it('makes a wrong endpoint diagnosable', () => {
        expect(authConnectionMessage({ status: 404 }, true)).toContain('HTTP 404. Check the hub URL')
    })
})
