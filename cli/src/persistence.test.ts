import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const dir = mkdtempSync(join(tmpdir(), 'hapi-cli-settings-'))

vi.mock('@/configuration', () => ({
    configuration: {
        happyHomeDir: dir,
        settingsFile: join(dir, 'settings.json'),
        privateKeyFile: join(dir, 'access.key'),
        runnerStateFile: join(dir, 'runner.state.json'),
        runnerLockFile: join(dir, 'runner.state.json.lock'),
        logsDir: join(dir, 'logs'),
    },
}))

import { updateSettings } from './persistence'

describe('updateSettings', () => {
    afterEach(() => {
        try {
            rmSync(dir, { recursive: true, force: true })
        } catch {
            // ignore
        }
    })

    it('rejects corrupt settings.json and leaves the original bytes intact', async () => {
        const settingsFile = join(dir, 'settings.json')
        const original = '{"providerCredentials":{"OPENAI_API_KEY":"keep-me"},"relayAuthKey":"relay"}'
        writeFileSync(settingsFile, original)

        // Overwrite with invalid JSON after the mock dir exists
        writeFileSync(settingsFile, '{not-json')

        await expect(
            updateSettings((current) => ({ ...current, apiUrl: 'http://should-not-write' }))
        ).rejects.toThrow()

        expect(readFileSync(settingsFile, 'utf8')).toBe('{not-json')
    })
})
