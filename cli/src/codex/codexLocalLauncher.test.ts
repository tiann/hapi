import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>,
    sessionScannerCalls: [] as Array<Record<string, unknown>>,
    scannerFailureMessage: 'No Codex session found within 120000ms for cwd c:\\workspace\\project; refusing fallback.'
}));

vi.mock('./codexLocal', () => ({
    codexLocal: async (opts: Record<string, unknown>) => {
        harness.launches.push(opts);
    }
}));

vi.mock('./utils/buildHapiMcpBridge', () => ({
    buildHapiMcpBridge: async () => ({
        server: {
            url: 'http://localhost:0',
            stop: () => {}
        },
        mcpServers: {}
    })
}));

vi.mock('./utils/codexSessionScanner', () => ({
    createCodexSessionScanner: async (opts: {
        onSessionMatchFailed?: (message: string) => void;
    }) => {
        harness.sessionScannerCalls.push(opts as Record<string, unknown>);
        return {
            cleanup: async () => {},
            onNewSession: () => {},
            triggerFailure: () => {
                opts.onSessionMatchFailed?.(harness.scannerFailureMessage);
            }
        };
    }
}));

vi.mock('@/modules/common/launcher/BaseLocalLauncher', () => ({
    BaseLocalLauncher: class {
        readonly control = {
            requestExit: () => {}
        };

        constructor(private readonly opts: { launch: (signal: AbortSignal) => Promise<void> }) {}

        async run(): Promise<'exit'> {
            await this.opts.launch(new AbortController().signal);
            return 'exit';
        }
    }
}));

import { codexLocalLauncher } from './codexLocalLauncher';

function createQueueStub() {
    return {
        size: () => 0,
        reset: () => {},
        setOnMessage: () => {}
    };
}

function createSessionStub(permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo', codexArgs?: string[], path = '/tmp/worktree') {
    const sessionEvents: Array<{ type: string; message?: string }> = [];
    let localLaunchFailure: { message: string; exitReason: 'switch' | 'exit' } | null = null;

    return {
        session: {
            sessionId: null,
            path,
            startedBy: 'terminal' as const,
            startingMode: 'local' as const,
            codexArgs,
            client: {
                rpcHandlerManager: {
                    registerHandler: () => {}
                }
            },
            getPermissionMode: () => permissionMode,
            onSessionFound: () => {},
            sendSessionEvent: (event: { type: string; message?: string }) => {
                sessionEvents.push(event);
            },
            recordLocalLaunchFailure: (message: string, exitReason: 'switch' | 'exit') => {
                localLaunchFailure = { message, exitReason };
            },
            sendUserMessage: () => {},
            sendAgentMessage: () => {},
            queue: createQueueStub()
        },
        sessionEvents,
        getLocalLaunchFailure: () => localLaunchFailure
    };
}

describe('codexLocalLauncher', () => {
    afterEach(() => {
        harness.launches = [];
        harness.sessionScannerCalls = [];
    });

    it('rebuilds approval and sandbox args from yolo mode', async () => {
        const { session } = createSessionStub('yolo', [
            '--sandbox',
            'read-only',
            '--ask-for-approval',
            'untrusted',
            '--model',
            'o3',
            '--full-auto'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);
    });

    it('preserves raw Codex approval flags in default mode', async () => {
        const { session } = createSessionStub('default', [
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-request',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('keeps sandbox escalation available in safe-yolo mode', async () => {
        const { session } = createSessionStub('safe-yolo', [
            '--ask-for-approval',
            'never',
            '--sandbox',
            'danger-full-access',
            '--model',
            'o3'
        ]);

        await codexLocalLauncher(session as never);

        expect(harness.launches).toHaveLength(1);
        expect(harness.launches[0]?.codexArgs).toEqual([
            '--ask-for-approval',
            'on-failure',
            '--sandbox',
            'workspace-write',
            '--model',
            'o3'
        ]);
    });

    it('warns on session match failure without aborting local Codex launch', async () => {
        const { session, sessionEvents, getLocalLaunchFailure } = createSessionStub('default', undefined, 'c:\\workspace\\project');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as { onSessionMatchFailed?: (message: string) => void } | undefined;
        scannerCall?.onSessionMatchFailed?.(harness.scannerFailureMessage);

        expect(harness.launches).toHaveLength(1);
        expect(getLocalLaunchFailure()).toBeNull();
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: `${harness.scannerFailureMessage} Keeping local Codex running; remote transcript sync may be unavailable for this launch.`
        });
    });
});
