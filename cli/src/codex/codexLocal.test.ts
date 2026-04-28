import { beforeEach, describe, expect, it, vi } from 'vitest';

const { spawnWithTerminalGuardMock } = vi.hoisted(() => ({
    spawnWithTerminalGuardMock: vi.fn(async (_options: unknown) => {})
}));

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: spawnWithTerminalGuardMock
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: vi.fn()
    }
}));

import { codexLocal, filterResumeSubcommand } from './codexLocal';

describe('filterResumeSubcommand', () => {
    it('returns empty array unchanged', () => {
        expect(filterResumeSubcommand([])).toEqual([]);
    });

    it('passes through args when first arg is not resume', () => {
        expect(filterResumeSubcommand(['--model', 'gpt-4'])).toEqual(['--model', 'gpt-4']);
        expect(filterResumeSubcommand(['--sandbox', 'read-only'])).toEqual(['--sandbox', 'read-only']);
    });

    it('filters resume subcommand with session ID', () => {
        expect(filterResumeSubcommand(['resume', 'abc-123'])).toEqual([]);
        expect(filterResumeSubcommand(['resume', 'abc-123', '--model', 'gpt-4']))
            .toEqual(['--model', 'gpt-4']);
    });

    it('filters resume subcommand without session ID', () => {
        expect(filterResumeSubcommand(['resume'])).toEqual([]);
        expect(filterResumeSubcommand(['resume', '--model', 'gpt-4']))
            .toEqual(['--model', 'gpt-4']);
    });

    it('does not filter resume when it appears as flag value', () => {
        expect(filterResumeSubcommand(['--name', 'resume'])).toEqual(['--name', 'resume']);
    });

    it('does not filter resume in middle of args', () => {
        expect(filterResumeSubcommand(['--model', 'gpt-4', 'resume', '123']))
            .toEqual(['--model', 'gpt-4', 'resume', '123']);
    });
});

describe('codexLocal', () => {
    beforeEach(() => {
        spawnWithTerminalGuardMock.mockClear();
    });

    it('launches codex without shell so Windows keeps -c config values as argv elements', async () => {
        const controller = new AbortController();

        await codexLocal({
            abort: controller.signal,
            sessionId: null,
            path: 'C:\\workspace\\project',
            onSessionFound: vi.fn(),
            mcpServers: {
                hapi: {
                    command: 'C:\\Users\\test\\AppData\\Local\\hapi.exe',
                    args: ['mcp', '--url', 'http://127.0.0.1:63995/']
                }
            },
            sessionHook: {
                port: 63996,
                token: 'secret-token'
            }
        });

        expect(spawnWithTerminalGuardMock).toHaveBeenCalledOnce();
        const spawnOptions = spawnWithTerminalGuardMock.mock.calls[0][0] as {
            command: string;
            cwd: string;
            args: string[];
            shell?: unknown;
        };
        expect(spawnOptions).toEqual(expect.objectContaining({
            command: 'codex',
            cwd: 'C:\\workspace\\project'
        }));
        expect(spawnOptions).not.toHaveProperty('shell');

        const args = spawnOptions.args;
        const hookArg = args.find((arg) => arg.startsWith('hooks.SessionStart='));
        expect(hookArg).toBeDefined();
        expect(hookArg).toContain('{ hooks = [{ type = "command", command = "');
        expect(args).toContain("mcp_servers.hapi.args=['mcp','--url','http://127.0.0.1:63995/']");
    });
});
