import { afterEach, beforeEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { loadServerSettings } from './serverSettings'

function makeTempDir(): string {
    return mkdtempSync(join(tmpdir(), 'hapi-server-settings-test-'))
}

describe('loadServerSettings', () => {
    let dir: string | null = null
    const originalBackgroundOnly = process.env.SERVERCHAN_BACKGROUND_ONLY

    beforeEach(() => {
        delete process.env.SERVERCHAN_BACKGROUND_ONLY
    })

    afterEach(() => {
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
        if (originalBackgroundOnly === undefined) {
            delete process.env.SERVERCHAN_BACKGROUND_ONLY
        } else {
            process.env.SERVERCHAN_BACKGROUND_ONLY = originalBackgroundOnly
        }
    })

    it('rejects old webapp settings fields instead of migrating them', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            webappHost: '0.0.0.0',
            webappPort: 3007,
            webappUrl: 'http://localhost:3007',
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('Unsupported old settings field')
    })

    it('persists Android push mode and honors env over file without replacing the file value', async () => {
        dir = makeTempDir()
        const original = process.env.HAPI_ANDROID_PUSH
        try {
            process.env.HAPI_ANDROID_PUSH = 'relay'
            expect((await loadServerSettings(dir)).settings.androidPushMode).toBe('relay')
            expect(JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8')).androidPushMode).toBe('relay')
            process.env.HAPI_ANDROID_PUSH = 'off'
            const overridden = await loadServerSettings(dir)
            expect(overridden.settings.androidPushMode).toBe('off')
            expect(overridden.sources.androidPushMode).toBe('env')
            delete process.env.HAPI_ANDROID_PUSH
            const restored = await loadServerSettings(dir)
            expect(restored.settings.androidPushMode).toBe('relay')
            expect(restored.sources.androidPushMode).toBe('file')
        } finally {
            if (original === undefined) delete process.env.HAPI_ANDROID_PUSH
            else process.env.HAPI_ANDROID_PUSH = original
        }
    })

    it('defaults ServerChan background-only mode to disabled', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(false)
        expect(result.sources.serverChanBackgroundOnly).toBe('default')
    })

    it('loads ServerChan background-only mode from settings.json', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: true
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(true)
        expect(result.sources.serverChanBackgroundOnly).toBe('file')
    })

    it('loads ServerChan background-only mode with environment precedence', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: false
        }))
        process.env.SERVERCHAN_BACKGROUND_ONLY = 'true'

        const result = await loadServerSettings(dir)

        expect(result.settings.serverChanBackgroundOnly).toBe(true)
        expect(result.sources.serverChanBackgroundOnly).toBe('env')
    })

    it('rejects a non-boolean ServerChan background-only setting', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            serverChanBackgroundOnly: 'false'
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('serverChanBackgroundOnly must be a boolean')
    })

    it('defaults push settings to null', async () => {
        dir = makeTempDir()

        const result = await loadServerSettings(dir)

        expect(result.settings.fcmServiceAccountPath).toBeNull()
        expect(result.settings.iosPushMode).toBeNull()
        expect(result.sources.fcmServiceAccountPath).toBe('default')
    })

    it('persists a push env value to settings.json on first sight', async () => {
        dir = makeTempDir()
        process.env.FCM_SERVICE_ACCOUNT_PATH = '/tmp/sa.json'
        try {
            const result = await loadServerSettings(dir)

            expect(result.settings.fcmServiceAccountPath).toBe('/tmp/sa.json')
            expect(result.sources.fcmServiceAccountPath).toBe('env')
            expect(result.savedToFile).toBe(true)

            const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
            expect(written.fcmServiceAccountPath).toBe('/tmp/sa.json')
        } finally {
            delete process.env.FCM_SERVICE_ACCOUNT_PATH
        }
    })

    it('loads push settings from settings.json when the env is unset', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            fcmServiceAccountPath: '~/.hapi/sa.json',
            iosPushMode: 'off'
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.fcmServiceAccountPath).toBe('~/.hapi/sa.json')
        expect(result.sources.fcmServiceAccountPath).toBe('file')
        expect(result.settings.iosPushMode).toBe('off')
        expect(result.sources.iosPushMode).toBe('file')
    })
})

function captureWarnings(): { warnings: string[]; restore: () => void } {
    const warnings: string[] = []
    const original = console.warn
    console.warn = (...args: unknown[]) => {
        warnings.push(args.map((value) => String(value)).join(' '))
    }
    return {
        warnings,
        restore: () => {
            console.warn = original
        }
    }
}

function restoreEnv(name: string, value: string | undefined): void {
    if (value === undefined) {
        delete process.env[name]
    } else {
        process.env[name] = value
    }
}

describe('loadServerSettings public URL and CORS origins', () => {
    let dir: string | null = null
    let capture: { warnings: string[]; restore: () => void } | null = null
    const originalPublicUrl = process.env.HAPI_PUBLIC_URL
    const originalCorsOrigins = process.env.CORS_ORIGINS

    beforeEach(() => {
        delete process.env.HAPI_PUBLIC_URL
        delete process.env.CORS_ORIGINS
        capture = captureWarnings()
    })

    afterEach(() => {
        capture?.restore()
        capture = null
        if (dir) {
            rmSync(dir, { recursive: true, force: true })
            dir = null
        }
        restoreEnv('HAPI_PUBLIC_URL', originalPublicUrl)
        restoreEnv('CORS_ORIGINS', originalCorsOrigins)
    })

    it('repairs a scheme-less publicUrl, warns and persists the fix', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ publicUrl: 'hapi.example.com' }))

        const result = await loadServerSettings(dir)

        expect(result.settings.publicUrl).toBe('https://hapi.example.com')
        expect(result.sources.publicUrl).toBe('file')
        expect(result.savedToFile).toBe(true)
        expect(capture!.warnings.join('\n')).toContain('missing a scheme')

        const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
        expect(written.publicUrl).toBe('https://hapi.example.com')
    })

    it('rejects a publicUrl that cannot be a hub URL', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ publicUrl: 'not a url' }))

        await expect(loadServerSettings(dir)).rejects.toThrow('Invalid publicUrl')
    })

    it('rejects a publicUrl with embedded credentials', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            publicUrl: 'https://user:pass@hapi.example.com'
        }))

        await expect(loadServerSettings(dir)).rejects.toThrow('Invalid publicUrl')
    })

    it('normalizes the path of a stored publicUrl without claiming a missing scheme', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ publicUrl: 'https://hapi.example.com/base/' }))

        const result = await loadServerSettings(dir)

        expect(result.settings.publicUrl).toBe('https://hapi.example.com/base')
        expect(result.savedToFile).toBe(true)
        expect(capture!.warnings.join('\n')).toContain('was normalized to')
        expect(capture!.warnings.join('\n')).not.toContain('missing a scheme')
    })

    it('derives the CORS allowlist from the normalized publicUrl without persisting it', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({ publicUrl: 'hapi.example.com' }))

        const result = await loadServerSettings(dir)

        expect(result.settings.corsOrigins).toEqual(['https://hapi.example.com'])
        expect(result.sources.corsOrigins).toBe('default')

        const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
        expect(written.corsOrigins).toBeUndefined()
    })

    it('normalizes CORS_ORIGINS entries and drops unusable ones', async () => {
        dir = makeTempDir()
        process.env.CORS_ORIGINS = 'https://app.example.com, hub-b.example.com, not a url'

        const result = await loadServerSettings(dir)

        expect(result.settings.corsOrigins).toEqual(['https://app.example.com', 'https://hub-b.example.com'])
        expect(result.sources.corsOrigins).toBe('env')
        expect(capture!.warnings.join('\n')).toContain('Ignoring invalid CORS origin "not a url"')
        expect(capture!.warnings.join('\n')).toContain(
            'CORS origin "hub-b.example.com" was normalized to "https://hub-b.example.com"'
        )

        const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
        expect(written.corsOrigins).toEqual(['https://app.example.com', 'https://hub-b.example.com'])
    })

    it('treats the opaque null CORS origin as unusable', async () => {
        dir = makeTempDir()
        process.env.CORS_ORIGINS = 'null'

        const result = await loadServerSettings(dir)

        expect(result.settings.corsOrigins).toEqual([])
        expect(result.sources.corsOrigins).toBe('env')
        expect(capture!.warnings.join('\n')).toContain('Ignoring invalid CORS origin "null"')
    })

    it('drops invalid stored CORS origins and rewrites the file', async () => {
        dir = makeTempDir()
        writeFileSync(join(dir, 'settings.json'), JSON.stringify({
            publicUrl: 'https://hapi.example.com',
            corsOrigins: ['https://app.example.com/', 'ftp://other.example.com']
        }))

        const result = await loadServerSettings(dir)

        expect(result.settings.corsOrigins).toEqual(['https://app.example.com'])
        expect(result.sources.corsOrigins).toBe('file')
        expect(result.savedToFile).toBe(true)

        const written = JSON.parse(readFileSync(join(dir, 'settings.json'), 'utf8'))
        expect(written.corsOrigins).toEqual(['https://app.example.com'])
    })

    it('keeps the wildcard short-circuit for CORS origins', async () => {
        dir = makeTempDir()
        process.env.CORS_ORIGINS = '*,https://app.example.com'

        const result = await loadServerSettings(dir)

        expect(result.settings.corsOrigins).toEqual(['*'])
        expect(capture!.warnings.join('\n')).not.toContain('Ignoring invalid CORS origin')
    })
})
