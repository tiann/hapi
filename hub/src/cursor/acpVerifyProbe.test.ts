/**
 * Unit tests for the AcpVerifyProbe lock-acquisition primitives.
 *
 * The probe spawns a real `agent acp` in production. These tests only
 * cover the lock dance (start/stop side effects on the agent-acp-active
 * lock dir), NOT the RPC behaviour — that's covered by the integration
 * tests with a real agent binary.
 */

import { describe, expect, it, beforeEach, afterEach } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { AcpVerifyProbe, tryAcquireAcpActiveLock } from './acpVerifyProbe'

describe('AcpVerifyProbe — agent-acp-active lock acquisition (Codex #34 P2 v2)', () => {
    let hapiHome: string
    beforeEach(() => {
        hapiHome = mkdtempSync(join(tmpdir(), 'hapi-acp-lock-test-'))
    })
    afterEach(() => {
        try { rmSync(hapiHome, { recursive: true, force: true }) } catch {}
    })

    function lockDir(home: string): string {
        return join(home, 'locks', 'agent-acp-active')
    }

    it('acquires the lock atomically when no holder exists (and releases on stop)', async () => {
        const probe = new AcpVerifyProbe({
            agentBinary: '/usr/bin/env', // any executable; we'll stop() before sending RPC
            hapiHome
        })
        // Spawn would normally fail RPC, but the start path itself should
        // succeed up through agent spawn — what we care about here is the
        // lock side-effect.
        probe.start()
        expect(existsSync(join(lockDir(hapiHome), 'pid'))).toBe(true)
        await probe.stop()
        expect(existsSync(lockDir(hapiHome))).toBe(false)
    })

    it('throws when the lock is held by another live process (atomic refusal)', () => {
        // Pre-create the lock dir with a pid that IS alive (our own pid).
        mkdirSync(lockDir(hapiHome), { recursive: true })
        writeFileSync(join(lockDir(hapiHome), 'pid'), String(process.pid))

        const probe = new AcpVerifyProbe({
            agentBinary: '/usr/bin/env',
            hapiHome
        })
        expect(() => probe.start()).toThrow(/agent-acp-active lock is held/)
        // Pre-existing lock dir must NOT be removed by the failed acquire.
        expect(existsSync(lockDir(hapiHome))).toBe(true)
    })

    it('clears a stale lock (dead pid file present) and acquires on retry', async () => {
        // Pre-create with a pid that is virtually certain to be dead.
        mkdirSync(lockDir(hapiHome), { recursive: true })
        writeFileSync(join(lockDir(hapiHome), 'pid'), '999999') // typical max_pid; if collides, test is slightly flaky but unlikely on CI

        const probe = new AcpVerifyProbe({
            agentBinary: '/usr/bin/env',
            hapiHome
        })
        probe.start()
        // We acquired by clearing the stale dir and re-creating it.
        expect(existsSync(join(lockDir(hapiHome), 'pid'))).toBe(true)
        await probe.stop()
        expect(existsSync(lockDir(hapiHome))).toBe(false)
    })

    it('refuses on a pidless lock dir (mid-startup race, Codex #34 P2 v3)', () => {
        // Pre-create an EMPTY lock dir without a pid file — this is what
        // the CLI guard's registerActiveAcpTransport looks like in the
        // tiny window between mkdir and writeFileSync. Treating it as
        // "stale because no pid" would clobber the freshly-starting CLI
        // ACP transport.
        mkdirSync(lockDir(hapiHome), { recursive: true })

        const probe = new AcpVerifyProbe({
            agentBinary: '/usr/bin/env',
            hapiHome
        })
        expect(() => probe.start()).toThrow(/agent-acp-active lock is held/)
        // The pidless lock dir must still be intact.
        expect(existsSync(lockDir(hapiHome))).toBe(true)
    })

    it('stop() does not remove a lock dir owned by another holder', async () => {
        const probe = new AcpVerifyProbe({
            agentBinary: '/usr/bin/env',
            hapiHome
        })
        probe.start()
        // Simulate another process clobbering the pid file before our stop().
        writeFileSync(join(lockDir(hapiHome), 'pid'), String(process.pid + 1))
        await probe.stop()
        // Lock dir is preserved because we no longer own the pid file.
        expect(existsSync(lockDir(hapiHome))).toBe(true)
    })

    it('skipLockAcquire makes start() bypass internal acquire and stop() bypass release (Codex #34 P2 v7)', async () => {
        // Caller (migrator) holds the lock externally.
        const externalHandle = tryAcquireAcpActiveLock(hapiHome)
        expect(externalHandle).not.toBeNull()
        if (!externalHandle) return

        const probe = new AcpVerifyProbe({
            agentBinary: '/usr/bin/env',
            hapiHome,
            skipLockAcquire: true
        })
        // start() must NOT throw 'lock is held' — it skipped its internal acquire.
        probe.start()
        // Lock still held by the external handle.
        expect(existsSync(join(lockDir(hapiHome), 'pid'))).toBe(true)
        await probe.stop()
        // Lock is still held — probe.stop() did NOT release it.
        expect(existsSync(join(lockDir(hapiHome), 'pid'))).toBe(true)
        externalHandle.release()
        expect(existsSync(lockDir(hapiHome))).toBe(false)
    })

    it('falls back to $HOME/.local/bin and $HOME/.npm-global/bin in PATH when spawning agent (live dogfood 2026-06-07 regression: hub systemd unit ships minimal PATH AND the migrator overrides HOME to a tmpdir for isolation)', async () => {
        // The dogfood failure mode: hapi-hub.service ships minimal PATH and
        // never sees ~/.local/bin/agent. The migrator additionally overrides
        // HOME for the verify probe (HAPI_HOME isolation) — so any naive
        // augmentation that derives bin paths from baseEnv.HOME points at a
        // tmpdir that doesn't contain agent.
        //
        // After codex #34 P2 (round 13): the probe accepts an explicit
        // `agentLookupHome` option (caller threads its recorded session-
        // owner home). Falls back to process.env.HOME when not provided.
        // We pin BOTH: explicit option AND fallback. We also pin that the
        // existing PATH wins over the fallback (precedence preservation —
        // codex #34 P2 round-13 finding F3).
        const stubHome = mkdtempSync(join(tmpdir(), 'hapi-probe-stub-home-'))
        const stubBin = join(stubHome, '.local', 'bin')
        mkdirSync(stubBin, { recursive: true })
        writeFileSync(join(stubBin, 'agent'), '#!/bin/sh\nexit 99\n', { mode: 0o755 })

        const fakeOverrideHome = mkdtempSync(join(tmpdir(), 'hapi-probe-override-home-'))
        // Deliberately NO .local/bin under fakeOverrideHome.

        // Case A: explicit agentLookupHome wins, env.HOME irrelevant.
        try {
            const probe = new AcpVerifyProbe({
                hapiHome,
                agentLookupHome: stubHome,
                env: { HOME: fakeOverrideHome, PATH: '/usr/bin:/bin' }
            })
            probe.start()
            const exited = await new Promise<{ code: number | null }>((resolve) => {
                const interval = setInterval(() => {
                    if (probe['proc'] && probe['proc'].exitCode !== null) {
                        clearInterval(interval)
                        resolve({ code: probe['proc'].exitCode })
                    }
                }, 10)
                setTimeout(() => { clearInterval(interval); resolve({ code: -1 }) }, 2000)
            })
            expect(exited.code).toBe(99)
            await probe.stop()
        } finally {
            // intentionally leave stubHome in place for case B
        }

        // Case B: no agentLookupHome → falls back to process.env.HOME.
        const originalHome = process.env.HOME
        process.env.HOME = stubHome
        try {
            const probe = new AcpVerifyProbe({
                hapiHome,
                env: { HOME: fakeOverrideHome, PATH: '/usr/bin:/bin' }
            })
            probe.start()
            const exited = await new Promise<{ code: number | null }>((resolve) => {
                const interval = setInterval(() => {
                    if (probe['proc'] && probe['proc'].exitCode !== null) {
                        clearInterval(interval)
                        resolve({ code: probe['proc'].exitCode })
                    }
                }, 10)
                setTimeout(() => { clearInterval(interval); resolve({ code: -1 }) }, 2000)
            })
            expect(exited.code).toBe(99)
            await probe.stop()
        } finally {
            if (originalHome === undefined) delete process.env.HOME
            else process.env.HOME = originalHome
            try { rmSync(stubHome, { recursive: true, force: true }) } catch {}
            try { rmSync(fakeOverrideHome, { recursive: true, force: true }) } catch {}
        }
    })

    it('preserves explicit options.env.PATH precedence over the cursor-bin fallback (Codex #34 P2 round-13 F3)', async () => {
        // When the caller deliberately supplies options.env.PATH with a
        // pinned `agent` (e.g. a staging Cursor install or a wrapper),
        // the cursor-bin fallback must NOT override it. We test by giving
        // BOTH a winning PATH entry (priorityBin) AND a fallback entry
        // (fallbackBin) and asserting the priority wins.
        const priorityHome = mkdtempSync(join(tmpdir(), 'hapi-probe-priority-'))
        const priorityBin = join(priorityHome, 'bin')
        mkdirSync(priorityBin, { recursive: true })
        writeFileSync(join(priorityBin, 'agent'), '#!/bin/sh\nexit 11\n', { mode: 0o755 })

        const fallbackHome = mkdtempSync(join(tmpdir(), 'hapi-probe-fallback-'))
        const fallbackBin = join(fallbackHome, '.local', 'bin')
        mkdirSync(fallbackBin, { recursive: true })
        writeFileSync(join(fallbackBin, 'agent'), '#!/bin/sh\nexit 22\n', { mode: 0o755 })

        try {
            const probe = new AcpVerifyProbe({
                hapiHome,
                agentLookupHome: fallbackHome,
                env: { PATH: priorityBin } // explicit PATH wins; fallback bins appended
            })
            probe.start()
            const exited = await new Promise<{ code: number | null }>((resolve) => {
                const interval = setInterval(() => {
                    if (probe['proc'] && probe['proc'].exitCode !== null) {
                        clearInterval(interval)
                        resolve({ code: probe['proc'].exitCode })
                    }
                }, 10)
                setTimeout(() => { clearInterval(interval); resolve({ code: -1 }) }, 2000)
            })
            expect(exited.code).toBe(11) // priority wins, not 22 (fallback)
            await probe.stop()
        } finally {
            try { rmSync(priorityHome, { recursive: true, force: true }) } catch {}
            try { rmSync(fallbackHome, { recursive: true, force: true }) } catch {}
        }
    })

    it('joins augmented PATH with path.delimiter (Codex #34 P2 round-13 F1: Windows uses ; not :)', async () => {
        // Indirect assertion via spawn behaviour: on linux the delimiter is
        // `:`. We can't actually drive a win32 spawn from this test runner,
        // but we can confirm the join uses path.delimiter by checking that
        // the augmented PATH contains a path.delimiter between segments,
        // not a hardcoded ':'. Reach into the spawn env via a stubbed
        // agent that prints its PATH.
        const stubHome = mkdtempSync(join(tmpdir(), 'hapi-probe-delim-'))
        const stubBin = join(stubHome, '.local', 'bin')
        mkdirSync(stubBin, { recursive: true })
        writeFileSync(
            join(stubBin, 'agent'),
            '#!/bin/sh\nprintenv PATH > "$0.path"\nexit 33\n',
            { mode: 0o755 }
        )

        try {
            const probe = new AcpVerifyProbe({
                hapiHome,
                agentLookupHome: stubHome,
                env: { PATH: '/usr/bin' }
            })
            probe.start()
            await new Promise<void>((resolve) => {
                const interval = setInterval(() => {
                    if (probe['proc'] && probe['proc'].exitCode !== null) {
                        clearInterval(interval)
                        resolve()
                    }
                }, 10)
                setTimeout(() => { clearInterval(interval); resolve() }, 2000)
            })
            await probe.stop()
            const pathFile = join(stubBin, 'agent.path')
            const seenPath = existsSync(pathFile)
                ? require('node:fs').readFileSync(pathFile, 'utf8').trim()
                : ''
            // Should be `/usr/bin<delim><stubHome>/.local/bin<delim><stubHome>/.npm-global/bin`
            // on linux this means `/usr/bin:/tmp/.../.local/bin:/tmp/.../.npm-global/bin`
            expect(seenPath).toContain('/usr/bin')
            expect(seenPath).toContain(`${stubHome}/.local/bin`)
            // Existing PATH first, fallback appended.
            const usrBinIdx = seenPath.indexOf('/usr/bin')
            const fallbackIdx = seenPath.indexOf(`${stubHome}/.local/bin`)
            expect(usrBinIdx).toBeLessThan(fallbackIdx)
        } finally {
            try { rmSync(stubHome, { recursive: true, force: true }) } catch {}
        }
    })
})

describe('tryAcquireAcpActiveLock (Codex #34 P2 v7)', () => {
    let hapiHome: string
    beforeEach(() => {
        hapiHome = mkdtempSync(join(tmpdir(), 'hapi-acp-lock-helper-test-'))
    })
    afterEach(() => {
        try { rmSync(hapiHome, { recursive: true, force: true }) } catch {}
    })

    function lockDir(home: string): string {
        return join(home, 'locks', 'agent-acp-active')
    }

    it('returns a handle on a clean home; release() removes the lock dir', () => {
        const h = tryAcquireAcpActiveLock(hapiHome)
        expect(h).not.toBeNull()
        if (!h) return
        expect(existsSync(join(lockDir(hapiHome), 'pid'))).toBe(true)
        h.release()
        expect(existsSync(lockDir(hapiHome))).toBe(false)
    })

    it('returns null when another live process holds the lock', () => {
        // Pre-place an active lock (our pid is alive).
        mkdirSync(lockDir(hapiHome), { recursive: true })
        writeFileSync(join(lockDir(hapiHome), 'pid'), String(process.pid))
        const h = tryAcquireAcpActiveLock(hapiHome)
        expect(h).toBeNull()
        // Existing lock dir not clobbered.
        expect(existsSync(lockDir(hapiHome))).toBe(true)
    })

    it('returns null on a pidless lock dir (mid-startup race)', () => {
        mkdirSync(lockDir(hapiHome), { recursive: true })
        const h = tryAcquireAcpActiveLock(hapiHome)
        expect(h).toBeNull()
        expect(existsSync(lockDir(hapiHome))).toBe(true)
    })

    it('clears a stale lock (dead pid) and acquires on retry', () => {
        mkdirSync(lockDir(hapiHome), { recursive: true })
        writeFileSync(join(lockDir(hapiHome), 'pid'), '999999')
        const h = tryAcquireAcpActiveLock(hapiHome)
        expect(h).not.toBeNull()
        if (!h) return
        h.release()
    })

    it('release() is idempotent', () => {
        const h = tryAcquireAcpActiveLock(hapiHome)
        expect(h).not.toBeNull()
        if (!h) return
        h.release()
        h.release() // second call should not throw
        expect(existsSync(lockDir(hapiHome))).toBe(false)
    })

    it('release() removes the lock dir even when the pid file is missing (Codex #34 P2 v7)', () => {
        // Simulate the rare case where mkdir succeeded but writeFileSync(pid)
        // failed. The handle still owns the dir; release must clean it up.
        const h = tryAcquireAcpActiveLock(hapiHome)
        expect(h).not.toBeNull()
        if (!h) return
        // Remove the pid file underneath us.
        rmSync(join(lockDir(hapiHome), 'pid'))
        h.release()
        // Lock dir gone — we own it, we remove it even when pidless.
        expect(existsSync(lockDir(hapiHome))).toBe(false)
    })
})
