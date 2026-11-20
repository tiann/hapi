import { describe, expect, test, afterEach } from 'bun:test'
import { mkdtempSync, writeFileSync, existsSync, readFileSync, mkdirSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    setSettingsLockMaxAttemptsForTests,
    setSettingsLockStaleMsForTests,
    withSettingsFileLock,
} from './settingsFileLock'

describe('withSettingsFileLock', () => {
    afterEach(() => {
        setSettingsLockMaxAttemptsForTests(undefined)
        setSettingsLockStaleMsForTests(undefined)
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
        expect(existsSync(`${settingsFile}.hapi.lock`)).toBe(false)
    })

    test('reclaims a stale lock left by a crashed holder', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-stale-'))
        const settingsFile = join(dir, 'settings.json')
        writeFileSync(settingsFile, JSON.stringify({ ok: true }))
        const lockDir = `${settingsFile}.hapi.lock`
        mkdirSync(lockDir)
        // proper-lockfile treats mtime older than `stale` as reclaimable.
        setSettingsLockStaleMsForTests(5_000)
        const past = new Date(Date.now() - 60_000)
        const { utimesSync } = await import('node:fs')
        utimesSync(lockDir, past, past)

        const result = await withSettingsFileLock(settingsFile, async () => 'recovered')
        expect(result).toBe('recovered')
        expect(existsSync(lockDir)).toBe(false)
    })

    test('does not allow overlapping critical sections', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-excl-'))
        const settingsFile = join(dir, 'settings.json')
        writeFileSync(settingsFile, '{}')

        let inCritical = 0
        let maxInCritical = 0
        const bump = async () => {
            inCritical++
            maxInCritical = Math.max(maxInCritical, inCritical)
            await new Promise((r) => setTimeout(r, 40))
            inCritical--
            return 'ok'
        }

        const results = await Promise.all([
            withSettingsFileLock(settingsFile, bump),
            withSettingsFileLock(settingsFile, bump),
            withSettingsFileLock(settingsFile, bump),
        ])
        expect(results).toEqual(['ok', 'ok', 'ok'])
        expect(maxInCritical).toBe(1)
    })

    test('creates the lock parent when the settings home does not exist yet', async () => {
        // proper-lockfile mkdirs the lockfile path non-recursively, so a missing
        // parent used to surface as `ENOENT ... mkdir '<dir>/settings.json.hapi.lock'`
        // — an error naming the lock instead of the absent home. Hit in production
        // on first run into a fresh HAPI_HOME, and in hub/src/web/routes/cli.test.ts
        // beforeAll against a temp home it had not created.
        const fresh = join(tmpdir(), `hapi-lock-fresh-${Math.random().toString(36).slice(2)}`)
        const settingsFile = join(fresh, 'settings.json')
        expect(existsSync(fresh)).toBe(false)
        await expect(withSettingsFileLock(settingsFile, async () => 'ok')).resolves.toBe('ok')
        expect(existsSync(fresh)).toBe(true)
        // Owner-only from creation (matches hub settings writer); resists umask 0002.
        expect(statSync(fresh).mode & 0o777).toBe(0o700)
        rmSync(fresh, { recursive: true, force: true })
    })
})
