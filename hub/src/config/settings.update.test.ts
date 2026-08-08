import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    getSettingsFile,
    readSettings,
    resetSettingsWriteQueueForTests,
    updateSettingsFile,
} from './settings'

describe('updateSettingsFile', () => {
    let dataDir: string

    beforeEach(() => {
        resetSettingsWriteQueueForTests()
        dataDir = mkdtempSync(join(tmpdir(), 'hapi-settings-queue-'))
    })

    afterEach(() => {
        resetSettingsWriteQueueForTests()
        rmSync(dataDir, { recursive: true, force: true })
    })

    it('serializes concurrent writers so both fields survive', async () => {
        const file = getSettingsFile(dataDir)
        writeFileSync(file, JSON.stringify({ listenPort: 3000 }))

        await Promise.all([
            updateSettingsFile(file, (settings) => {
                settings.relayAuthKey = 'relay-key'
            }),
            updateSettingsFile(file, (settings) => {
                settings.fleetUpgradePolicy = 'auto'
            }),
        ])

        const persisted = await readSettings(file)
        expect(persisted?.relayAuthKey).toBe('relay-key')
        expect(persisted?.fleetUpgradePolicy).toBe('auto')
        expect(persisted?.listenPort).toBe(3000)
        // No leftover temp file after the queued renames.
        expect(() => readFileSync(`${file}.tmp`)).toThrow()
    })

    it('releases the shared settings.lock after a queued write', async () => {
        const file = getSettingsFile(dataDir)
        writeFileSync(file, JSON.stringify({ listenPort: 3000 }))
        await updateSettingsFile(file, (settings) => {
            settings.fleetUpgradePolicy = 'alert'
        })
        expect(() => readFileSync(`${file}.lock`)).toThrow()
        expect((await readSettings(file))?.fleetUpgradePolicy).toBe('alert')
    })
})
