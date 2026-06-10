import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, test } from 'vitest';
import {
    _resetAgentCliGuardForTests,
    isAgentAcpTransportActive,
    registerActiveAcpTransport,
    unregisterActiveAcpTransport
} from './agentCliGuard';

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

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(dir)).toBe(false);
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
});
