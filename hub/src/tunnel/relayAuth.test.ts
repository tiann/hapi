import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { refreshRejectedRelayAuthKey, resolveRelayAuthKey } from './relayAuth'

function makeSettingsFile(): { dir: string; file: string } {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-relay-auth-test-'))
    return { dir, file: join(dir, 'settings.json') }
}

describe('relay auth recovery', () => {
    const originalEnvKey = process.env.HAPI_RELAY_AUTH
    const tempDirs: string[] = []

    afterEach(() => {
        if (originalEnvKey === undefined) {
            delete process.env.HAPI_RELAY_AUTH
        } else {
            process.env.HAPI_RELAY_AUTH = originalEnvKey
        }
        for (const dir of tempDirs.splice(0)) {
            rmSync(dir, { recursive: true, force: true })
        }
    })

    it('replaces a rejected persisted key', async () => {
        delete process.env.HAPI_RELAY_AUTH
        const { dir, file } = makeSettingsFile()
        tempDirs.push(dir)
        writeFileSync(file, JSON.stringify({ relayAuthKey: 'rejected-key', listenPort: 3000 }))

        const key = await refreshRejectedRelayAuthKey(
            'relay.example.com',
            file,
            'rejected-key',
            async () => Response.json({ key: 'replacement-key' })
        )

        expect(key).toBe('replacement-key')
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
            relayAuthKey: 'replacement-key',
            listenPort: 3000
        })
    })

    it('does not overwrite an explicitly configured rejected key', async () => {
        process.env.HAPI_RELAY_AUTH = 'env-key'
        const { dir, file } = makeSettingsFile()
        tempDirs.push(dir)

        await expect(refreshRejectedRelayAuthKey(
            'relay.example.com',
            file,
            'env-key',
            async () => Response.json({ key: 'replacement-key' })
        )).rejects.toThrow('Update or unset the environment variable')
    })

    it('explains shared-IP issuance limits and discards the rejected key', async () => {
        delete process.env.HAPI_RELAY_AUTH
        const { dir, file } = makeSettingsFile()
        tempDirs.push(dir)
        writeFileSync(file, JSON.stringify({ relayAuthKey: 'rejected-key' }))

        const error = refreshRejectedRelayAuthKey(
            'relay.example.com',
            file,
            'rejected-key',
            async () => new Response(null, { status: 429, headers: { 'Retry-After': '3600' } })
        )
        await expect(error).rejects.toThrow('limits issuance per public IP')
        await expect(error).rejects.toThrow('Retry after 3600 seconds')
        expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({})
    })

    it('reports a clear 429 error during initial resolution', async () => {
        delete process.env.HAPI_RELAY_AUTH
        const { dir, file } = makeSettingsFile()
        tempDirs.push(dir)

        await expect(resolveRelayAuthKey(
            'relay.example.com',
            file,
            async () => new Response(null, { status: 429 })
        )).rejects.toThrow('Configure HAPI_RELAY_AUTH')
    })
})
