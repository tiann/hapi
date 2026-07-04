import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnMock, killProcessByChildProcessMock, resolveCodexCommandMock, withCodexSpawnEnvMock } = vi.hoisted(() => {
    const spawnMock = vi.fn(() => {
        const stdout = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
        const stderr = Object.assign(new EventEmitter(), { setEncoding: vi.fn() });
        const stdin = { end: vi.fn() };
        return Object.assign(new EventEmitter(), {
            stdout,
            stderr,
            stdin
        });
    });

    return {
        spawnMock,
        killProcessByChildProcessMock: vi.fn(async () => undefined),
        resolveCodexCommandMock: vi.fn(() => ({ command: '/opt/homebrew/bin/codex', args: [] as string[] })),
        withCodexSpawnEnvMock: vi.fn((env: NodeJS.ProcessEnv) => ({ ...env, PATH: '/usr/bin:/opt/homebrew/bin' }))
    };
});

vi.mock('node:child_process', async () => {
    const actual = await vi.importActual<typeof import('node:child_process')>('node:child_process');
    return {
        ...actual,
        spawn: spawnMock
    };
});

vi.mock('@/ui/logger', () => ({
    logger: { debug: vi.fn() }
}));

vi.mock('@/utils/process', () => ({
    killProcessByChildProcess: killProcessByChildProcessMock
}));

vi.mock('./utils/codexExecutable', () => ({
    resolveCodexCommand: resolveCodexCommandMock,
    withCodexSpawnEnv: withCodexSpawnEnvMock
}));

describe('CodexAppServerClient', () => {
    beforeEach(() => {
        vi.clearAllMocks();
        resolveCodexCommandMock.mockReturnValue({ command: '/opt/homebrew/bin/codex', args: [] });
        withCodexSpawnEnvMock.mockImplementation((env: NodeJS.ProcessEnv) => ({
            ...env,
            PATH: '/usr/bin:/opt/homebrew/bin'
        }));
    });

    it('spawns app-server through the resolved Codex executable with augmented PATH', async () => {
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();

        expect(resolveCodexCommandMock).toHaveBeenCalledOnce();
        expect(withCodexSpawnEnvMock).toHaveBeenCalledWith(process.env);
        expect(spawnMock).toHaveBeenCalledWith('/opt/homebrew/bin/codex', ['app-server'], expect.objectContaining({
            env: expect.objectContaining({ PATH: '/usr/bin:/opt/homebrew/bin' }),
            stdio: ['pipe', 'pipe', 'pipe']
        }));
    });

    it('preserves resolved launcher args before app-server', async () => {
        resolveCodexCommandMock.mockReturnValue({ command: 'node', args: ['/tools/codex.js'] });
        const { CodexAppServerClient } = await import('./codexAppServerClient');
        const client = new CodexAppServerClient();

        await client.connect();

        expect(spawnMock).toHaveBeenCalledWith('node', ['/tools/codex.js', 'app-server'], expect.any(Object));
    });
});
