import type { TelemetryLevel } from '@hapi/protocol/telemetry'
import {
    getSettingsFile,
    readSettingsOrThrowCached,
    updateSettings,
    type Settings
} from './settings'

/**
 * Developer-mode telemetry switch (research report §3.2 item 4; default
 * flipped to 0 / opt-in on 2026-11-20 — privacy-first: users must explicitly
 * enable "developer mode" before any diagnostic data is collected or uploaded;
 * always-on telemetry would also be unacceptable to upstream review).
 *
 * Single source of truth: settings.json `telemetryLevel` (0-3, default 0).
 * `HAPI_TELEMETRY_LEVEL` env hard-overrides at read time (ops pin — wins for
 * the whole process lifetime, and the L3 auto-fallback deliberately does not
 * fight it). `telemetryLevelChangedAt` is internal bookkeeping: the timestamp
 * the level last changed, driving the 24h L3 auto-fallback.
 */

/** L3 is a temporary debug state: fall back to OFF after 24h (ruling §3.4 #5;
 * target changed 1 → 0 together with the opt-in default — expiring debug
 * grants must not silently leave sharing on). */
export const TELEMETRY_LEVEL_L3_FALLBACK_MS = 24 * 60 * 60_000

const VALID_LEVELS: readonly number[] = [0, 1, 2, 3]

export interface TelemetryLevelState {
    level: TelemetryLevel
    source: 'env' | 'file' | 'default'
}

export function isTelemetryLevel(value: unknown): value is TelemetryLevel {
    return typeof value === 'number' && VALID_LEVELS.includes(value)
}

export function parseTelemetryLevel(raw: string | undefined): TelemetryLevel | null {
    if (raw === undefined || raw === '') return null
    const n = Number(raw)
    return isTelemetryLevel(n) ? n : null
}

export function readEnvTelemetryLevel(): TelemetryLevel | null {
    return parseTelemetryLevel(process.env.HAPI_TELEMETRY_LEVEL)
}

export function resolveTelemetryLevel(
    settings: Pick<Settings, 'telemetryLevel'> | null,
    envLevel: TelemetryLevel | null
): TelemetryLevelState {
    if (envLevel !== null) return { level: envLevel, source: 'env' }
    const stored = settings?.telemetryLevel
    if (isTelemetryLevel(stored)) return { level: stored, source: 'file' }
    return { level: 0, source: 'default' }
}

export async function readTelemetryLevelState(dataDir: string): Promise<TelemetryLevelState> {
    const envLevel = readEnvTelemetryLevel()
    if (envLevel !== null) return { level: envLevel, source: 'env' }
    const settings = await readSettingsOrThrowCached(getSettingsFile(dataDir))
    return resolveTelemetryLevel(settings, null)
}

export async function writeTelemetryLevel(
    dataDir: string,
    level: TelemetryLevel
): Promise<TelemetryLevelState> {
    const changedAt = Date.now()
    await updateSettings(getSettingsFile(dataDir), (current) => ({
        settings: { ...current, telemetryLevel: level, telemetryLevelChangedAt: changedAt },
        result: resolveTelemetryLevel({ telemetryLevel: level }, readEnvTelemetryLevel())
    }))
    return readTelemetryLevelState(dataDir)
}

/**
 * L3 auto-fallback: settings says 3 and the last change is older than 24h →
 * write back 0 (off — the opt-in default). Skipped entirely while the env pin
 * holds (env wins, and we must not rewrite the user's settings.json out from
 * under the operator). A level-3 value without a timestamp (hand-edited file)
 * gets stamped now so the countdown starts from the first observation instead
 * of instantly knocking a freshly pinned L3 back down.
 */
export async function maybeFallbackTelemetryLevel(
    dataDir: string,
    now: number = Date.now()
): Promise<boolean> {
    if (readEnvTelemetryLevel() !== null) return false
    const settingsFile = getSettingsFile(dataDir)
    const settings = await readSettingsOrThrowCached(settingsFile)
    if (settings.telemetryLevel !== 3) return false
    const changedAt = settings.telemetryLevelChangedAt
    if (typeof changedAt !== 'number') {
        await updateSettings(settingsFile, (current) => ({
            settings: { ...current, telemetryLevelChangedAt: now },
            result: false
        }))
        return false
    }
    if (now - changedAt < TELEMETRY_LEVEL_L3_FALLBACK_MS) return false
    await updateSettings(settingsFile, (current) => ({
        settings: { ...current, telemetryLevel: 0, telemetryLevelChangedAt: now },
        result: true
    }))
    return true
}
