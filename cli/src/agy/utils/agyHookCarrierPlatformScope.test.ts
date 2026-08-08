import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    _resetCarrierScopeCacheForTests,
    cleanupAgyHookCarrier,
    parseIoregPlatformUUID,
    parseSysctlBootSessionUUID,
    prepareAgyHookCarrier,
    sweepAgyHookCarriers,
    warmCarrierScope,
    type ScopeProbe
} from './agyHookCarrier';

/**
 * Spawns a real child process, waits for it to exit, and returns its PID --
 * mirrors agyHookCarrier.test.ts's helper of the same shape (a genuinely
 * dead pid, not a made-up one that could collide with a live process).
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

function stubPlatform(value: NodeJS.Platform): () => void {
    const original = process.platform;
    Object.defineProperty(process, 'platform', { value, configurable: true });
    return () => {
        Object.defineProperty(process, 'platform', { value: original, configurable: true });
    };
}

// Throwing stubs for the Linux-only probe fields -- every ScopeProbe object
// below targets darwin (or an unrecognized platform), so these must never
// actually be invoked; a throw makes an accidental Linux-path call fail
// loudly instead of silently returning a bogus scope.
const unusedLinuxFields = {
    readBootId: (): string => { throw new Error('not used on this platform'); },
    readPidNamespaceId: (): string => { throw new Error('not used on this platform'); },
    hostname: (): string => { throw new Error('not used on this platform'); },
};

/** Isolates HAPI_HOME under a fresh mkdtemp dir so prepareAgyHookCarrier()
 * never writes into the worker's shared config.tmpHome (hostile-review round
 * 1 finding ⑦). Call from beforeEach/afterEach in every describe block that
 * touches the filesystem via prepareAgyHookCarrier/sweepAgyHookCarriers. */
function useIsolatedHapiHome(): { customHapiHome(): string } {
    let previousHapiHome: string | undefined;
    let customHapiHome: string;

    beforeEach(() => {
        previousHapiHome = process.env.HAPI_HOME;
        customHapiHome = mkdtempSync(join(tmpdir(), 'hapi-phase2b-platform-home-'));
        process.env.HAPI_HOME = customHapiHome;
    });

    afterEach(() => {
        if (previousHapiHome === undefined) delete process.env.HAPI_HOME;
        else process.env.HAPI_HOME = previousHapiHome;
        rmSync(customHapiHome, { recursive: true, force: true });
    });

    return { customHapiHome: () => customHapiHome };
}

describe('parseIoregPlatformUUID (Phase 1 real capture)', () => {
    it('extracts IOPlatformUUID from a real ioreg -rd1 -c IOPlatformExpertDevice capture', () => {
        const sample = [
            '+-o Mac-1234567890ABCDEF  <class IOPlatformExpertDevice, id 0x100000000, registered, matched, active, busy 0 (0 ms), retain 40>',
            '    {',
            '      "IOPlatformUUID" = "D8F7807A-6B93-57A4-9DF2-E9A54FA2E046"',
            '      "IOPlatformSerialNumber" = "FVFXC1234567"',
            '    }',
        ].join('\n');
        expect(parseIoregPlatformUUID(sample)).toBe('D8F7807A-6B93-57A4-9DF2-E9A54FA2E046');
    });

    it('returns undefined for output with no IOPlatformUUID key (unexpected ioreg version/format)', () => {
        expect(parseIoregPlatformUUID('some unrelated ioreg output\nwith no matching key\n')).toBeUndefined();
    });

    it('returns undefined if the captured value is not UUID-shaped (defensive against a malformed/truncated capture)', () => {
        expect(parseIoregPlatformUUID('"IOPlatformUUID" = "not-a-uuid"')).toBeUndefined();
    });
});

describe('parseSysctlBootSessionUUID (Phase 1 real capture, 2026-08-07 correction)', () => {
    it('accepts a real sysctl -n kern.bootsessionuuid capture (bare UUID, trailing newline)', () => {
        expect(parseSysctlBootSessionUUID('76A5605C-FF4D-4B31-80D8-239964198B7D\n')).toBe('76A5605C-FF4D-4B31-80D8-239964198B7D');
    });

    it('returns undefined for non-UUID output (unexpected sysctl error text, e.g. "sysctl: unknown oid")', () => {
        expect(parseSysctlBootSessionUUID('sysctl: unknown oid \'kern.bootsessionuuid\'\n')).toBeUndefined();
    });
});

describe('platform scope dispatch (Phase 2-B)', () => {
    useIsolatedHapiHome();
    let restorePlatform: (() => void) | undefined;

    beforeEach(() => {
        _resetCarrierScopeCacheForTests();
    });

    afterEach(() => {
        restorePlatform?.();
        restorePlatform = undefined;
        _resetCarrierScopeCacheForTests();
    });

    it('computes darwin:<uuid>:<bootSessionId> from injected probe functions, end-to-end through prepareAgyHookCarrier', async () => {
        restorePlatform = stubPlatform('darwin');
        const probe: ScopeProbe = {
            ...unusedLinuxFields,
            readDarwinMachineId: async () => 'D8F7807A-6B93-57A4-9DF2-E9A54FA2E046',
            readDarwinBootSessionId: async () => '76A5605C-FF4D-4B31-80D8-239964198B7D',
        };
        await warmCarrierScope(probe);

        const carrier = prepareAgyHookCarrier('{}');
        try {
            expect(carrier).toBeDefined();
            if (!carrier) return;
            const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
            expect(owner.scope).toBe('darwin:D8F7807A-6B93-57A4-9DF2-E9A54FA2E046:76A5605C-FF4D-4B31-80D8-239964198B7D');
        } finally {
            cleanupAgyHookCarrier(carrier?.carrierDir);
        }
    });

    it('falls back to undefined (preserved, empty-string owner scope) when the darwin boot-session probe fails, even if the machine-id probe succeeds', async () => {
        restorePlatform = stubPlatform('darwin');
        const probe: ScopeProbe = {
            ...unusedLinuxFields,
            readDarwinMachineId: async () => 'D8F7807A-6B93-57A4-9DF2-E9A54FA2E046',
            readDarwinBootSessionId: async () => { throw new Error('sysctl timed out'); },
        };
        await warmCarrierScope(probe);

        const carrier = prepareAgyHookCarrier('{}');
        try {
            expect(carrier).toBeDefined();
            if (!carrier) return;
            const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
            expect(owner.scope).toBe('');
        } finally {
            cleanupAgyHookCarrier(carrier?.carrierDir);
        }
    });

    it('falls back to undefined without calling any probe on a platform this module does not recognize', async () => {
        restorePlatform = stubPlatform('sunos' as NodeJS.Platform);
        const readDarwinMachineId = vi.fn(async () => 'should-not-be-called');
        const probe: ScopeProbe = { ...unusedLinuxFields, readDarwinMachineId };
        await warmCarrierScope(probe);

        const carrier = prepareAgyHookCarrier('{}');
        try {
            expect(carrier).toBeDefined();
            if (!carrier) return;
            const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
            expect(owner.scope).toBe('');
            expect(readDarwinMachineId).not.toHaveBeenCalled();
        } finally {
            cleanupAgyHookCarrier(carrier?.carrierDir);
        }
    });

    it('resolves to undefined on win32 with no weak-identity fallback (dispatch falls through the same "unrecognized platform" branch as sunos above -- there is no windows-specific ScopeProbe field left to inject)', async () => {
        restorePlatform = stubPlatform('win32');
        // No windows-specific field exists on ScopeProbe anymore -- win32
        // now takes the same "unrecognized platform" branch as 'sunos'
        // above, so there is nothing platform-specific to inject; the
        // Linux-only fields being unused (and throwing if touched) is
        // exactly what this pins.
        await warmCarrierScope(unusedLinuxFields);

        const carrier = prepareAgyHookCarrier('{}');
        try {
            expect(carrier).toBeDefined();
            if (!carrier) return;
            const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
            expect(owner.scope).toBe('');
        } finally {
            cleanupAgyHookCarrier(carrier?.carrierDir);
        }
    });

    it('never produces colliding scope strings between linux and darwin, even fed the exact same raw id components', async () => {
        const sameRawId = 'AAAAAAAA-AAAA-AAAA-AAAA-AAAAAAAAAAAA';
        let linuxCarrier: ReturnType<typeof prepareAgyHookCarrier>;
        let darwinCarrier: ReturnType<typeof prepareAgyHookCarrier>;
        try {
            restorePlatform = stubPlatform('linux');
            await warmCarrierScope({
                readBootId: () => sameRawId,
                readPidNamespaceId: () => sameRawId,
                hostname: () => 'irrelevant',
            });
            linuxCarrier = prepareAgyHookCarrier('{}');
            expect(linuxCarrier).toBeDefined();
            restorePlatform();
            _resetCarrierScopeCacheForTests();

            restorePlatform = stubPlatform('darwin');
            await warmCarrierScope({
                ...unusedLinuxFields,
                readDarwinMachineId: async () => sameRawId,
                readDarwinBootSessionId: async () => sameRawId,
            });
            darwinCarrier = prepareAgyHookCarrier('{}');
            expect(darwinCarrier).toBeDefined();

            if (!linuxCarrier || !darwinCarrier) return;
            const linuxOwner = JSON.parse(readFileSync(join(linuxCarrier.carrierDir, 'owner.json'), 'utf8'));
            const darwinOwner = JSON.parse(readFileSync(join(darwinCarrier.carrierDir, 'owner.json'), 'utf8'));
            expect(linuxOwner.scope).not.toBe(darwinOwner.scope);
            expect(linuxOwner.scope).toBe(`linux:${sameRawId}:${sameRawId}`);
            expect(darwinOwner.scope).toBe(`darwin:${sameRawId}:${sameRawId}`);
        } finally {
            cleanupAgyHookCarrier(linuxCarrier?.carrierDir);
            cleanupAgyHookCarrier(darwinCarrier?.carrierDir);
        }
    });
});

describe('warmCarrierScope memoization', () => {
    let restorePlatform: (() => void) | undefined;

    beforeEach(() => {
        _resetCarrierScopeCacheForTests();
    });

    afterEach(() => {
        restorePlatform?.();
        restorePlatform = undefined;
        _resetCarrierScopeCacheForTests();
    });

    it('computes the scope only once across repeated warm calls with the same probe', async () => {
        restorePlatform = stubPlatform('darwin');
        const readDarwinMachineId = vi.fn(async () => 'D8F7807A-6B93-57A4-9DF2-E9A54FA2E046');
        const readDarwinBootSessionId = vi.fn(async () => '76A5605C-FF4D-4B31-80D8-239964198B7D');
        const probe: ScopeProbe = { ...unusedLinuxFields, readDarwinMachineId, readDarwinBootSessionId };

        await warmCarrierScope(probe);
        await warmCarrierScope(probe);
        await warmCarrierScope(probe);

        expect(readDarwinMachineId).toHaveBeenCalledTimes(1);
        expect(readDarwinBootSessionId).toHaveBeenCalledTimes(1);
    });

    it('also memoizes a failed probe (does not retry on every warm call)', async () => {
        restorePlatform = stubPlatform('darwin');
        const readDarwinMachineId = vi.fn(async () => { throw new Error('ioreg not found'); });
        const readDarwinBootSessionId = vi.fn(async () => '76A5605C-FF4D-4B31-80D8-239964198B7D');
        const probe: ScopeProbe = { ...unusedLinuxFields, readDarwinMachineId, readDarwinBootSessionId };

        await warmCarrierScope(probe);
        await warmCarrierScope(probe);

        expect(readDarwinMachineId).toHaveBeenCalledTimes(1);
    });

    it('never rejects even when every probe throws', async () => {
        restorePlatform = stubPlatform('darwin');
        const probe: ScopeProbe = {
            ...unusedLinuxFields,
            readDarwinMachineId: async () => { throw new Error('boom'); },
            readDarwinBootSessionId: async () => { throw new Error('boom'); },
        };
        await expect(warmCarrierScope(probe)).resolves.toBeUndefined();
    });
});

describe('sweepAgyHookCarriers platform branches (Phase 2-B, mutation resistance)', () => {
    let previousHapiHome: string | undefined;
    let customHapiHome: string;
    let restorePlatform: (() => void) | undefined;

    beforeEach(() => {
        previousHapiHome = process.env.HAPI_HOME;
        customHapiHome = mkdtempSync(join(tmpdir(), 'hapi-phase2b-sweep-home-'));
        process.env.HAPI_HOME = customHapiHome;
    });

    afterEach(() => {
        restorePlatform?.();
        restorePlatform = undefined;
        _resetCarrierScopeCacheForTests();
        if (previousHapiHome === undefined) delete process.env.HAPI_HOME;
        else process.env.HAPI_HOME = previousHapiHome;
        rmSync(customHapiHome, { recursive: true, force: true });
    });

    const CARRIER_PREFIX = 'hapi-agy-carrier-';

    function makeCarrierDir(name: string): string {
        const root = join(customHapiHome, 'agy-carriers');
        mkdirSync(root, { recursive: true });
        const carrierDir = join(root, `${CARRIER_PREFIX}${name}`);
        mkdirSync(join(carrierDir, '.agents'), { recursive: true });
        writeFileSync(join(carrierDir, '.agents', 'hooks.json'), '{}');
        return carrierDir;
    }

    // This is the "not vacuous" proof the plan's mutation-testing gate
    // requires for the one remaining real platform branch: it proves darwin
    // can actually DELETE (an observable, dangerous outcome), not merely
    // that it fails safely into "preserve" -- a bug that always returned
    // undefined would make every OTHER platform test above pass (everything
    // preserved looks identical to "working"), but would make this one fail.
    it('sweeps a darwin-scoped carrier whose owner has died (proves the branch actually deletes)', async () => {
        restorePlatform = stubPlatform('darwin');
        const deadPid = await spawnAndReapDeadPid();
        const carrierDir = makeCarrierDir('darwin-dead-owner');
        const scope = 'darwin:D8F7807A-6B93-57A4-9DF2-E9A54FA2E046:76A5605C-FF4D-4B31-80D8-239964198B7D';
        writeFileSync(join(carrierDir, 'owner.json'), JSON.stringify({ pid: deadPid, scope }));

        const probe: ScopeProbe = {
            ...unusedLinuxFields,
            readDarwinMachineId: async () => 'D8F7807A-6B93-57A4-9DF2-E9A54FA2E046',
            readDarwinBootSessionId: async () => '76A5605C-FF4D-4B31-80D8-239964198B7D',
        };
        await sweepAgyHookCarriers(probe);

        expect(existsSync(carrierDir)).toBe(false);
    });

    it('preserves a darwin-scoped carrier whose owner is alive', async () => {
        restorePlatform = stubPlatform('darwin');
        const carrierDir = makeCarrierDir('darwin-alive-owner');
        const scope = 'darwin:D8F7807A-6B93-57A4-9DF2-E9A54FA2E046:76A5605C-FF4D-4B31-80D8-239964198B7D';
        writeFileSync(join(carrierDir, 'owner.json'), JSON.stringify({ pid: process.pid, scope }));

        const probe: ScopeProbe = {
            ...unusedLinuxFields,
            readDarwinMachineId: async () => 'D8F7807A-6B93-57A4-9DF2-E9A54FA2E046',
            readDarwinBootSessionId: async () => '76A5605C-FF4D-4B31-80D8-239964198B7D',
        };
        await sweepAgyHookCarriers(probe);

        expect(existsSync(carrierDir)).toBe(true);
    });

    // What this pins: win32 cannot resolve a scope at all (no ScopeProbe
    // field exists to feed it one — see the test below), so
    // resolveLocalCarrierScope() returns undefined and sweepAgyHookCarriers
    // bails out before examining the directory listing at all (the
    // `if (!localScope) return` early exit in agyHookCarrier.ts) — every
    // carrier under HAPI_HOME is preserved on win32, this one included.
    //
    // What this does NOT pin (hostile-review round 2 correction): a
    // "regression guard" in the sense of "this would have been deleted by
    // the pre-fix code, and now it is not." That claim was checked here
    // previously and was false — the pre-fix readWin32Scope already started
    // with `if (!probe.readWin32MachineId) return undefined;`, and the
    // probe below has no such field, so this exact carrier was ALWAYS
    // preserved, before this file's Windows support existed and after it
    // was removed alike. A genuine before/after regression test is not
    // constructible here: it would need either a real `reg.exe` (not
    // present on Linux CI) or the now-deleted `readWin32MachineId` seam to
    // inject a fake one, and the seam is gone specifically so this can't be
    // done by accident. The actual binding constraint against re-adding
    // Windows support is computeLocalCarrierScopeAsync's docstring, not
    // this test — this test only pins the (correct, current) win32
    // preserve-everything behavior as a fact about the present code.
    it('preserves a win32-scoped carrier with a dead owner pid (win32 cannot resolve any scope, so sweep bails out before examining anything)', async () => {
        restorePlatform = stubPlatform('win32');
        const deadPid = await spawnAndReapDeadPid();
        const carrierDir = makeCarrierDir('win32-would-be-dead-owner');
        const scope = 'win32:7a910be3-c121-47aa-a3a1-426ae6bd5ca8';
        writeFileSync(join(carrierDir, 'owner.json'), JSON.stringify({ pid: deadPid, scope }));

        await sweepAgyHookCarriers(unusedLinuxFields);

        expect(existsSync(carrierDir)).toBe(true);
    });

    // The structural counterpart to the behavioral test above: there is no
    // ScopeProbe field left to construct a win32 probe with, so a future
    // reintroduction of Windows support that forgets to update BOTH the
    // type and computeLocalCarrierScopeAsync's dispatch would be caught
    // here at typecheck time (this file failing `bun run typecheck`, not a
    // runtime assertion) the moment the field comes back without a
    // corresponding removal of this @ts-expect-error.
    it('has no injectable win32 field on ScopeProbe (compile-time regression guard)', () => {
        // @ts-expect-error -- readWin32MachineId does not exist on
        // ScopeProbe. If it starts existing again, this directive itself
        // becomes an unused "@ts-expect-error" compile error.
        const probe: ScopeProbe = { ...unusedLinuxFields, readWin32MachineId: async () => 'x' };
        void probe;
    });
});

describe('real defaultScopeProbe (smoke test, no macOS tooling on this Linux host)', () => {
    // This cannot validate the SUCCESS/parsing path against the real OS
    // tools (that needs Phase 3's live macOS verification, out of this
    // task's scope) -- but it does exercise the real execFile-based
    // implementation end-to-end on THIS host, where /usr/sbin/ioreg and
    // /usr/sbin/sysctl -n kern.bootsessionuuid (macOS-only oid) either don't
    // exist or don't behave the same way, proving the real probe resolves
    // to undefined (via ENOENT/non-matching output) rather than hanging or
    // throwing unhandled. Windows has no probe left to smoke-test (see
    // computeLocalCarrierScopeAsync's docstring) -- the win32 case is
    // already covered above as a pure dispatch/bailout test, not a
    // real-execFile smoke test, since there is no execFile call on that
    // path anymore.
    useIsolatedHapiHome();
    let restorePlatform: (() => void) | undefined;

    beforeEach(() => {
        _resetCarrierScopeCacheForTests();
    });

    afterEach(() => {
        restorePlatform?.();
        restorePlatform = undefined;
        _resetCarrierScopeCacheForTests();
    });

    it('resolves to undefined (never hangs, never throws) when stubbed to darwin on a non-macOS host', async () => {
        restorePlatform = stubPlatform('darwin');
        await expect(warmCarrierScope()).resolves.toBeUndefined();

        const carrier = prepareAgyHookCarrier('{}');
        try {
            expect(carrier).toBeDefined();
            if (!carrier) return;
            const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
            expect(owner.scope).toBe('');
        } finally {
            cleanupAgyHookCarrier(carrier?.carrierDir);
        }
    }, 10_000);
});
