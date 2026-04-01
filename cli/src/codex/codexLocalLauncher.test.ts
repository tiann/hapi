import { afterEach, describe, expect, it, vi } from 'vitest';

const harness = vi.hoisted(() => ({
    launches: [] as Array<Record<string, unknown>>,
    sessionScannerCalls: [] as Array<Record<string, unknown>>,
    resolverCalls: [] as Array<string>,
    resolverResult: {
        status: 'found' as const,
        filePath: '/tmp/codex-session-resume.jsonl',
        cwd: '/tmp/worktree',
        timestamp: 1234567890
    },
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

vi.mock('./utils/resolveCodexSessionFile', () => ({
    resolveCodexSessionFile: async (sessionId: string) => {
        harness.resolverCalls.push(sessionId);
        return harness.resolverResult;
    }
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

function createSessionStub(
    permissionMode: 'default' | 'read-only' | 'safe-yolo' | 'yolo',
    codexArgs?: string[],
    path = '/tmp/worktree',
    sessionId: string | null = null
) {
    const sessionEvents: Array<{ type: string; message?: string }> = [];
    let localLaunchFailure: { message: string; exitReason: 'switch' | 'exit' } | null = null;

    return {
        session: {
            sessionId,
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
        harness.resolverCalls = [];
        harness.resolverResult = {
            status: 'found',
            filePath: '/tmp/codex-session-resume.jsonl',
            cwd: '/tmp/worktree',
            timestamp: 1234567890
        };
    });

    it('resolves the resume transcript before creating the scanner', async () => {
        const { session } = createSessionStub('default', undefined, '/tmp/worktree', 'session-resume');

        await codexLocalLauncher(session as never);

        expect(harness.resolverCalls).toEqual(['session-resume']);
        expect(harness.sessionScannerCalls).toHaveLength(1);
        expect(harness.sessionScannerCalls[0]?.resolvedSessionFile).toEqual({
            status: 'found',
            filePath: '/tmp/codex-session-resume.jsonl',
            cwd: '/tmp/worktree',
            timestamp: 1234567890
        });
    });

    it('uses an accurate warning when explicit resume resolution failed before launch', async () => {
        harness.resolverResult = {
            status: 'not_found'
        };
        const { session, sessionEvents } = createSessionStub('default', undefined, '/tmp/worktree', 'session-resume');

        await codexLocalLauncher(session as never);

        const scannerCall = harness.sessionScannerCalls[0] as { onSessionMatchFailed?: (message: string) => void } | undefined;
        scannerCall?.onSessionMatchFailed?.('Explicit Codex session resolution failed with status not_found; refusing fallback.');

        expect(harness.resolverCalls).toEqual(['session-resume']);
        expect(sessionEvents).toContainEqual({
            type: 'message',
            message: 'Explicit Codex session resolution failed with status not_found; refusing fallback. Keeping local Codex running; remote transcript sync is unavailable for this launch.'
        });
    });

    it('does not call the resolver for fresh launches without a session id', async () => {
        const { session } = createSessionStub('default');

        await codexLocalLauncher(session as never);

        expect(harness.resolverCalls).toEqual([]);
        expect(harness.sessionScannerCalls[0]?.resolvedSessionFile).toBeNull();
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
