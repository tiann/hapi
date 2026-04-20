import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    child: null as (EventEmitter & {
        stdout: EventEmitter & { setEncoding: (encoding: string) => void };
        stderr: EventEmitter & { setEncoding: (encoding: string) => void };
        stdin: { end: () => void };
    }) | null,
    killCalls: 0
}));

vi.mock('node:child_process', () => ({
    spawn: vi.fn(() => {
        const child = new EventEmitter() as EventEmitter & {
            stdout: EventEmitter & { setEncoding: (encoding: string) => void };
            stderr: EventEmitter & { setEncoding: (encoding: string) => void };
            stdin: { end: () => void };
        };
        child.stdout = Object.assign(new EventEmitter(), { setEncoding: () => {} });
        child.stderr = Object.assign(new EventEmitter(), { setEncoding: () => {} });
        child.stdin = { end: vi.fn() };
        harness.child = child;
        return child;
    })
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async (child: EventEmitter) => {
        harness.killCalls += 1;
        child.emit('exit', 0, null);
    })
}));

import { CodexAppServerClient } from './codexAppServerClient';

describe('CodexAppServerClient disconnect handler', () => {
    afterEach(() => {
        harness.child = null;
        harness.killCalls = 0;
    });

    it('notifies once when the app-server exits unexpectedly', async () => {
        const client = new CodexAppServerClient();
        let disconnects = 0;
        client.setDisconnectHandler(() => {
            disconnects += 1;
        });

        await client.connect();
        harness.child?.emit('exit', 1, null);

        expect(disconnects).toBe(1);
    });

    it('does not notify the disconnect handler during intentional shutdown', async () => {
        const client = new CodexAppServerClient();
        let disconnects = 0;
        client.setDisconnectHandler(() => {
            disconnects += 1;
        });

        await client.connect();
        await client.disconnect();

        expect(harness.killCalls).toBe(1);
        expect(disconnects).toBe(0);
    });
});
