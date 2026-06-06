import { describe, expect, it, vi, beforeEach } from 'vitest';

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock('node:child_process', () => ({
    spawn: spawnMock
}));

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn(), warn: vi.fn() }
}));

vi.mock('@/agent/messageConverter', () => ({
    convertAgentMessage: () => null
}));

vi.mock('@/ui/ink/OpencodeDisplay', () => ({
    OpencodeDisplay: () => null
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: vi.fn(async () => {})
}));

import { MessageQueue2 } from '@/utils/MessageQueue2';
import { CursorSession } from './session';
import type { EnhancedMode } from './loop';

function makeChild() {
    const stdoutHandlers: Array<(chunk: string) => void> = [];
    return {
        stdout: { on: vi.fn((event: string, handler: (chunk: string) => void) => {
            if (event === 'data') stdoutHandlers.push(handler);
        }) },
        stderr: { on: vi.fn() },
        on: vi.fn((event: string, handler: (...args: unknown[]) => void) => {
            if (event === 'exit') {
                setImmediate(() => handler(0, null));
            }
        }),
        emitStdout(line: string) {
            for (const handler of stdoutHandlers) {
                handler(`${line}\n`);
            }
        }
    };
}

describe('cursorLegacyRemoteLauncher', () => {
    beforeEach(() => {
        spawnMock.mockReset();
        process.stdin.isTTY = false;
        process.stdout.isTTY = false;
    });

    it('spawns agent with stream-json and trust, not acp', async () => {
        const child = makeChild();
        spawnMock.mockReturnValue(child);

        const queue = new MessageQueue2<EnhancedMode>(() => 'm');
        queue.push('hello', { permissionMode: 'default' });
        queue.close();

        const metadataUpdates: unknown[] = [];
        const client = {
            rpcHandlerManager: { registerHandler: vi.fn() },
            updateMetadata: vi.fn((handler: (m: Record<string, unknown>) => Record<string, unknown>) => {
                metadataUpdates.push(handler({ path: '/tmp', host: 'h', flavor: 'cursor' }));
            }),
            sendSessionEvent: vi.fn(),
            sendAgentMessage: vi.fn(),
            keepAlive: vi.fn(),
            emitMessagesConsumed: vi.fn()
        };

        const session = new CursorSession({
            api: {} as never,
            client: client as never,
            path: '/tmp/project',
            logPath: '/tmp/log',
            sessionId: 'legacy-id',
            messageQueue: queue,
            onModeChange: vi.fn(),
            mode: 'remote',
            startedBy: 'runner',
            startingMode: 'remote'
        });

        const { cursorLegacyRemoteLauncher } = await import('./cursorLegacyRemoteLauncher');
        await cursorLegacyRemoteLauncher(session);

        expect(spawnMock).toHaveBeenCalledTimes(1);
        const args = spawnMock.mock.calls[0]?.[1] as string[];
        expect(args).toContain('-p');
        expect(args).toContain('stream-json');
        expect(args).toContain('--trust');
        expect(args).toContain('--resume');
        expect(args).toContain('legacy-id');
        expect(args).not.toContain('acp');

        expect(metadataUpdates[0]).toEqual(expect.objectContaining({
            cursorSessionId: 'legacy-id',
            cursorSessionProtocol: 'stream-json'
        }));
    });
});
