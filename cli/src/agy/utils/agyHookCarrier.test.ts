import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { join } from 'node:path';

// node:fs/promises' namespace object cannot be spied on directly in this
// ESM environment ("Module namespace is not configurable") -- vi.mock is
// the supported seam. Every call other than the two racing tests below
// delegates straight through to the real implementation, so this has no
// effect on the rest of the file's (many) real-filesystem assertions.
vi.mock('node:fs/promises', async (importOriginal) => {
    const actual = await importOriginal<typeof import('node:fs/promises')>();
    return { ...actual, readdir: vi.fn(actual.readdir) };
});
import {
    agyHookCarrierIsIntact,
    cleanupAgyHookCarrier,
    computeLocalCarrierScope,
    prepareAgyHookCarrier,
    sweepAgyHookCarriers,
    writeAgyHooksJsonAtomic,
    type ScopeProbe
} from './agyHookCarrier';

/**
 * Spawns a real child process, waits for it to exit, and returns its PID.
 * By the time this resolves the PID is guaranteed dead — a stronger,
 * non-vacuous stand-in for "some unrelated orphaned carrier's owner" than a
 * made-up large integer, which could in theory collide with a live PID.
 */
function spawnAndReapDeadPid(): Promise<number> {
    return new Promise((resolvePid, reject) => {
        const child = spawn(process.execPath, ['-e', 'process.exit(0)']);
        const pid = child.pid;
        if (!pid) {
            reject(new Error('failed to obtain a PID for the throwaway child process'));
            return;
        }
        child.once('exit', () => resolvePid(pid));
        child.once('error', reject);
    });
}

describe('agy hook carrier', () => {
    it('creates workspace-local hooks and a session-scoped HAPI MCP plugin', () => {
        const hooks = '{"hapi-bridge":{}}';
        const mcpServer = { command: '/opt/hapi', args: ['mcp', '--url', 'http://127.0.0.1:4312'] };
        const result = prepareAgyHookCarrier(hooks, mcpServer);
        expect(result).toBeDefined();
        if (!result) return;

        try {
            expect(readFileSync(join(result.carrierDir, '.agents', 'hooks.json'), 'utf8')).toBe(hooks);
            const pluginDir = join(result.carrierDir, '.agents', 'plugins', 'hapi');
            expect(JSON.parse(readFileSync(join(pluginDir, 'plugin.json'), 'utf8'))).toEqual({ name: 'hapi' });
            expect(JSON.parse(readFileSync(join(pluginDir, 'mcp_config.json'), 'utf8'))).toEqual({
                mcpServers: { hapi: mcpServer }
            });
            expect(statSync(join(pluginDir, 'mcp_config.json')).mode & 0o777).toBe(0o600);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('removes the carrier after the session exits', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        cleanupAgyHookCarrier(result.carrierDir);
        expect(existsSync(result.carrierDir)).toBe(false);
    });
});

describe('writeAgyHooksJsonAtomic', () => {
    it('overwrites an existing carrier\'s hooks.json in place, leaving no stray temp file behind', () => {
        const result = prepareAgyHookCarrier('{"hapi-bridge":{"PreToolUse":[]}}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            const replacement = '{"hapi-bridge":{"PreToolUse":[],"PreInvocation":[]}}';
            writeAgyHooksJsonAtomic(result.carrierDir, replacement);

            const agentsDir = join(result.carrierDir, '.agents');
            expect(readFileSync(join(agentsDir, 'hooks.json'), 'utf8')).toBe(replacement);
            // The atomic-write temp file must be renamed away, not merely
            // written alongside the target — a leftover .tmp file would mean
            // the rename step silently failed or was skipped.
            expect(readdirSync(agentsDir).sort()).toEqual(['hooks.json']);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('throws when the carrier does not exist — callers must check agyHookCarrierIsIntact() first', () => {
        expect(() => writeAgyHooksJsonAtomic('/tmp/hapi-agy-carrier-does-not-exist', '{}')).toThrow();
    });

    it('cleans up the temp file when the atomic rename fails (Fix N5)', () => {
        const result = prepareAgyHookCarrier('{"hapi-bridge":{"PreToolUse":[]}}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            const agentsDir = join(result.carrierDir, '.agents');
            // Force renameSync to fail without mocking fs: renaming a
            // regular file onto an existing (non-empty-capable) directory
            // fails with EISDIR — a real, OS-enforced failure mode, not a
            // simulated one.
            rmSync(join(agentsDir, 'hooks.json'), { force: true });
            mkdirSync(join(agentsDir, 'hooks.json'));

            expect(() => writeAgyHooksJsonAtomic(result.carrierDir, '{"hapi-bridge":{"PreInvocation":[]}}')).toThrow();

            // Fails (mutation check: drop the try/finally around renameSync)
            // if a leftover .hooks.json.<pid>.<uuid>.tmp file is left behind
            // in .agents/ after the failed rename.
            const leftoverTmpFiles = readdirSync(agentsDir).filter((name) => name.startsWith('.hooks.json.') && name.endsWith('.tmp'));
            expect(leftoverTmpFiles).toEqual([]);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });
});

describe('agyHookCarrierIsIntact', () => {
    it('is true when hooks.json is present', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            expect(agyHookCarrierIsIntact(result.carrierDir)).toBe(true);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('is false once the carrier has been cleaned up (directory gone entirely)', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        cleanupAgyHookCarrier(result.carrierDir);
        expect(agyHookCarrierIsIntact(result.carrierDir)).toBe(false);
    });
});

// Phase 2.8: carriers used to live under the OS tmp dir (mkdtempSync(join(
// tmpdir(), ...))), where a machine's periodic tmpfiles.d sweep can delete a
// still-in-use carrier out from under a long-lived session (agy re-reads
// hooks.json on every model call — see the plan's §6.6 — so a carrier isn't
// a one-shot file, it must survive for the session's entire lifetime).
// Moving it under HAPI_HOME gets it out of that blast radius and gives HAPI
// its own directory to run a liveness-based sweep over at session start.
describe('agy hook carrier location (Phase 2.8)', () => {
    let previousHapiHome: string | undefined;
    let customHapiHome: string;

    beforeEach(() => {
        previousHapiHome = process.env.HAPI_HOME;
        customHapiHome = mkdtempSync(join(tmpdir(), 'hapi-phase28-home-'));
        process.env.HAPI_HOME = customHapiHome;
    });

    afterEach(() => {
        if (previousHapiHome === undefined) delete process.env.HAPI_HOME;
        else process.env.HAPI_HOME = previousHapiHome;
        rmSync(customHapiHome, { recursive: true, force: true });
    });

    it('creates a new carrier under HAPI_HOME/agy-carriers, not the OS tmp dir', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            const expectedRoot = join(customHapiHome, 'agy-carriers');
            expect(result.carrierDir.startsWith(expectedRoot + '/')).toBe(true);
            // A stale (unmodified) implementation would place it directly
            // under the OS tmp dir instead — assert it did not.
            expect(result.carrierDir.startsWith(join(tmpdir(), 'hapi-agy-carrier-'))).toBe(false);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });

    it('writes owner metadata (pid, scope) at the carrier root, outside .agents/', () => {
        const result = prepareAgyHookCarrier('{}');
        expect(result).toBeDefined();
        if (!result) return;

        try {
            const ownerPath = join(result.carrierDir, 'owner.json');
            expect(existsSync(ownerPath)).toBe(true);
            const owner = JSON.parse(readFileSync(ownerPath, 'utf8'));
            expect(owner.pid).toBe(process.pid);
            // Fix 2: `scope` (boot-id + PID-namespace on Linux, a tagged
            // hostname fallback elsewhere) is the over-delete guard for a
            // shared HAPI_HOME (devcontainer bind-mount, NFS home) — a pid
            // recorded under a different scope must never be probed by this
            // host's sweep. See computeLocalCarrierScope's docstring for why
            // hostname alone (the original Fix N6) wasn't enough.
            expect(owner.scope).toBe(computeLocalCarrierScope());
            // Must not land inside .agents/ — that's the directory agy itself
            // reads (hooks.json, plugins/), and owner metadata is HAPI-only
            // bookkeeping that must not pollute it.
            expect(existsSync(join(result.carrierDir, '.agents', 'owner.json'))).toBe(false);
        } finally {
            cleanupAgyHookCarrier(result.carrierDir);
        }
    });
});

describe('computeLocalCarrierScope', () => {
    it('computes a linux:<bootId>:<nsId> scope from real /proc reads on this (Linux) test host', () => {
        // Non-vacuous: this sandbox's /proc is genuinely readable (verified
        // manually before writing this test), so this pins the real Linux
        // success path, not just the fallback.
        const scope = computeLocalCarrierScope();
        expect(scope).toMatch(/^linux:[0-9a-f-]{36}:\d+$/);
    });

    it('refuses to fall back to hostname when the Linux probe fails — hostname is not an identity', () => {
        const probe: ScopeProbe = {
            readBootId: () => { throw new Error('ENOENT: no /proc on this platform'); },
            readPidNamespaceId: () => { throw new Error('should not be reached'); },
            hostname: () => 'macbook.local',
        };
        // Two machines sharing a HAPI_HOME can share a hostname while their
        // pids live in unrelated spaces, so a hostname-derived scope would let
        // one sweep the other's live carrier. Undefined makes the sweep
        // preserve everything instead. Fails if a fallback is reintroduced.
        expect(computeLocalCarrierScope(probe)).toBeUndefined();
    });

});

describe('sweepAgyHookCarriers', () => {
    let previousHapiHome: string | undefined;
    let customHapiHome: string;

    beforeEach(() => {
        previousHapiHome = process.env.HAPI_HOME;
        customHapiHome = mkdtempSync(join(tmpdir(), 'hapi-phase28-sweep-home-'));
        process.env.HAPI_HOME = customHapiHome;
    });

    afterEach(() => {
        vi.restoreAllMocks();
        if (previousHapiHome === undefined) delete process.env.HAPI_HOME;
        else process.env.HAPI_HOME = previousHapiHome;
        rmSync(customHapiHome, { recursive: true, force: true });
    });

    // Every real carrier is mkdtemp'd under this prefix (see
    // prepareAgyHookCarrier / CARRIER_DIR_PREFIX in agyHookCarrier.ts) — the
    // hand-built carriers below must match it so Fix N3's prefix filter
    // doesn't skip them for reasons unrelated to what each test wants to
    // exercise.
    const CARRIER_PREFIX = 'hapi-agy-carrier-';

    /** Builds a carrier directory by hand (not via prepareAgyHookCarrier) so
     * the test can control the owner.json contents independently of this
     * test process's own PID. */
    function makeCarrierDir(name: string): string {
        const root = join(customHapiHome, 'agy-carriers');
        mkdirSync(root, { recursive: true });
        const carrierDir = join(root, `${CARRIER_PREFIX}${name}`);
        mkdirSync(join(carrierDir, '.agents'), { recursive: true });
        writeFileSync(join(carrierDir, '.agents', 'hooks.json'), '{}');
        return carrierDir;
    }

    it('③ sweeps a carrier whose owner scope matches AND whose process has died', async () => {
        const deadPid = await spawnAndReapDeadPid();
        const carrierDir = makeCarrierDir('dead-owner-matching-scope');
        writeFileSync(
            join(carrierDir, 'owner.json'),
            JSON.stringify({ pid: deadPid, scope: computeLocalCarrierScope() })
        );

        await sweepAgyHookCarriers();

        // Fails if the scope-match requirement (Fix 2b) or the liveness
        // check regresses to always-preserve — this is the one combination
        // that must actually delete.
        expect(existsSync(carrierDir)).toBe(false);
    });

    it('preserves a carrier whose owner process is alive — the costliest mistake is deleting a live session\'s carrier', async () => {
        const carrierDir = makeCarrierDir('alive-owner');
        // This test process's own PID is guaranteed alive for the duration
        // of the test.
        writeFileSync(
            join(carrierDir, 'owner.json'),
            JSON.stringify({ pid: process.pid, scope: computeLocalCarrierScope() })
        );

        await sweepAgyHookCarriers();

        expect(existsSync(carrierDir)).toBe(true);
    });

    it('treats EPERM (process exists but is owned by someone else) as alive, not dead', async () => {
        const carrierDir = makeCarrierDir('eperm-owner');
        writeFileSync(
            join(carrierDir, 'owner.json'),
            JSON.stringify({ pid: 1, scope: computeLocalCarrierScope() })
        );
        vi.spyOn(process, 'kill').mockImplementation(((pid: number) => {
            if (pid === 1) {
                const error = new Error('EPERM') as NodeJS.ErrnoException;
                error.code = 'EPERM';
                throw error;
            }
            return true;
        }) as typeof process.kill);

        await sweepAgyHookCarriers();

        expect(existsSync(carrierDir)).toBe(true);
    });

    it('① preserves a carrier with unreadable/missing owner metadata no matter how old (Fix 2a)', async () => {
        // Fresh, no owner.json at all — simulates a carrier from before this
        // feature shipped, a partial write, or a read that raced a
        // concurrent write against a still-live, multi-day session.
        const carrierDir = makeCarrierDir('no-owner-metadata');
        await sweepAgyHookCarriers();
        expect(existsSync(carrierDir)).toBe(true);

        // Fix 2a: age no longer matters at all — a carrier this old used to
        // be swept purely on age once the owner-metadata read failed. That
        // is exactly what would delete a live, multi-day agy session's
        // carrier if its owner.json read merely raced a write. Aging it
        // past the OLD 24h threshold must change nothing now.
        const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(carrierDir, staleTime, staleTime);
        await sweepAgyHookCarriers();
        // Fails (mutation check: reintroduce the mtime-based ownerless
        // fallback branch) if this carrier gets swept purely for being old.
        expect(existsSync(carrierDir)).toBe(true);
    });

    it('treats a legacy owner.json (pid only, no scope field) as unreadable metadata and preserves it regardless of age', async () => {
        // A pre-this-fix owner.json (hostname field, not scope) or a
        // pre-Fix-N6 one (pid only) both fail the new schema check the same
        // way: readOwnerMetadata requires a non-empty `scope` string.
        const carrierDir = makeCarrierDir('legacy-owner-no-scope');
        writeFileSync(join(carrierDir, 'owner.json'), JSON.stringify({ pid: 999999 }));

        await sweepAgyHookCarriers();
        expect(existsSync(carrierDir)).toBe(true);

        const staleTime = new Date(Date.now() - 25 * 60 * 60 * 1000);
        utimesSync(carrierDir, staleTime, staleTime);
        await sweepAgyHookCarriers();
        expect(existsSync(carrierDir)).toBe(true);
    });

    it('② preserves a carrier owned by a different scope even when its recorded pid is dead (Fix 2b)', async () => {
        const deadPid = await spawnAndReapDeadPid();
        const carrierDir = makeCarrierDir('other-scope-dead-pid');
        writeFileSync(
            join(carrierDir, 'owner.json'),
            // A scope that can never equal this process's real
            // computeLocalCarrierScope() (real scopes are always prefixed
            // `linux:`) — this deadPid is only
            // meaningfully "dead" in THIS process's own boot/PID-namespace;
            // recorded under a different scope it must never be probed at
            // all.
            JSON.stringify({ pid: deadPid, scope: 'some-other-container-scope-4a1c9e' })
        );

        await sweepAgyHookCarriers();

        // Fails (mutation check: drop the `owner.scope !== localScope`
        // guard in sweepAgyHookCarriers) if the carrier gets deleted because
        // its pid happens to be dead in THIS process's namespace too.
        expect(existsSync(carrierDir)).toBe(true);
    });

    it('④ preserves everything, without even scanning, when the local scope cannot be determined', async () => {
        const deadPid = await spawnAndReapDeadPid();
        const carrierDir = makeCarrierDir('would-be-swept-if-scope-resolved');
        // This owner.json carries the REAL local scope and a genuinely dead
        // pid — under a working scope probe this is exactly the carrier
        // that test ③ proves gets swept. The only variable here is that
        // sweepAgyHookCarriers itself is called with a probe that fails to
        // resolve ANY scope (Linux probe and hostname fallback both throw).
        writeFileSync(
            join(carrierDir, 'owner.json'),
            JSON.stringify({ pid: deadPid, scope: computeLocalCarrierScope() })
        );

        const failingProbe: ScopeProbe = {
            readBootId: () => { throw new Error('no /proc'); },
            readPidNamespaceId: () => { throw new Error('no /proc'); },
            hostname: () => { throw new Error('gethostname() failed'); },
        };
        await sweepAgyHookCarriers(failingProbe);

        // Fails (mutation check: drop the `if (!localScope) return` early
        // bailout in sweepAgyHookCarriers) if this ever gets deleted despite
        // the sweep being unable to identify itself.
        expect(existsSync(carrierDir)).toBe(true);
    });

    it('never inspects (or deletes) an entry that does not carry the carrier prefix, even when its owner.json would otherwise qualify for deletion (Fix N3)', async () => {
        const deadPid = await spawnAndReapDeadPid();
        const root = join(customHapiHome, 'agy-carriers');
        mkdirSync(root, { recursive: true });
        // Deliberately NOT prefixed with hapi-agy-carrier- — simulates
        // unrelated content sharing the agy-carriers/ root (HAPI_HOME
        // misconfiguration/reuse).
        const strangerDir = join(root, 'not-a-hapi-carrier');
        mkdirSync(strangerDir, { recursive: true });
        writeFileSync(join(strangerDir, 'important-unrelated-file.txt'), 'do not delete me');
        // A matching scope + confirmed-dead pid — exactly the combination
        // test ③ proves gets deleted for a properly-prefixed carrier.
        writeFileSync(
            join(strangerDir, 'owner.json'),
            JSON.stringify({ pid: deadPid, scope: computeLocalCarrierScope() })
        );

        await sweepAgyHookCarriers();

        // Fails (mutation check: drop the `entry.startsWith(CARRIER_DIR_PREFIX)`
        // guard) if the sweep deletes this non-carrier directory despite its
        // owner.json otherwise qualifying.
        expect(existsSync(strangerDir)).toBe(true);
        expect(existsSync(join(strangerDir, 'important-unrelated-file.txt'))).toBe(true);
    });

    it('judges a carrier-prefixed entry by the entry itself, not a symlink target (Fix N4)', async () => {
        const root = join(customHapiHome, 'agy-carriers');
        mkdirSync(root, { recursive: true });

        // A real, live-owned, otherwise-untouchable directory elsewhere —
        // the "attack surface" a naive statSync-based sweep would
        // dereference into.
        const targetDir = mkdtempSync(join(tmpdir(), 'hapi-n4-symlink-target-'));
        try {
            const linkPath = join(root, `${CARRIER_PREFIX}symlinked`);
            symlinkSync(targetDir, linkPath, 'dir');

            await sweepAgyHookCarriers();

            // Fails (mutation check: revert lstatSync back to statSync) if
            // the sweep dereferences the symlink and evaluates the TARGET
            // directory's contents/owner as if it were the carrier entry
            // itself — lstatSync().isDirectory() on a symlink is false, so
            // the loop must skip it outright (preserve both the link and
            // whatever it points at) rather than treat it as a carrier.
            expect(existsSync(linkPath)).toBe(true);
            expect(existsSync(targetDir)).toBe(true);
        } finally {
            rmSync(targetDir, { recursive: true, force: true });
        }
    });

    it('does not let two different HAPI_HOME roots interfere with each other', async () => {
        const hapiHomeA = customHapiHome;
        const carrierA = prepareAgyHookCarrier('{"a":true}');
        expect(carrierA).toBeDefined();
        if (!carrierA) return;

        const hapiHomeB = mkdtempSync(join(tmpdir(), 'hapi-phase28-home-b-'));
        try {
            process.env.HAPI_HOME = hapiHomeB;

            // Sweeping under HAPI_HOME B must never touch A's carrier, even
            // though A's carrier has no owner.json reachable from B's root.
            await sweepAgyHookCarriers();
            expect(existsSync(carrierA.carrierDir)).toBe(true);

            const carrierB = prepareAgyHookCarrier('{"b":true}');
            expect(carrierB).toBeDefined();
            if (!carrierB) return;
            expect(carrierB.carrierDir.startsWith(join(hapiHomeB, 'agy-carriers') + '/')).toBe(true);

            // B's root must contain exactly B's own carrier, not A's.
            const bEntries = readdirSync(join(hapiHomeB, 'agy-carriers'));
            expect(bEntries).toEqual([carrierB.carrierDir.split('/').pop()]);

            cleanupAgyHookCarrier(carrierB.carrierDir);
        } finally {
            process.env.HAPI_HOME = hapiHomeA;
            cleanupAgyHookCarrier(carrierA.carrierDir);
            rmSync(hapiHomeB, { recursive: true, force: true });
        }
    });

    // Phase 2-A: sweepAgyHookCarriers is now async and no longer runs
    // strictly before every other carrier-creating call in the process (see
    // runAgy.ts, which now fires it without awaiting it so it cannot delay
    // session startup). That makes a genuinely new race possible: THIS
    // session's own prepareAgyHookCarrier() call can now interleave with an
    // in-flight sweep. Three guarantees together make that safe -- two are
    // already covered by the tests above under their new async form
    // (① unreadable/missing owner.json -> preserved; "preserves a carrier
    // whose owner process is alive" -> preserved); the one below is the
    // genuinely new guarantee this phase introduces: a directory that
    // didn't exist yet when readdir() took its snapshot is never examined
    // at all, matching or not.
    describe('racing safety (Phase 2-A: sweep decoupled from the session-startup path)', () => {
        // mockImplementationOnce below is self-consuming (reverts to the
        // module-level vi.fn(actual.readdir) delegate after exactly one
        // call), so no explicit mock teardown is needed here -- and
        // vi.restoreAllMocks() would be actively harmful: readdir is a
        // plain vi.fn() (module-mock factory, not vi.spyOn), so "restore"
        // has no original to revert to and would instead wipe its
        // delegating default for the rest of this file's run.
        it('never examines a carrier created after the readdir snapshot was already taken, even though it would otherwise qualify for deletion', async () => {
            let releaseGate: () => void = () => {};
            const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
            let markSnapshotTaken: () => void = () => {};
            const snapshotTaken = new Promise<void>((resolve) => { markSnapshotTaken = resolve; });

            // A carrier must already exist so agy-carriers/ itself exists by
            // the time sweep's readdir() runs (an ENOENT root is a distinct,
            // already-covered early-return path, not what this test targets).
            makeCarrierDir('baseline-existing');

            // node:fs/promises' readdir has an overloaded signature (Dirent[]
            // with withFileTypes, Buffer[] with an encoding option, ...);
            // sweepAgyHookCarriers only ever calls the plain string[] form, so
            // the cast below pins the mock to that one overload rather than
            // fighting the union.
            vi.mocked(readdir).mockImplementationOnce((async (path: string) => {
                // readdirSync (already imported from node:fs for the rest of
                // this file) captures the real, unmodified directory listing
                // FIRST -- this is the actual snapshot sweepAgyHookCarriers
                // will iterate over -- then signals the test it is safe to
                // create a new (would-otherwise-qualify) carrier, and only
                // returns the already-captured (now stale) array once
                // released.
                const result = readdirSync(path);
                markSnapshotTaken();
                await gate;
                return result;
            }) as typeof readdir);

            const sweepPromise = sweepAgyHookCarriers();
            await snapshotTaken;

            const deadPid = await spawnAndReapDeadPid();
            const carrierDir = makeCarrierDir('created-after-snapshot');
            writeFileSync(
                join(carrierDir, 'owner.json'),
                // Matching scope + confirmed-dead pid: exactly the
                // combination test ③ proves gets deleted for a carrier that
                // WAS in the snapshot.
                JSON.stringify({ pid: deadPid, scope: computeLocalCarrierScope() })
            );

            releaseGate();
            await sweepPromise;

            // Fails (mutation check: capture the snapshot lazily / re-read
            // the directory mid-loop) if a carrier created after the
            // snapshot was taken ever gets examined, let alone deleted.
            expect(existsSync(carrierDir)).toBe(true);
        });

        it('reads the directory listing before resolving the local scope — not just an outcome, the actual call order', async () => {
            // hostile-review round 1 finding ③: the test above only proves
            // "a carrier created after the snapshot is invisible", which a
            // reversed implementation (resolve scope, THEN readdir) could
            // also satisfy by coincidence in a synchronous mock. This
            // asserts the call order directly so reversing the two
            // statements in sweepAgyHookCarriers fails this test even if it
            // doesn't happen to break the outcome-based one above.
            makeCarrierDir('baseline-existing');
            const callOrder: string[] = [];

            vi.mocked(readdir).mockImplementationOnce((async (path: string) => {
                callOrder.push('readdir');
                return readdirSync(path);
            }) as typeof readdir);
            const probe: ScopeProbe = {
                readBootId: () => { callOrder.push('scope-probe'); return 'boot-id'; },
                readPidNamespaceId: () => '1',
                hostname: () => 'irrelevant',
            };

            await sweepAgyHookCarriers(probe);

            // Fails (mutation check: swap the readdir()/resolveLocalCarrierScope()
            // statements in sweepAgyHookCarriers) if the scope probe ever
            // runs before the directory snapshot is taken.
            expect(callOrder).toEqual(['readdir', 'scope-probe']);
        });

        it('preserves this session\'s own real carrier if prepareAgyHookCarrier() creates it while an in-flight sweep has already snapshotted the directory', async () => {
            // See the previous test: a carrier must already exist so
            // agy-carriers/ itself exists by the time sweep's readdir() runs.
            makeCarrierDir('baseline-existing');

            let releaseGate: () => void = () => {};
            const gate = new Promise<void>((resolve) => { releaseGate = resolve; });
            let markSnapshotTaken: () => void = () => {};
            const snapshotTaken = new Promise<void>((resolve) => { markSnapshotTaken = resolve; });

            vi.mocked(readdir).mockImplementationOnce((async (path: string) => {
                const result = readdirSync(path);
                markSnapshotTaken();
                await gate;
                return result;
            }) as typeof readdir);

            const sweepPromise = sweepAgyHookCarriers();
            await snapshotTaken;

            // The real production entrypoint (runAgy.ts/agyPtyLauncher.ts),
            // not the hand-built makeCarrierDir helper -- proves the actual
            // API used in production is safe under this race, not just a
            // synthetic fixture that resembles it.
            const ownCarrier = prepareAgyHookCarrier('{}');
            expect(ownCarrier).toBeDefined();
            if (!ownCarrier) return;

            try {
                releaseGate();
                await sweepPromise;

                expect(existsSync(ownCarrier.carrierDir)).toBe(true);
            } finally {
                cleanupAgyHookCarrier(ownCarrier.carrierDir);
            }
        });
    });
});
