import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    readSessionSummaryContractEnabled,
    writeSessionSummaryContractEnabled
} from './sessionSummaryContract'
import { getSettingsFile, updateSettings, writeSettings } from './settings'

const directories: string[] = []

afterEach(async () => {
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

describe('sessionSummaryContract setting', () => {
    it('defaults to off when settings.json is missing or unset', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-ssc-'))
        directories.push(dataDir)
        expect(await readSessionSummaryContractEnabled(dataDir)).toBe(false)

        await writeSettings(getSettingsFile(dataDir), { listenPort: 3006 })
        expect(await readSessionSummaryContractEnabled(dataDir)).toBe(false)
    })

    it('persists true across reads', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-ssc-'))
        directories.push(dataDir)
        expect(await writeSessionSummaryContractEnabled(dataDir, true)).toBe(true)
        expect(await readSessionSummaryContractEnabled(dataDir)).toBe(true)

        const raw = JSON.parse(await readFile(getSettingsFile(dataDir), 'utf8')) as {
            sessionSummaryContract?: boolean
        }
        expect(raw.sessionSummaryContract).toBe(true)

        await writeSessionSummaryContractEnabled(dataDir, false)
        expect(await readSessionSummaryContractEnabled(dataDir)).toBe(false)
    })

    it('serializes concurrent writers without clobbering unrelated fields', async () => {
        const dataDir = await mkdtemp(join(tmpdir(), 'hapi-ssc-race-'))
        directories.push(dataDir)
        const settingsFile = getSettingsFile(dataDir)
        await writeSettings(settingsFile, {
            cliApiToken: 'keep-me',
            machineId: 'machine-1',
            relayAuthKey: 'relay-keep',
            listenPort: 3006
        })

        const results = await Promise.all([
            writeSessionSummaryContractEnabled(dataDir, true),
            updateSettings(settingsFile, (current) => ({
                settings: {
                    ...current,
                    publicUrl: 'https://example.test'
                },
                result: undefined
            })),
            writeSessionSummaryContractEnabled(dataDir, true)
        ])

        expect(results[0]).toBe(true)
        expect(results[2]).toBe(true)

        const raw = JSON.parse(await readFile(settingsFile, 'utf8')) as {
            cliApiToken?: string
            machineId?: string
            relayAuthKey?: string
            listenPort?: number
            publicUrl?: string
            sessionSummaryContract?: boolean
        }
        expect(raw.cliApiToken).toBe('keep-me')
        expect(raw.machineId).toBe('machine-1')
        expect(raw.relayAuthKey).toBe('relay-keep')
        expect(raw.listenPort).toBe(3006)
        expect(raw.publicUrl).toBe('https://example.test')
        expect(raw.sessionSummaryContract).toBe(true)
        expect(await readSessionSummaryContractEnabled(dataDir)).toBe(true)
    })
})
