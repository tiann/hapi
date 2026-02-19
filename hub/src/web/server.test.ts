import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll } from 'bun:test'
import { createWebApp } from './server'
import { Store } from '../store'
import { rmSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { createConfiguration } from '../configuration'

describe('Web Server Security Headers', () => {
    let store: Store
    const testDir = join(process.cwd(), 'test-data-' + Date.now())
    const dbPath = join(testDir, 'test-security-headers.db')

    beforeAll(async () => {
        mkdirSync(testDir, { recursive: true })
        process.env.HAPI_HOME = testDir
        // Initialize configuration
        await createConfiguration()
    })

    afterAll(() => {
        try {
            rmSync(testDir, { recursive: true, force: true })
        } catch {
            // ignore
        }
    })

    beforeEach(() => {
        store = new Store(dbPath)
    })

    it('should have security headers on /health endpoint', async () => {
        const app = createWebApp({
            getSyncEngine: () => null,
            getSseManager: () => null,
            getVisibilityTracker: () => null,
            jwtSecret: new Uint8Array([1, 2, 3]),
            store: store,
            vapidPublicKey: 'test-key',
            embeddedAssetMap: null,
            corsOrigins: ['*'] // Provide corsOrigins explicitly to avoid config dependency if possible, but createWebApp uses config as fallback
        })

        const res = await app.request('/health')
        expect(res.status).toBe(200)

        const headers = res.headers

        // Check for missing headers (fail if missing)
        expect(headers.get('X-Frame-Options')).toBe('SAMEORIGIN')
        expect(headers.get('X-Content-Type-Options')).toBe('nosniff')
        expect(headers.get('Referrer-Policy')).toBe('no-referrer')
        expect(headers.get('Strict-Transport-Security')).toBe('max-age=15552000; includeSubDomains')
        expect(headers.get('X-XSS-Protection')).toBe('0')
    })
})
