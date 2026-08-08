/**
 * Durable hub-artifact upgrade target.
 *
 * After a fleet upgrade installs a content-addressed binary under ~/.hapi/bin,
 * systemd (Restart=always, ExecStart=/usr/local/bin/hapi) can relaunch the old
 * entrypoint. Reading this marker early in runCli re-execs into the upgraded
 * binary so the handoff survives supervisor restarts.
 */

import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync, unlinkSync, renameSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { compareHapiVersions } from '@hapi/protocol/upgradeChannel'
import { configuration } from '@/configuration'
import { isBunCompiled } from '@/projectPath'
import { resolveHappyCliExecutable } from '@/utils/spawnHappyCLI'
import packageJson from '../../package.json'

export type UpgradeTarget = {
    path: string
    targetVersion: string
    targetCapabilities?: string[]
    /** Hub-artifact build generation (source fingerprint) last applied. */
    targetGeneration?: string
    updatedAt: number
}

/** True for systemd / fleet handoff entrypoints only (not hub/doctor/agent). */
export function isRunnerStartCliArgs(args: readonly string[]): boolean {
    return args[0] === 'runner' && (args[1] === 'start' || args[1] === 'start-sync')
}

export function upgradeTargetMarkerPath(): string {
    const base = markerBaseDirOverride
        ?? configuration.happyHomeDir
        ?? join(homedir(), '.hapi')
    return join(base, 'bin', '.hapi-upgrade-target')
}

/** Test-only override so markers land in a temp dir without reloading configuration. */
let markerBaseDirOverride: string | null = null
export function __setUpgradeTargetBaseDirForTests(dir: string | null): void {
    markerBaseDirOverride = dir
}

export function writeUpgradeTarget(
    target: Omit<UpgradeTarget, 'updatedAt'> & { updatedAt?: number },
    deps: {
        platform?: NodeJS.Platform
        renameSync?: (from: string, to: string) => void
    } = {},
): void {
    const marker = upgradeTargetMarkerPath()
    mkdirSync(dirname(marker), { recursive: true })
    const payload: UpgradeTarget = {
        path: target.path,
        targetVersion: target.targetVersion,
        targetCapabilities: target.targetCapabilities,
        targetGeneration: target.targetGeneration,
        updatedAt: target.updatedAt ?? Date.now(),
    }
    // Temp + rename so a crash mid-write cannot leave a half-parsed marker that
    // would bounce Restart=always into a broken entrypoint.
    const tmp = `${marker}.${process.pid}.tmp`
    const rename = deps.renameSync ?? renameSync
    const platform = deps.platform ?? process.platform
    writeFileSync(tmp, `${JSON.stringify(payload, null, 2)}\n`, 'utf8')
    try {
        rename(tmp, marker)
    } catch (error) {
        // Windows often refuses rename-over-existing; unlink then retry.
        // Preserve prior marker bytes so a failed retry does not strand Restart=always
        // without a bootable durable target (and so prune-gating still has meaning).
        if (platform === 'win32' && existsSync(marker)) {
            let previous: Buffer | null = null
            try {
                previous = readFileSync(marker)
            } catch {
                previous = null
            }
            unlinkSync(marker)
            try {
                rename(tmp, marker)
                return
            } catch (replaceError) {
                if (previous) {
                    try {
                        writeFileSync(marker, previous)
                    } catch {
                        // best-effort restore
                    }
                }
                try {
                    unlinkSync(tmp)
                } catch {
                    // best-effort
                }
                throw replaceError
            }
        }
        try {
            unlinkSync(tmp)
        } catch {
            // best-effort
        }
        throw error
    }
}

/** Remove a durable target that can no longer be spawned (avoids Restart=always loops). */
export function clearUpgradeTarget(): void {
    const marker = upgradeTargetMarkerPath()
    try {
        if (existsSync(marker)) {
            unlinkSync(marker)
        }
    } catch {
        // best-effort
    }
}

export function readUpgradeTarget(): UpgradeTarget | null {
    const marker = upgradeTargetMarkerPath()
    if (!existsSync(marker)) {
        return null
    }
    try {
        const raw = readFileSync(marker, 'utf8').trim()
        if (!raw) {
            return null
        }
        // Legacy: plain path string from earlier builds.
        if (!raw.startsWith('{')) {
            return {
                path: raw,
                targetVersion: '',
                updatedAt: 0,
            }
        }
        const parsed = JSON.parse(raw) as Partial<UpgradeTarget>
        if (typeof parsed.path !== 'string' || parsed.path.length === 0) {
            return null
        }
        return {
            path: parsed.path,
            targetVersion: typeof parsed.targetVersion === 'string' ? parsed.targetVersion : '',
            targetCapabilities: Array.isArray(parsed.targetCapabilities)
                ? parsed.targetCapabilities.filter((cap): cap is string => typeof cap === 'string')
                : undefined,
            targetGeneration: typeof parsed.targetGeneration === 'string'
                ? parsed.targetGeneration
                : undefined,
            updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
        }
    } catch {
        return null
    }
}

/**
 * Generation to advertise / compare only when the durable target binary still
 * exists. A marker pointing at a deleted path must not suppress reinstall.
 */
export function durableTargetGeneration(target: UpgradeTarget | null | undefined): string | null {
    if (!target?.path || !existsSync(target.path)) {
        return null
    }
    return target.targetGeneration ?? null
}

function samePath(left: string, right: string): boolean {
    try {
        return realpathSync(left) === realpathSync(right)
    } catch {
        return left === right
    }
}

/**
 * True when this process is an authorized handoff child and must not re-exec
 * into a previous durable upgrade-target (that would bounce B → A mid-handoff).
 */
export function isAuthorizedRunnerHandoff(
    env: NodeJS.ProcessEnv = process.env,
): boolean {
    return Boolean(env.HAPI_RUNNER_HANDOFF_FROM_PID?.trim() && env.HAPI_CLI_EXECUTABLE?.trim())
}

/**
 * True when the durable marker trails a newer CLI already installed at the
 * entrypoint (e.g. npm/binary update after a prior hub-artifact upgrade, or a
 * same-semver soup remat that replaced the normal entrypoint bytes).
 */
export function isUpgradeTargetStaleRelativeToCli(
    target: UpgradeTarget,
    currentVersion: string = packageJson.version,
    deps: { currentPath?: string } = {},
): boolean {
    if (!target.targetVersion) {
        return false
    }
    const relation = compareHapiVersions(currentVersion, target.targetVersion)
    if (relation !== null && relation > 0) {
        return true
    }
    // Same semver: soup remats / same-version installs can replace the
    // entrypoint without bumping package.json. Prefer that newer binary over
    // an older content-addressed marker. Skip for plain source `bun` runs —
    // resolveHappyCliExecutable is the Bun runtime there, and a Bun upgrade
    // must not clear a valid artifact marker.
    if (relation === 0) {
        if (!isBunCompiled() && !process.env.HAPI_CLI_EXECUTABLE?.trim()) {
            return false
        }
        try {
            const currentPath = deps.currentPath ?? resolveHappyCliExecutable()
            if (samePath(currentPath, target.path)) {
                return false
            }
            return statSync(currentPath).mtimeMs > statSync(target.path).mtimeMs
        } catch {
            return false
        }
    }
    return false
}

/**
 * True when this process should re-exec into the upgrade-target binary.
 * Skip during an authorized handoff: the child is already the candidate.
 * Skip when HAPI_DISABLE_VERSION_HANDOFF=1 (soup/rebuild-only supervisors).
 * Skip when the current CLI is newer than the marker (do not pin backwards).
 * Source `bun ... runner start` still honors a persisted marker so a completed
 * hub-artifact upgrade does not regress after supervisor restart.
 */
export function shouldDelegateToUpgradeTarget(
    target: UpgradeTarget,
    deps: { currentVersion?: string } = {},
): boolean {
    if (isAuthorizedRunnerHandoff()) {
        return false
    }
    if (!target.path || !existsSync(target.path)) {
        return false
    }
    if (isUpgradeTargetStaleRelativeToCli(target, deps.currentVersion ?? packageJson.version)) {
        return false
    }
    if (process.env.HAPI_DISABLE_VERSION_HANDOFF === '1') {
        return false
    }
    // runCli already limits delegation to runner start/start-sync.
    const current = resolveHappyCliExecutable()
    return !samePath(current, target.path)
}
