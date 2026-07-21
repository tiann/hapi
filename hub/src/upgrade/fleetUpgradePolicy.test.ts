import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getSettingsFile, readSettings } from '../config/settings'
import {
    getFleetUpgradePolicy,
    initFleetUpgradePolicy,
    resetFleetUpgradePolicyForTests,
    setFleetUpgradePolicy,
} from './fleetUpgradePolicy'

const tmpDirs: string[] = []

function makeDataDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'hapi-policy-'))
    tmpDirs.push(dir)
    return dir
}

afterEach(() => {
    resetFleetUpgradePolicyForTests()
    for (const dir of tmpDirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true })
    }
})

describe('fleetUpgradePolicy', () => {
    it('defaults to auto when nothing is persisted', () => {
        initFleetUpgradePolicy({ dataDir: makeDataDir(), persisted: undefined })
        expect(getFleetUpgradePolicy()).toBe('auto')
    })

    it('seeds from a valid persisted value and ignores garbage', () => {
        initFleetUpgradePolicy({ dataDir: makeDataDir(), persisted: 'alert' })
        expect(getFleetUpgradePolicy()).toBe('alert')

        initFleetUpgradePolicy({ dataDir: makeDataDir(), persisted: 'nonsense' })
        expect(getFleetUpgradePolicy()).toBe('auto')
    })

    it('persists updates to settings.json and survives re-init', async () => {
        const dataDir = makeDataDir()
        initFleetUpgradePolicy({ dataDir, persisted: undefined })

        await setFleetUpgradePolicy('silent')
        expect(getFleetUpgradePolicy()).toBe('silent')

        const persisted = await readSettings(getSettingsFile(dataDir))
        expect(persisted?.fleetUpgradePolicy).toBe('silent')

        // Simulate a hub restart reading the file back.
        resetFleetUpgradePolicyForTests()
        initFleetUpgradePolicy({ dataDir, persisted: persisted?.fleetUpgradePolicy })
        expect(getFleetUpgradePolicy()).toBe('silent')
    })
})
