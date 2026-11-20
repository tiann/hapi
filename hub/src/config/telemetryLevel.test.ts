import { afterEach, describe, expect, it } from 'bun:test'
import { mkdtemp, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    maybeFallbackTelemetryLevel,
    readTelemetryLevelState,
    resolveTelemetryLevel,
    parseTelemetryLevel,
    writeTelemetryLevel,
    TELEMETRY_LEVEL_L3_FALLBACK_MS
} from './telemetryLevel'
import { getSettingsFile, __resetSettingsReadCacheForTests } from './settings'

const HOUR = 3_600_000
const directories: string[] = []

afterEach(async () => {
    delete process.env.HAPI_TELEMETRY_LEVEL
    __resetSettingsReadCacheForTests()
    await Promise.all(directories.splice(0).map((path) => rm(path, { recursive: true, force: true })))
})

async function newDataDir(settings?: Record<string, unknown>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'hapi-telemetry-level-'))
    directories.push(dir)
    if (settings) {
        await writeFile(getSettingsFile(dir), JSON.stringify(settings))
        __resetSettingsReadCacheForTests()
    }
    return dir
}

describe('parseTelemetryLevel / resolveTelemetryLevel', () => {
    it('parses env values and rejects junk', () => {
        expect(parseTelemetryLevel('0')).toBe(0)
        expect(parseTelemetryLevel('3')).toBe(3)
        expect(parseTelemetryLevel(undefined)).toBeNull()
        expect(parseTelemetryLevel('')).toBeNull()
        expect(parseTelemetryLevel('4')).toBeNull()
        expect(parseTelemetryLevel('yes')).toBeNull()
    })

    it('resolves env > file > default(0, opt-in developer mode)', () => {
        expect(resolveTelemetryLevel({ telemetryLevel: 2 }, null)).toEqual({ level: 2, source: 'file' })
        expect(resolveTelemetryLevel({ telemetryLevel: 2 }, 3)).toEqual({ level: 3, source: 'env' })
        expect(resolveTelemetryLevel({}, null)).toEqual({ level: 0, source: 'default' })
        expect(resolveTelemetryLevel({ telemetryLevel: 9 as unknown as 2 }, null)).toEqual({ level: 0, source: 'default' })
    })
})

describe('readTelemetryLevelState', () => {
    it('hard-overrides from the env when present', async () => {
        process.env.HAPI_TELEMETRY_LEVEL = '2'
        const dir = await newDataDir({ telemetryLevel: 3 })
        expect(await readTelemetryLevelState(dir)).toEqual({ level: 2, source: 'env' })
    })

    it('reads the persisted value otherwise', async () => {
        const dir = await newDataDir({ telemetryLevel: 0 })
        expect(await readTelemetryLevelState(dir)).toEqual({ level: 0, source: 'file' })
    })

    it('defaults to 0 (off) on a fresh data dir — sharing is opt-in only', async () => {
        const dir = await newDataDir()
        expect(await readTelemetryLevelState(dir)).toEqual({ level: 0, source: 'default' })
    })
})

describe('writeTelemetryLevel', () => {
    it('persists the level with a change timestamp', async () => {
        const dir = await newDataDir()
        const state = await writeTelemetryLevel(dir, 3)
        expect(state).toEqual({ level: 3, source: 'file' })
        const raw = JSON.parse(await readFile(getSettingsFile(dir), 'utf8')) as {
            telemetryLevel?: number
            telemetryLevelChangedAt?: number
        }
        expect(raw.telemetryLevel).toBe(3)
        expect(typeof raw.telemetryLevelChangedAt).toBe('number')
    })
})

describe('maybeFallbackTelemetryLevel (24h L3 auto-fallback)', () => {
    it('falls back to 0 (off) once the change is older than 24h', async () => {
        const now = Date.now()
        const dir = await newDataDir({ telemetryLevel: 3, telemetryLevelChangedAt: now - 25 * HOUR })
        expect(await maybeFallbackTelemetryLevel(dir, now)).toBe(true)
        expect(await readTelemetryLevelState(dir)).toEqual({ level: 0, source: 'file' })
    })

    it('keeps a fresh L3 but falls back exactly at the 24h boundary (>= semantics)', async () => {
        const now = Date.now()
        const fresh = await newDataDir({ telemetryLevel: 3, telemetryLevelChangedAt: now - 23 * HOUR })
        expect(await maybeFallbackTelemetryLevel(fresh, now)).toBe(false)
        expect(await readTelemetryLevelState(fresh)).toEqual({ level: 3, source: 'file' })

        const boundary = await newDataDir({
            telemetryLevel: 3,
            telemetryLevelChangedAt: now - TELEMETRY_LEVEL_L3_FALLBACK_MS
        })
        expect(await maybeFallbackTelemetryLevel(boundary, now)).toBe(true)
    })

    it('never fights an env pin', async () => {
        process.env.HAPI_TELEMETRY_LEVEL = '3'
        const now = Date.now()
        const dir = await newDataDir({ telemetryLevel: 3, telemetryLevelChangedAt: now - 48 * HOUR })
        expect(await maybeFallbackTelemetryLevel(dir, now)).toBe(false)
        const raw = JSON.parse(await readFile(getSettingsFile(dir), 'utf8')) as { telemetryLevel?: number }
        expect(raw.telemetryLevel).toBe(3)
    })

    it('stamps a missing timestamp instead of insta-dropping a hand-pinned L3', async () => {
        const now = Date.now()
        const dir = await newDataDir({ telemetryLevel: 3 })
        expect(await maybeFallbackTelemetryLevel(dir, now)).toBe(false)
        const stamped = JSON.parse(await readFile(getSettingsFile(dir), 'utf8')) as {
            telemetryLevel?: number
            telemetryLevelChangedAt?: number
        }
        expect(stamped.telemetryLevel).toBe(3)
        expect(stamped.telemetryLevelChangedAt).toBe(now)
        // 24h later it does fall back.
        expect(await maybeFallbackTelemetryLevel(dir, now + 25 * HOUR)).toBe(true)
    })

    it('ignores non-L3 levels', async () => {
        const now = Date.now()
        const dir = await newDataDir({ telemetryLevel: 2, telemetryLevelChangedAt: now - 48 * HOUR })
        expect(await maybeFallbackTelemetryLevel(dir, now)).toBe(false)
        expect(await readTelemetryLevelState(dir)).toEqual({ level: 2, source: 'file' })
    })
})

