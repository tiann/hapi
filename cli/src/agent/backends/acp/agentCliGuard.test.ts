import { existsSync, mkdirSync, readFileSync, readdirSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir, tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import {
    _resetAgentCliGuardForTests,
    _setActiveAcpTransportCountForTests,
    _setAddLockPidHookForTests,
    _setRegisterPublishHookForTests,
    getAgentAcpLockDir,
    isAgentAcpTransportActive,
    recordActiveAcpChildPid,
    registerActiveAcpTransport,
    unregisterActiveAcpTransport
} from './agentCliGuard';
import {
    releaseAgentCliSpawnLeaseFromAcpRegisterSync,
    releaseAgentCliSpawnLeaseSync,
    tryAcquireAgentCliSpawnLeaseSync
} from '@hapi/protocol/agentCliSpawnLease';

const testHome = join(tmpdir(), `hapi-agent-cli-guard-${process.pid}`);

function lockDir(): string {
    return join(testHome, 'locks', 'agent-acp-active');
}

function writeTestAcpLock(args: { count: number; pids: number[] }): void {
    const dir = lockDir();
    mkdirSync(join(dir, 'pids'), { recursive: true });
    writeFileSync(join(dir, 'count'), String(args.count), 'utf8');
    for (const pid of args.pids) {
        writeFileSync(join(dir, 'pids', String(pid)), String(pid), 'utf8');
    }
}

function writeLegacyAcpLock(pid: number): void {
    const dir = lockDir();
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, 'pid'), String(pid), 'utf8');
}

describe('agentCliGuard', () => {
    const previousHome = process.env.HAPI_HOME;

    afterEach(() => {
        // Always tear down under the isolated test home — never while HAPI_HOME
        // is unset (that would resolve ~/.hapi and could wipe a live ACP guard).
        process.env.HAPI_HOME = testHome;
        _resetAgentCliGuardForTests();
        if (previousHome === undefined) {
            delete process.env.HAPI_HOME;
        } else {
            process.env.HAPI_HOME = previousHome;
        }
    });

    test('treats in-process ACP transport as active', () => {
        process.env.HAPI_HOME = testHome;
        registerActiveAcpTransport();
        expect(isAgentAcpTransportActive()).toBe(true);
        unregisterActiveAcpTransport();
        expect(isAgentAcpTransportActive()).toBe(false);
    });

    test('does not hold spawn lease for the full register lifetime', () => {
        process.env.HAPI_HOME = testHome;
        registerActiveAcpTransport();
        expect(tryAcquireAgentCliSpawnLeaseSync(testHome)).toBe(true);
        releaseAgentCliSpawnLeaseSync();
        unregisterActiveAcpTransport();
    });

    test('keeps cross-process lock until the last transport unregisters', () => {
        process.env.HAPI_HOME = testHome;
        registerActiveAcpTransport();
        registerActiveAcpTransport();

        unregisterActiveAcpTransport();
        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(lockDir())).toBe(true);

        unregisterActiveAcpTransport();
        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(lockDir())).toBe(false);
    });

    test('leaves refcount at one after the first of two in-process unregisters', () => {
        process.env.HAPI_HOME = testHome;
        registerActiveAcpTransport();
        registerActiveAcpTransport();

        const dir = lockDir();
        unregisterActiveAcpTransport();

        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(dir)).toBe(true);
        expect(existsSync(join(dir, 'pids', String(process.pid)))).toBe(true);
    });

    test('clears stale cross-process lock when pid is not running', () => {
        process.env.HAPI_HOME = testHome;
        writeLegacyAcpLock(99999999);

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(lockDir())).toBe(false);
    });

    test('keeps legacy lock when pid file points at a live process', () => {
        process.env.HAPI_HOME = testHome;
        writeLegacyAcpLock(process.pid);

        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(lockDir())).toBe(true);
    });

    test('clears refcount lock when pid entries are missing or invalid', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'count'), '1', 'utf8');
        // Age the lock past the pre-spawn grace so missing pids is truly stale.
        const aged = Date.now() - 60_000;
        utimesSync(dir, aged / 1000, aged / 1000);

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(dir)).toBe(false);
    });

    test('keeps a fresh count-without-pids lock fail-closed during pre-spawn grace', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'count'), '1', 'utf8');
        _setActiveAcpTransportCountForTests(0);

        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(dir)).toBe(true);
    });

    test('clears refcount lock when all pid entries are stale', () => {
        process.env.HAPI_HOME = testHome;
        writeTestAcpLock({ count: 2, pids: [99999998, 99999999] });

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(lockDir())).toBe(false);
    });

    test('reconciles refcount lock down to live pid entries', () => {
        process.env.HAPI_HOME = testHome;
        writeTestAcpLock({ count: 3, pids: [process.pid, 99999999] });

        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(lockDir())).toBe(true);
    });

    test('records the ACP child PID when provided, not only the HAPI host PID', () => {
        process.env.HAPI_HOME = testHome;
        // Distinct from process.pid so host + child markers are both asserted.
        const childPid = process.pid + 1_000_000;
        registerActiveAcpTransport({ childPid });

        const dir = lockDir();
        expect(existsSync(join(dir, 'pids', String(process.pid)))).toBe(true);
        expect(existsSync(join(dir, 'pids', String(childPid)))).toBe(true);
        expect(readFileSync(join(dir, 'child-pid'), 'utf8').trim()).toBe(String(childPid));

        unregisterActiveAcpTransport({ childPid });
        expect(existsSync(dir)).toBe(false);
    });

    test('recordActiveAcpChildPid upgrades a pre-spawn reservation to the real child PID', () => {
        process.env.HAPI_HOME = testHome;
        registerActiveAcpTransport();
        const childPid = process.pid + 1_000_001;
        recordActiveAcpChildPid(childPid);

        const dir = lockDir();
        expect(existsSync(join(dir, 'pids', String(process.pid)))).toBe(true);
        expect(existsSync(join(dir, 'pids', String(childPid)))).toBe(true);
        expect(readFileSync(join(dir, 'child-pid'), 'utf8').trim()).toBe(String(childPid));
        expect(isAgentAcpTransportActive()).toBe(true);

        unregisterActiveAcpTransport({ childPid });
        expect(isAgentAcpTransportActive()).toBe(false);
    });

    test('uses ~/.hapi lock home when HAPI_HOME is unset (not /tmp/hapi)', () => {
        delete process.env.HAPI_HOME;
        try {
            const expected = join(homedir(), '.hapi', 'locks', 'agent-acp-active');
            expect(getAgentAcpLockDir()).toBe(expected);
            expect(getAgentAcpLockDir()).not.toContain(join(tmpdir(), 'hapi'));
        } finally {
            // Restore isolated home before afterEach reset (belt + suspenders).
            process.env.HAPI_HOME = testHome;
        }
    });

    test('publishes host pid marker before count so mid-register readers stay active', () => {
        process.env.HAPI_HOME = testHome;
        const steps: string[] = [];
        _setRegisterPublishHookForTests((step) => {
            steps.push(step);
            if (step === 'after-host-pid') {
                // Cross-process reader: no in-process reservation yet for them.
                _setActiveAcpTransportCountForTests(0);
                expect(existsSync(join(lockDir(), 'pids', String(process.pid)))).toBe(true);
                expect(existsSync(join(lockDir(), 'count'))).toBe(false);
                expect(isAgentAcpTransportActive()).toBe(true);
                expect(existsSync(lockDir())).toBe(true);
            }
            if (step === 'after-mkdir') {
                _setActiveAcpTransportCountForTests(0);
                // Grace keeps the mkdir-only reservation fail-closed.
                expect(isAgentAcpTransportActive()).toBe(true);
                expect(existsSync(lockDir())).toBe(true);
            }
        });

        registerActiveAcpTransport();
        expect(steps).toEqual(['after-mkdir', 'after-host-pid', 'after-count']);
        expect(isAgentAcpTransportActive()).toBe(true);
        _setRegisterPublishHookForTests(null);
        unregisterActiveAcpTransport();
    });

    test('host-pid-without-count reservation is not cleared as stale by reconcile', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(join(dir, 'pids'), { recursive: true });
        writeFileSync(join(dir, 'pids', String(process.pid)), String(process.pid), 'utf8');
        // No count file — the old race window after count-before-pids, inverted.
        _setActiveAcpTransportCountForTests(0);

        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(dir)).toBe(true);
        expect(existsSync(join(dir, 'pids', String(process.pid)))).toBe(true);
    });

    test('empty pids/ mid-addLockPid stays active for concurrent readers', () => {
        process.env.HAPI_HOME = testHome;
        let sawEmptyPids = false;
        _setAddLockPidHookForTests((phase) => {
            if (phase !== 'after-pids-mkdir') {
                return;
            }
            sawEmptyPids = true;
            _setActiveAcpTransportCountForTests(0);
            const dir = lockDir();
            expect(existsSync(join(dir, 'pids'))).toBe(true);
            expect(existsSync(join(dir, 'count'))).toBe(false);
            expect(readdirSync(join(dir, 'pids'))).toEqual([]);
            expect(existsSync(join(dir, 'registering', String(process.pid)))).toBe(true);
            expect(isAgentAcpTransportActive()).toBe(true);
            expect(existsSync(dir)).toBe(true);
        });

        registerActiveAcpTransport();
        expect(sawEmptyPids).toBe(true);
        _setAddLockPidHookForTests(null);
        unregisterActiveAcpTransport();
        expect(isAgentAcpTransportActive()).toBe(false);
    });

    test('last unregister does not erase concurrent mid-addLockPid registration', () => {
        process.env.HAPI_HOME = testHome;
        registerActiveAcpTransport();
        expect(readFileSync(join(lockDir(), 'count'), 'utf8')).toBe('1');

        let sawRace = false;
        _setAddLockPidHookForTests((phase) => {
            if (phase !== 'after-pids-mkdir') {
                return;
            }
            sawRace = true;
            // Prior transport's last unregister while the new registrar has
            // empty-or-about-to-rewrite pids/ and a live `registering/<pid>`.
            // Force last-unregister semantics (in-process count → 0).
            _setActiveAcpTransportCountForTests(1);
            unregisterActiveAcpTransport();
            expect(existsSync(join(lockDir(), 'registering', String(process.pid)))).toBe(true);
            _setActiveAcpTransportCountForTests(0);
            expect(isAgentAcpTransportActive()).toBe(true);
            expect(existsSync(lockDir())).toBe(true);
        });

        registerActiveAcpTransport();
        expect(sawRace).toBe(true);
        _setAddLockPidHookForTests(null);
        _setActiveAcpTransportCountForTests(1);
        expect(existsSync(join(lockDir(), 'pids', String(process.pid)))).toBe(true);
        expect(existsSync(join(lockDir(), 'registering', String(process.pid)))).toBe(false);
        expect(isAgentAcpTransportActive()).toBe(true);
        unregisterActiveAcpTransport();
        expect(isAgentAcpTransportActive()).toBe(false);
    });

    test('prunes crash-stale registering/<deadPid> so list-models is not pinned', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(join(dir, 'registering'), { recursive: true });
        mkdirSync(join(dir, 'pids'), { recursive: true });
        writeFileSync(join(dir, 'count'), '1', 'utf8');
        // Unlikely-to-be-alive PID — marker left by SIGKILL mid-publish.
        writeFileSync(join(dir, 'registering', '999999'), '1', 'utf8');
        _setActiveAcpTransportCountForTests(0);

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(dir)).toBe(false);
    });
});
