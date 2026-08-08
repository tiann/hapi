import { describe, expect, it, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync, existsSync, utimesSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
    __setUpgradeTargetBaseDirForTests,
    clearUpgradeTarget,
    durableTargetGeneration,
    isAuthorizedRunnerHandoff,
    isRunnerStartCliArgs,
    isUpgradeTargetStaleRelativeToCli,
    readUpgradeTarget,
    shouldDelegateToUpgradeTarget,
    writeUpgradeTarget,
    upgradeTargetMarkerPath,
} from './upgradeTarget'

describe('upgradeTarget', () => {
    let home: string

    beforeEach(() => {
        home = mkdtempSync(join(tmpdir(), 'hapi-upgrade-target-'))
        __setUpgradeTargetBaseDirForTests(home)
    })

    afterEach(() => {
        __setUpgradeTargetBaseDirForTests(null)
        rmSync(home, { recursive: true, force: true })
    })

    it('round-trips structured marker JSON', () => {
        const path = join(home, 'hapi-0.25.1-aaaaaaaaaaaaaaaa')
        writeFileSync(path, '#!binary\n')

        writeUpgradeTarget({
            path,
            targetVersion: '0.25.1',
            targetCapabilities: ['runner-self-upgrade'],
        })

        expect(upgradeTargetMarkerPath()).toBe(join(home, 'bin', '.hapi-upgrade-target'))
        expect(readUpgradeTarget()).toMatchObject({
            path,
            targetVersion: '0.25.1',
            targetCapabilities: ['runner-self-upgrade'],
        })
    })

    it('atomically replaces an existing marker via temp+rename', () => {
        const first = join(home, 'hapi-old')
        const second = join(home, 'hapi-new')
        writeFileSync(first, 'a')
        writeFileSync(second, 'b')
        writeUpgradeTarget({ path: first, targetVersion: '0.1.0' })
        writeUpgradeTarget({ path: second, targetVersion: '0.2.0', targetGeneration: 'gen-2' })
        expect(readUpgradeTarget()).toMatchObject({
            path: second,
            targetVersion: '0.2.0',
            targetGeneration: 'gen-2',
        })
        expect(existsSync(`${upgradeTargetMarkerPath()}.${process.pid}.tmp`)).toBe(false)
    })

    it('restores the previous marker when the Windows unlink+rename retry fails', () => {
        const oldPath = join(home, 'hapi-old-gen')
        const newPath = join(home, 'hapi-new-gen')
        writeFileSync(oldPath, 'old')
        writeFileSync(newPath, 'new')
        writeUpgradeTarget({ path: oldPath, targetVersion: '0.1.0', targetGeneration: 'gen-old' })

        let calls = 0
        expect(() => writeUpgradeTarget(
            { path: newPath, targetVersion: '0.2.0', targetGeneration: 'gen-new' },
            {
                platform: 'win32',
                renameSync: () => {
                    calls += 1
                    throw Object.assign(new Error('EPERM: rename'), { code: 'EPERM' })
                },
            },
        )).toThrow(/EPERM/)

        expect(calls).toBe(2) // initial rename + post-unlink retry
        expect(readUpgradeTarget()).toMatchObject({
            path: oldPath,
            targetVersion: '0.1.0',
            targetGeneration: 'gen-old',
        })
    })

    it('reads legacy plain-path markers', () => {
        const path = join(home, 'hapi-legacy')
        writeFileSync(path, 'x')
        writeUpgradeTarget({ path, targetVersion: '0.1.0' })
        writeFileSync(upgradeTargetMarkerPath(), `${path}\n`)

        expect(readUpgradeTarget()).toMatchObject({ path, targetVersion: '' })
    })

    it('does not delegate when the target is the current executable', () => {
        expect(shouldDelegateToUpgradeTarget({
            path: process.execPath,
            targetVersion: '0.25.1',
            updatedAt: Date.now(),
        })).toBe(false)
    })

    it('delegates for source bun runner starts when a durable marker exists', () => {
        const previous = process.env.HAPI_CLI_EXECUTABLE
        const previousHandoff = process.env.HAPI_DISABLE_VERSION_HANDOFF
        delete process.env.HAPI_CLI_EXECUTABLE
        delete process.env.HAPI_DISABLE_VERSION_HANDOFF
        try {
            const path = join(home, 'hapi-other')
            writeFileSync(path, 'x')
            expect(shouldDelegateToUpgradeTarget({
                path,
                targetVersion: '0.25.1',
                updatedAt: Date.now(),
            }, { currentVersion: '0.25.1' })).toBe(true)
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_CLI_EXECUTABLE
            } else {
                process.env.HAPI_CLI_EXECUTABLE = previous
            }
            if (previousHandoff === undefined) {
                delete process.env.HAPI_DISABLE_VERSION_HANDOFF
            } else {
                process.env.HAPI_DISABLE_VERSION_HANDOFF = previousHandoff
            }
        }
    })
    it('does not delegate when HAPI_DISABLE_VERSION_HANDOFF=1', () => {
        const previous = process.env.HAPI_DISABLE_VERSION_HANDOFF
        const previousExe = process.env.HAPI_CLI_EXECUTABLE
        process.env.HAPI_DISABLE_VERSION_HANDOFF = '1'
        delete process.env.HAPI_CLI_EXECUTABLE
        try {
            const path = join(home, 'hapi-other-optout')
            writeFileSync(path, 'x')
            expect(shouldDelegateToUpgradeTarget({
                path,
                targetVersion: '0.25.1',
                updatedAt: Date.now(),
            })).toBe(false)
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_DISABLE_VERSION_HANDOFF
            } else {
                process.env.HAPI_DISABLE_VERSION_HANDOFF = previous
            }
            if (previousExe === undefined) {
                delete process.env.HAPI_CLI_EXECUTABLE
            } else {
                process.env.HAPI_CLI_EXECUTABLE = previousExe
            }
        }
    })

    it('does not delegate when the current CLI is newer than the durable marker', () => {
        const previous = process.env.HAPI_CLI_EXECUTABLE
        const previousHandoff = process.env.HAPI_DISABLE_VERSION_HANDOFF
        delete process.env.HAPI_DISABLE_VERSION_HANDOFF
        const path = join(home, 'hapi-0.25.1-old')
        writeFileSync(path, 'x')
        process.env.HAPI_CLI_EXECUTABLE = join(home, 'hapi-current-shim')
        writeFileSync(process.env.HAPI_CLI_EXECUTABLE, 'shim')
        // Same-semver stale check compares mtimes. Age the shim so the marker
        // is newer and same-version delegation stays deterministic on coarse FS.
        const past = new Date(Date.now() - 60_000)
        utimesSync(process.env.HAPI_CLI_EXECUTABLE, past, past)
        try {
            const target = {
                path,
                targetVersion: '0.25.1',
                updatedAt: Date.now(),
            }
            expect(isUpgradeTargetStaleRelativeToCli(target, '0.26.0')).toBe(true)
            expect(shouldDelegateToUpgradeTarget(target, { currentVersion: '0.26.0' })).toBe(false)
            expect(shouldDelegateToUpgradeTarget(target, { currentVersion: '0.25.1' })).toBe(true)
            expect(shouldDelegateToUpgradeTarget(target, { currentVersion: '0.24.0' })).toBe(true)
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_CLI_EXECUTABLE
            } else {
                process.env.HAPI_CLI_EXECUTABLE = previous
            }
            if (previousHandoff === undefined) {
                delete process.env.HAPI_DISABLE_VERSION_HANDOFF
            } else {
                process.env.HAPI_DISABLE_VERSION_HANDOFF = previousHandoff
            }
        }
    })

    it('does not treat Bun runtime mtime as a newer CLI for source invocations', () => {
        const previous = process.env.HAPI_CLI_EXECUTABLE
        delete process.env.HAPI_CLI_EXECUTABLE
        try {
            const path = join(home, 'hapi-0.25.1-source-marker')
            writeFileSync(path, 'x')
            // Age the marker older than Bun's execPath so a naive mtime compare
            // would falsely mark it stale.
            const past = new Date(Date.now() - 60_000)
            utimesSync(path, past, past)
            const target = {
                path,
                targetVersion: '0.25.1',
                updatedAt: Date.now(),
            }
            expect(isUpgradeTargetStaleRelativeToCli(target, '0.25.1')).toBe(false)
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_CLI_EXECUTABLE
            } else {
                process.env.HAPI_CLI_EXECUTABLE = previous
            }
        }
    })

    it('does not delegate to an older same-semver marker when the entrypoint is newer on disk', () => {
        const previous = process.env.HAPI_CLI_EXECUTABLE
        const markerPath = join(home, 'hapi-0.25.1-old-gen')
        const currentPath = join(home, 'hapi-0.25.1-new-gen')
        writeFileSync(markerPath, 'old')
        // Ensure marker is older than current.
        const past = new Date(Date.now() - 60_000)
        utimesSync(markerPath, past, past)
        writeFileSync(currentPath, 'new')
        process.env.HAPI_CLI_EXECUTABLE = currentPath
        try {
            const target = {
                path: markerPath,
                targetVersion: '0.25.1',
                updatedAt: Date.now(),
            }
            expect(isUpgradeTargetStaleRelativeToCli(target, '0.25.1', { currentPath })).toBe(true)
            expect(shouldDelegateToUpgradeTarget(target, { currentVersion: '0.25.1' })).toBe(false)
        } finally {
            if (previous === undefined) {
                delete process.env.HAPI_CLI_EXECUTABLE
            } else {
                process.env.HAPI_CLI_EXECUTABLE = previous
            }
        }
    })

    it('clears a durable target marker so a broken path cannot restart-loop', () => {
        const path = join(home, 'hapi-gone')
        writeFileSync(path, 'x')
        writeUpgradeTarget({ path, targetVersion: '0.25.1' })
        expect(existsSync(upgradeTargetMarkerPath())).toBe(true)
        clearUpgradeTarget()
        expect(existsSync(upgradeTargetMarkerPath())).toBe(false)
        expect(readUpgradeTarget()).toBeNull()
    })

    it('ignores targetGeneration when the durable binary path is missing', () => {
        const path = join(home, 'hapi-deleted-gen')
        writeFileSync(path, 'x')
        writeUpgradeTarget({
            path,
            targetVersion: '0.25.1',
            targetGeneration: 'gen-stale',
        })
        expect(durableTargetGeneration(readUpgradeTarget())).toBe('gen-stale')
        rmSync(path, { force: true })
        expect(durableTargetGeneration(readUpgradeTarget())).toBeNull()
    })

    it('does not delegate during an authorized handoff even when a prior marker exists', () => {
        const previousExe = process.env.HAPI_CLI_EXECUTABLE
        const previousPid = process.env.HAPI_RUNNER_HANDOFF_FROM_PID
        const markerPath = join(home, 'hapi-old-gen')
        const candidatePath = join(home, 'hapi-new-gen')
        writeFileSync(markerPath, 'old')
        writeFileSync(candidatePath, 'new')
        writeUpgradeTarget({
            path: markerPath,
            targetVersion: '0.25.1',
            targetGeneration: 'gen-a',
        })
        process.env.HAPI_CLI_EXECUTABLE = candidatePath
        process.env.HAPI_RUNNER_HANDOFF_FROM_PID = '12345'
        try {
            expect(isAuthorizedRunnerHandoff()).toBe(true)
            const target = readUpgradeTarget()
            expect(target?.path).toBe(markerPath)
            expect(shouldDelegateToUpgradeTarget(target!)).toBe(false)
        } finally {
            if (previousExe === undefined) {
                delete process.env.HAPI_CLI_EXECUTABLE
            } else {
                process.env.HAPI_CLI_EXECUTABLE = previousExe
            }
            if (previousPid === undefined) {
                delete process.env.HAPI_RUNNER_HANDOFF_FROM_PID
            } else {
                process.env.HAPI_RUNNER_HANDOFF_FROM_PID = previousPid
            }
        }
    })
})

describe('isRunnerStartCliArgs', () => {
    it('matches only runner start / start-sync (not hub or other commands)', () => {
        expect(isRunnerStartCliArgs(['runner', 'start-sync'])).toBe(true)
        expect(isRunnerStartCliArgs(['runner', 'start'])).toBe(true)
        expect(isRunnerStartCliArgs(['runner', 'stop'])).toBe(false)
        expect(isRunnerStartCliArgs(['hub'])).toBe(false)
        expect(isRunnerStartCliArgs(['doctor'])).toBe(false)
        expect(isRunnerStartCliArgs([])).toBe(false)
    })
})
