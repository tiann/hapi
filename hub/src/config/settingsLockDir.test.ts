import { describe, expect, it } from 'bun:test'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsFile, withSettingsLock } from './settings'

describe('withSettingsLock on a fresh data dir', () => {
    it('creates the parent before taking the lock', async () => {
        // The cross-process lock is a `mkdir` next to the settings file, but
        // the directory was only created inside `writeSettingsUnlocked` — i.e.
        // inside the lock. On a data dir that did not exist yet the lock's own
        // mkdir failed with ENOENT and retried the full attempt budget
        // (50 x 100ms), surfacing as an unnamed ~5s test failure.
        const base = mkdtempSync(join(tmpdir(), 'hapi-settings-lock-'))
        const settingsFile = getSettingsFile(join(base, 'never-created'))

        const started = Date.now()
        await expect(withSettingsLock(settingsFile, async () => 'held')).resolves.toBe('held')
        // Also guards the symptom: a retry storm would blow past this.
        expect(Date.now() - started).toBeLessThan(2_000)
    })
})
