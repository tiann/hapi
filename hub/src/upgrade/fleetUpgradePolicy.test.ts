import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
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
    it('defaults to alert when nothing is persisted', () => {
        initFleetUpgradePolicy({ dataDir: makeDataDir(), persisted: undefined })
        expect(getFleetUpgradePolicy()).toBe('alert')
    })

    it('seeds from a valid persisted value and ignores garbage', () => {
        initFleetUpgradePolicy({ dataDir: makeDataDir(), persisted: 'auto' })
        expect(getFleetUpgradePolicy()).toBe('auto')

        initFleetUpgradePolicy({ dataDir: makeDataDir(), persisted: 'nonsense' })
        expect(getFleetUpgradePolicy()).toBe('alert')
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

    it('refuses to overwrite a malformed settings.json', async () => {
        const dataDir = makeDataDir()
        const file = getSettingsFile(dataDir)
        writeFileSync(file, '{not-json')
        initFleetUpgradePolicy({ dataDir, persisted: 'alert' })

        await expect(setFleetUpgradePolicy('silent')).rejects.toThrow(/Cannot read/)
        expect(getFleetUpgradePolicy()).toBe('alert')
        expect(readFileSync(file, 'utf8')).toBe('{not-json')
    })

    it('serializes overlapping policy writes so the last request wins', async () => {
        const dataDir = makeDataDir()
        initFleetUpgradePolicy({ dataDir, persisted: 'alert' })
        // Seed a settings file with an unrelated field that must survive RMW races.
        const file = getSettingsFile(dataDir)
        writeFileSync(file, `${JSON.stringify({ cliApiToken: 'keep-me', fleetUpgradePolicy: 'alert' }, null, 2)}\n`)

        await Promise.all([
            setFleetUpgradePolicy('silent'),
            setFleetUpgradePolicy('auto'),
            setFleetUpgradePolicy('alert'),
            setFleetUpgradePolicy('silent'),
        ])
        expect(getFleetUpgradePolicy()).toBe('silent')
        const persisted = await readSettings(file)
        expect(persisted?.fleetUpgradePolicy).toBe('silent')
        expect(persisted?.cliApiToken).toBe('keep-me')
        // File must remain valid JSON (no half-written tmp clobber).
        expect(() => JSON.parse(readFileSync(file, 'utf8'))).not.toThrow()
    })
})
