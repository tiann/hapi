import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    _resetCarrierScopeCacheForTests,
    cleanupAgyHookCarrier,
    computeLocalCarrierScope,
    prepareAgyHookCarrier,
    warmCarrierScope,
    type ScopeProbe
} from './agyHookCarrier';

/**
 * Phase 2-B introduces a process-lifetime cache for computeLocalCarrierScope,
 * needed because the upcoming macOS/Windows probes are async child-process
 * calls that writeOwnerMetadata (synchronous, called from prepareAgyHookCarrier)
 * cannot await directly. This file exercises the cache mechanism itself using
 * only the existing Linux-shaped ScopeProbe fields -- no platform-specific
 * code exists yet at this commit (that lands in the next, feat, commit) --
 * so this is a pure structural addition: computeLocalCarrierScope()'s
 * observable output on this (Linux) test host is unchanged either way.
 */
describe('carrier scope cache (Phase 2-B infrastructure)', () => {
    beforeEach(() => {
        _resetCarrierScopeCacheForTests();
    });

    afterEach(() => {
        _resetCarrierScopeCacheForTests();
    });

    it('computes the scope only once across repeated warm calls with the same probe', async () => {
        const readBootId = vi.fn(() => 'cached-boot-id');
        const readPidNamespaceId = vi.fn(() => '999');
        const probe: ScopeProbe = { readBootId, readPidNamespaceId, hostname: () => 'irrelevant' };

        await warmCarrierScope(probe);
        await warmCarrierScope(probe);
        await warmCarrierScope(probe);

        expect(readBootId).toHaveBeenCalledTimes(1);
        expect(readPidNamespaceId).toHaveBeenCalledTimes(1);
    });

    it('a second warmCarrierScope call fired before the first has settled reuses the same in-flight probe (does not double-probe)', async () => {
        const callCount = vi.fn();
        const probe: ScopeProbe = {
            readBootId: () => { callCount(); return 'boot-id'; },
            readPidNamespaceId: () => '1',
            hostname: () => 'irrelevant',
        };

        // Both calls are fired before either has a chance to resolve --
        // Promise.all starts them in the same microtask turn.
        await Promise.all([warmCarrierScope(probe), warmCarrierScope(probe)]);
        expect(callCount).toHaveBeenCalledTimes(1);
    });

    it('memoizes a failed probe too -- does not retry on every warm call', async () => {
        const readBootId = vi.fn((): string => { throw new Error('boot id read failed'); });
        const probe: ScopeProbe = { readBootId, readPidNamespaceId: () => '1', hostname: () => 'irrelevant' };

        await warmCarrierScope(probe);
        await warmCarrierScope(probe);

        expect(readBootId).toHaveBeenCalledTimes(1);
    });

    it('never rejects, even when the probe throws', async () => {
        const probe: ScopeProbe = {
            readBootId: () => { throw new Error('boom'); },
            readPidNamespaceId: () => { throw new Error('boom'); },
            hostname: () => 'irrelevant',
        };
        await expect(warmCarrierScope(probe)).resolves.toBeUndefined();
    });

    describe('prepareAgyHookCarrier / writeOwnerMetadata consumption', () => {
        let previousHapiHome: string | undefined;
        let customHapiHome: string;

        beforeEach(() => {
            previousHapiHome = process.env.HAPI_HOME;
            customHapiHome = mkdtempSync(join(tmpdir(), 'hapi-phase2b-cache-home-'));
            process.env.HAPI_HOME = customHapiHome;
        });

        afterEach(() => {
            if (previousHapiHome === undefined) delete process.env.HAPI_HOME;
            else process.env.HAPI_HOME = previousHapiHome;
            rmSync(customHapiHome, { recursive: true, force: true });
        });

        it('reads a warm cache instead of recomputing (owner.json reflects the warmed value, not a fresh real-/proc read)', async () => {
            // A deliberately WRONG-looking but well-formed scope: if
            // writeOwnerMetadata ignored the cache and fell back to the real
            // sync Linux probe, the resulting owner.json would carry the
            // REAL linux:<bootId>:<ns> value instead, which can never equal
            // this fabricated one.
            const probe: ScopeProbe = {
                readBootId: () => 'fabricated-boot-id-not-the-real-one',
                readPidNamespaceId: () => '424242',
                hostname: () => 'irrelevant',
            };
            await warmCarrierScope(probe);

            const carrier = prepareAgyHookCarrier('{}');
            expect(carrier).toBeDefined();
            if (!carrier) return;
            try {
                const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
                expect(owner.scope).toBe('linux:fabricated-boot-id-not-the-real-one:424242');
                expect(owner.scope).not.toBe(computeLocalCarrierScope());
            } finally {
                cleanupAgyHookCarrier(carrier.carrierDir);
            }
        });

        it('falls back to the real synchronous computation when the cache was never warmed (unchanged Linux behavior)', () => {
            // No warmCarrierScope() call at all -- this is the existing,
            // pre-Phase-2-B code path (see agyHookCarrier.test.ts's Phase
            // 2.8 "writes owner metadata" test for the original assertion
            // this preserves).
            const carrier = prepareAgyHookCarrier('{}');
            expect(carrier).toBeDefined();
            if (!carrier) return;
            try {
                const owner = JSON.parse(readFileSync(join(carrier.carrierDir, 'owner.json'), 'utf8'));
                expect(owner.scope).toBe(computeLocalCarrierScope());
            } finally {
                cleanupAgyHookCarrier(carrier.carrierDir);
            }
        });
    });
});
