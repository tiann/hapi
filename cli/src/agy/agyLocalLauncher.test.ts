import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>,
    launchImpl: null as null | ((opts: Record<string, unknown>) => Promise<void> | void)
}));

vi.mock('./agyLocal', () => ({
    agyLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts);
        await harness.launchImpl?.(opts);
    }
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {}
        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal);
            return 'exit';
        }
    }
}));

import { agyLocalLauncher } from './agyLocalLauncher';

function createSessionStub(logPath: string) {
    const foundSessionIds: string[] = [];
    return {
        session: {
            sessionId: null,
            path: '/tmp/hapi-agy-worktree',
            logPath,
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            getPermissionMode: () => 'safe-yolo',
            onSessionFound: (sessionId: string) => { foundSessionIds.push(sessionId); },
            sendSessionEvent: () => {},
            recordLocalLaunchFailure: () => {},
            queue: { size: () => 0, reset: () => {}, setOnMessage: () => {} },
            client: { rpcHandlerManager: { registerHandler: () => {} } }
        },
        foundSessionIds
    };
}

describe('agyLocalLauncher', () => {
    afterEach(() => {
        harness.launches = [];
        harness.launchImpl = null;
    });

    it('persists the native Antigravity conversation id observed in the local agy log', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-agy-local-launcher-'));
        const logPath = join(dir, 'hapi.log');
        const agyLogPath = `${logPath}.agy.log`;
        writeFileSync(agyLogPath, 'old Created conversation 11111111-1111-1111-1111-111111111111\n');
        harness.launchImpl = (opts) => {
            appendFileSync(String(opts.logFile), 'new Created conversation DE582684-D186-4170-81BA-982809B4E28A\n');
        };
        const { session, foundSessionIds } = createSessionStub(logPath);

        await agyLocalLauncher(session as never, {
            additionalDirectories: ['/tmp/extra'],
            model: 'Gemini 3.5 Flash (High)'
        });

        expect(harness.launches[0]?.logFile).toBe(agyLogPath);
        expect(foundSessionIds).toEqual(['de582684-d186-4170-81ba-982809b4e28a']);
    });

    it('does not overwrite the session id when a local launch emits no native conversation id', async () => {
        const dir = mkdtempSync(join(tmpdir(), 'hapi-agy-local-launcher-'));
        const logPath = join(dir, 'hapi.log');
        const { session, foundSessionIds } = createSessionStub(logPath);

        await agyLocalLauncher(session as never, {});

        expect(foundSessionIds).toEqual([]);
    });
});
