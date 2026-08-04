import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    readSessionSummaryContractEnabled,
    writeSessionSummaryContractEnabled
} from './sessionSummaryContract'
import { getSettingsFile, writeSettings } from './settings'

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
})
