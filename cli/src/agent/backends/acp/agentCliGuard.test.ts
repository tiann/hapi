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

    test('clears stale cross-process lock when pid is not running', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pid'), '99999999');

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(dir)).toBe(false);
    });

    test('keeps lock when pid file points at a live process', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(dir, { recursive: true });
        writeFileSync(join(dir, 'pid'), String(process.pid));

        expect(isAgentAcpTransportActive()).toBe(true);
        expect(existsSync(dir)).toBe(true);
    });

    test('clears lock when pid file is missing or invalid', () => {
        process.env.HAPI_HOME = testHome;
        const dir = lockDir();
        mkdirSync(dir, { recursive: true });

        expect(isAgentAcpTransportActive()).toBe(false);
        expect(existsSync(dir)).toBe(false);
    });
});
