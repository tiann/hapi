import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    setSettingsLockMaxAttemptsForTests,
    withSettingsFileLock,
} from './settingsFileLock'

describe('withSettingsFileLock', () => {
    afterEach(() => {
        setSettingsLockMaxAttemptsForTests(undefined)
    })

    test('reclaims a lock whose recorded PID is dead', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-'))
        const settingsFile = join(dir, 'settings.json')
        const lockFile = `${settingsFile}.lock`
        writeFileSync(lockFile, JSON.stringify({ pid: 2_147_483_646, token: 'dead-owner' }))

        const result = await withSettingsFileLock(settingsFile, async () => 'ok')
        expect(result).toBe('ok')
        expect(existsSync(lockFile)).toBe(false)
    })

    test('does not reclaim an ownerless sidecar on sight (publication window)', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-empty-'))
        const settingsFile = join(dir, 'settings.json')
        const lockFile = `${settingsFile}.lock`
        writeFileSync(lockFile, '')
        setSettingsLockMaxAttemptsForTests(3)

        await expect(
            withSettingsFileLock(settingsFile, async () => 'stolen')
        ).rejects.toThrow(/Failed to acquire settings lock/)
        expect(existsSync(lockFile)).toBe(true)
        expect(readFileSync(lockFile, 'utf8')).toBe('')
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

    test('serializes concurrent writers without .tmp collisions', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-race-'))
        const settingsFile = join(dir, 'settings.json')
        writeFileSync(settingsFile, JSON.stringify({ n: 0 }))
        const { writeFile, rename, readFile } = await import('node:fs/promises')

        await Promise.all(
            Array.from({ length: 8 }, (_, i) =>
                withSettingsFileLock(settingsFile, async () => {
                    const current = JSON.parse(await readFile(settingsFile, 'utf8')) as { n: number }
                    const next = { n: current.n + 1, last: i }
                    const tmp = `${settingsFile}.tmp`
                    await writeFile(tmp, JSON.stringify(next))
                    await rename(tmp, settingsFile)
                })
            )
        )

        const saved = JSON.parse(readFileSync(settingsFile, 'utf8')) as { n: number }
        expect(saved.n).toBe(8)
        expect(existsSync(`${settingsFile}.lock`)).toBe(false)
    })
})
