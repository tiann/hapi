import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { withSettingsFileLock } from './settingsFileLock'

describe('withSettingsFileLock', () => {
    test('reclaims a lock whose recorded PID is dead', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-'))
        const settingsFile = join(dir, 'settings.json')
        const lockFile = `${settingsFile}.lock`
        writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_646, token: 'dead-owner' }))

        const result = await withSettingsFileLock(settingsFile, async () => 'ok')
        expect(result).toBe('ok')
        expect(existsSync(lockFile)).toBe(false)
    })

    test('reclaims legacy empty lock files without owner payload', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-legacy-'))
        const settingsFile = join(dir, 'settings.json')
        const lockFile = `${settingsFile}.lock`
        writeFileSync(lockFile, '')

        const result = await withSettingsFileLock(settingsFile, async () => 'legacy-ok')
        expect(result).toBe('legacy-ok')
        expect(existsSync(lockFile)).toBe(false)
    })

    test('does not unlink a successor lock on release', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-succ-'))
        const settingsFile = join(dir, 'settings.json')
        const lockFile = `${settingsFile}.lock`

        let releaseFirst!: () => void
        const firstHeld = new Promise<void>((resolve) => {
            releaseFirst = resolve
        })

        const first = withSettingsFileLock(settingsFile, async () => {
            // Token-gated release must leave a successor's lock file alone.
            writeFileSync(lockFile, JSON.stringify({ pid: process.pid, token: 'successor' }))
            await firstHeld
            return 'first'
        })

        await new Promise((r) => setTimeout(r, 20))
        releaseFirst()
        await expect(first).resolves.toBe('first')

        const leftover = readFileSync(lockFile, 'utf8')
        expect(JSON.parse(leftover)).toEqual({ pid: process.pid, token: 'successor' })
    })
})
