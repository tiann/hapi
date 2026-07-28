import { beforeEach, describe, expect, it, vi } from 'vitest';

type TransportOptions = { command: string; args: string[]; cwd: string };
type LifecycleOptions = { stopKeepAlive: () => void };

const harness = vi.hoisted(() => ({
    transportOptions: null as TransportOptions | null,
    sent: [] as unknown[],
    session: {
        keepAlive: vi.fn(),
        onUserMessage: vi.fn(),
        onCancelQueuedMessage: vi.fn(),
        rpcHandlerManager: { registerHandler: vi.fn() },
    },
}));

vi.mock('@/agent/sessionFactory', () => ({
    bootstrapSession: vi.fn(async () => ({ api: {}, session: harness.session })),
    bootstrapExistingSession: vi.fn(async () => ({ api: {}, session: harness.session })),
}));

vi.mock('@/agent/runnerLifecycle', () => ({
    createRunnerLifecycle: vi.fn((options: LifecycleOptions) => {
        return {
            registerProcessHandlers: vi.fn(),
            cleanupAndExit: vi.fn(async () => {
                options.stopKeepAlive();
            }),
            markCrash: vi.fn(),
            setExitCode: vi.fn(),
            setArchiveReason: vi.fn(),
            setSessionEndReason: vi.fn(),
            hasExplicitSessionEndReason: vi.fn(() => true),
        };
    }),
    createModeChangeHandler: vi.fn(() => vi.fn()),
    setControlledByUser: vi.fn(),
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn(),
        getLogPath: vi.fn(() => '/tmp/hapi.log'),
    },
}));

vi.mock('./piTransport', () => ({
    PiTransport: class {
        constructor(options: TransportOptions) {
            harness.transportOptions = options;
        }

        onError(): void {}

        onClose(): void {}

        onEvent(): void {}

        start(): void {}

        send(command: unknown): void {
            harness.sent.push(command);
            if ((command as { type?: string }).type === 'get_commands') {
                throw new Error('stop test transport');
            }
        }

        kill(): void {}
    },
}));

import { runPi } from './runPi';

describe('runPi startup', () => {
    beforeEach(() => {
        harness.transportOptions = null;
        harness.sent.length = 0;
    });

    it('lets Pi create a fresh session when no resume ID is provided', async () => {
        await runPi({ workingDirectory: '/work' });

        expect(harness.transportOptions).toEqual({
            command: 'pi',
            args: ['--mode', 'rpc'],
            cwd: '/work',
        });
        expect(harness.sent).toEqual([
            { type: 'get_state' },
            { type: 'get_available_models' },
            { type: 'get_commands' },
        ]);
    });

    it('resumes with --session and keeps the session selected by Pi', async () => {
        await runPi({
            workingDirectory: '/work',
            resumeSessionId: 'pi-session-123',
        });

        expect(harness.transportOptions).toEqual({
            command: 'pi',
            args: ['--mode', 'rpc', '--session', 'pi-session-123'],
            cwd: '/work',
        });
        expect(harness.sent).toEqual([
            { type: 'get_state' },
            { type: 'get_available_models' },
            { type: 'get_commands' },
        ]);
    });
});
