import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Metadata } from '@/api/types';

const harness = vi.hoisted(() => ({
    launcherOptions: null as null | {
        launch: (abortSignal: AbortSignal) => Promise<void>;
    },
    locatorOptions: null as null | {
        onLocated: (located: { sessionId: string; wirePath: string; statePath: string }) => void;
    },
    titleWatcherOptions: null as null | {
        statePath: string;
        onTitle: (title: string) => void;
    },
    titlesToEmit: [] as string[],
    locatorCleanup: vi.fn(async () => {}),
    scannerCleanup: vi.fn(async () => {}),
    titleWatcherCleanup: vi.fn(async () => {})
}));

vi.mock('./utils/kimiWireLocator', () => ({
    createKimiWireLocator: (options: typeof harness.locatorOptions) => {
        harness.locatorOptions = options;
        return {
            ready: Promise.resolve(),
            cleanup: harness.locatorCleanup
        };
    }
}));

vi.mock('./utils/kimiWireScanner', () => ({
    createKimiWireScanner: async () => ({ cleanup: harness.scannerCleanup }),
    convertKimiWireEvent: () => null
}));

vi.mock('./utils/kimiSessionTitleWatcher', () => ({
    createKimiSessionTitleWatcher: async (options: NonNullable<typeof harness.titleWatcherOptions>) => {
        harness.titleWatcherOptions = options;
        for (const title of harness.titlesToEmit) {
            options.onTitle(title);
        }
        return { cleanup: harness.titleWatcherCleanup };
    }
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        constructor(options: Record<string, unknown>) {
            harness.launcherOptions = options as {
                launch: (abortSignal: AbortSignal) => Promise<void>;
            };
        }
        async run(): Promise<'exit'> {
            harness.locatorOptions?.onLocated({
                sessionId: 'session_native',
                wirePath: '/tmp/kimi/wire.jsonl',
                statePath: '/tmp/kimi/state.json'
            });
            await Promise.resolve();
            return 'exit';
        }
    }
}));

vi.mock('./kimiLocal', () => ({
    kimiLocal: vi.fn(async () => {})
}));

import { kimiLocalLauncher } from './kimiLocalLauncher';
import { kimiLocal } from './kimiLocal';

describe('kimiLocalLauncher title sync', () => {
    afterEach(() => {
        harness.launcherOptions = null;
        harness.locatorOptions = null;
        harness.titleWatcherOptions = null;
        harness.titlesToEmit = [];
        harness.locatorCleanup.mockClear();
        harness.scannerCleanup.mockClear();
        harness.titleWatcherCleanup.mockClear();
        vi.mocked(kimiLocal).mockClear();
    });

    it('syncs the native state title and cleans up both session watchers', async () => {
        const sentMessages: unknown[] = [];
        const foundSessionIds: string[] = [];
        let metadata: Metadata = { path: '/tmp/workspace', host: 'localhost' };
        const updateMetadata = vi.fn((handler: (current: Metadata) => Metadata) => {
            metadata = handler(metadata);
        });
        harness.titlesToEmit = ['New Session', '  Native Kimi Title  ', 'Native Kimi Title'];
        const session = {
            path: '/tmp/workspace',
            sessionId: null,
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            queue: {},
            client: {
                rpcHandlerManager: {},
                getMetadata: () => metadata,
                updateMetadata,
                sendClaudeSessionMessage: (message: unknown) => sentMessages.push(message)
            },
            getPermissionMode: () => 'default',
            onSessionFound: (sessionId: string) => foundSessionIds.push(sessionId),
            sendUserMessage: () => {},
            sendAgentMessage: () => {},
            sendSessionEvent: () => {},
            recordLocalLaunchFailure: () => {}
        };

        await expect(kimiLocalLauncher(session as never, {})).resolves.toBe('exit');

        expect(foundSessionIds).toEqual(['session_native']);
        expect(harness.titleWatcherOptions?.statePath).toBe('/tmp/kimi/state.json');
        expect(sentMessages).toEqual([]);
        expect(metadata).toEqual({
            path: '/tmp/workspace',
            host: 'localhost',
            summary: {
                text: 'Native Kimi Title',
                updatedAt: expect.any(Number)
            }
        });
        expect(updateMetadata).toHaveBeenCalledTimes(1);
        expect(harness.locatorCleanup).toHaveBeenCalledTimes(1);
        expect(harness.scannerCleanup).toHaveBeenCalledTimes(1);
        expect(harness.titleWatcherCleanup).toHaveBeenCalledTimes(1);
    });

    it('does not update metadata when the resumed HAPI title already matches', async () => {
        const metadata: Metadata = {
            path: '/tmp/workspace',
            host: 'localhost',
            summary: { text: 'Native Kimi Title', updatedAt: 123 }
        };
        const updateMetadata = vi.fn();
        const sendClaudeSessionMessage = vi.fn();
        harness.titlesToEmit = ['Native Kimi Title'];
        const session = {
            path: '/tmp/workspace',
            sessionId: 'session_native',
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            queue: {},
            client: {
                rpcHandlerManager: {},
                getMetadata: () => metadata,
                updateMetadata,
                sendClaudeSessionMessage
            },
            getPermissionMode: () => 'default',
            onSessionFound: () => {},
            sendUserMessage: () => {},
            sendAgentMessage: () => {},
            sendSessionEvent: () => {},
            recordLocalLaunchFailure: () => {}
        };

        await kimiLocalLauncher(session as never, {});

        expect(updateMetadata).not.toHaveBeenCalled();
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled();
    });
});

    it('threads the session peer-tools snapshot into kimiLocal (#2056)', async () => {
        const session = {
            path: '/tmp/workspace',
            sessionId: null,
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            queue: {},
            client: {
                rpcHandlerManager: {},
                peerToolsDisabled: true
            },
            getPermissionMode: () => 'default',
            onSessionFound: () => {},
            sendUserMessage: () => {},
            sendAgentMessage: () => {},
            sendSessionEvent: () => {},
            recordLocalLaunchFailure: () => {}
        };

        await expect(kimiLocalLauncher(session as never, {})).resolves.toBe('exit');
        expect(harness.launcherOptions?.launch).toBeTypeOf('function');
        await harness.launcherOptions!.launch(new AbortController().signal);

        expect(kimiLocal).toHaveBeenCalledWith(expect.objectContaining({ peerToolsDisabled: true }));
    });
