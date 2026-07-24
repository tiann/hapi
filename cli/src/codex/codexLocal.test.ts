import { win32 } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const { resolveCodexCommandMock, spawnWithTerminalGuardMock } = vi.hoisted(() => ({
    resolveCodexCommandMock: vi.fn(() => ({ command: 'codex', args: [] as string[] })),
    spawnWithTerminalGuardMock: vi.fn(async (_options: unknown) => {})
}));

vi.mock('./utils/codexExecutable', () => ({
    resolveCodexCommand: resolveCodexCommandMock
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

const codexScriptPath = win32.join('toolchains', 'nodejs', 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
const hapiCommandPath = win32.join('hapi-bin', 'hapi.exe');
const workspacePath = win32.join('workspace', 'project');

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

    it('does not filter resume when it appears as an option value', () => {
        expect(filterResumeSubcommand(['--model', 'resume'])).toEqual(['--model', 'resume']);
    });

    it('filters resume after global options', () => {
        expect(filterResumeSubcommand(['--model', 'gpt-4', 'resume', '123']))
            .toEqual(['--model', 'gpt-4']);
        expect(filterResumeSubcommand(['--yolo', 'resume', '--last']))
            .toEqual(['--yolo']);
        expect(filterResumeSubcommand(['--config', 'model="resume"', 'resume', '--last']))
            .toEqual(['--config', 'model="resume"']);
    });

    it('preserves an optional prompt after the resume selector', () => {
        expect(filterResumeSubcommand(['resume', 'abc-123', 'continue here']))
            .toEqual(['continue here']);
        expect(filterResumeSubcommand(['resume', 'abc-123', 'resume']))
            .toEqual(['resume']);
        expect(filterResumeSubcommand(['resume', '--last', 'continue here']))
            .toEqual(['continue here']);
    });

    it('does not filter resume after a prompt or option terminator', () => {
        expect(filterResumeSubcommand(['start here', 'resume', '--last']))
            .toEqual(['start here', 'resume', '--last']);
        expect(filterResumeSubcommand(['--', 'resume', '--last']))
            .toEqual(['--', 'resume', '--last']);
    });

    it('does not treat variadic image values as a resume subcommand', () => {
        expect(filterResumeSubcommand(['--image', 'one.png', 'resume', '--last']))
            .toEqual(['--image', 'one.png', 'resume', '--last']);
    });

    it('preserves arguments after an option terminator in resume mode', () => {
        expect(filterResumeSubcommand(['resume', 'abc-123', '--', '--last']))
            .toEqual(['--', '--last']);
    });
});

describe('codexLocal', () => {
    beforeEach(() => {
        resolveCodexCommandMock.mockReset();
        resolveCodexCommandMock.mockReturnValue({ command: 'codex', args: [] as string[] });
        spawnWithTerminalGuardMock.mockClear();
    });

    it('launches the resolved Codex command without shell so Windows keeps -c config values as argv elements', async () => {
        const controller = new AbortController();
        resolveCodexCommandMock.mockReturnValue({
            command: 'node',
            args: [codexScriptPath]
        });

        await codexLocal({
            abort: controller.signal,
            sessionId: null,
            path: workspacePath,
            onSessionFound: vi.fn(),
            mcpServers: {
                hapi: {
                    command: hapiCommandPath,
                    args: ['mcp', '--url', 'http://127.0.0.1:63995/'],
                    tools: {
                        change_title: {
                            approval_mode: 'approve'
                        }
                    }
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
            command: 'node',
            cwd: workspacePath
        }));
        expect(spawnOptions).not.toHaveProperty('shell');

        const args = spawnOptions.args;
        expect(args[0]).toBe(codexScriptPath);
        const hookArg = args.find((arg) => arg.startsWith('hooks.SessionStart='));
        expect(hookArg).toBeDefined();
        expect(hookArg).toContain('{ hooks = [{ type = "command", command = "');
        expect(args.some((arg) => arg.startsWith('hooks.PreToolUse='))).toBe(true);
        expect(args.some((arg) => arg.startsWith('hooks.PostToolUse='))).toBe(true);
        expect(args).toContain("mcp_servers.hapi.args=['mcp','--url','http://127.0.0.1:63995/']");
        expect(args).toContain('mcp_servers.hapi.tools.change_title.approval_mode="approve"');
    });

    it('passes reasoning effort through Codex config instead of an unsupported CLI flag', async () => {
        const controller = new AbortController();

        await codexLocal({
            abort: controller.signal,
            sessionId: 'codex-session-1',
            path: workspacePath,
            modelReasoningEffort: 'high',
            onSessionFound: vi.fn()
        });

        expect(spawnWithTerminalGuardMock).toHaveBeenCalledOnce();
        const spawnOptions = spawnWithTerminalGuardMock.mock.calls[0][0] as {
            args: string[];
        };

        expect(spawnOptions.args).toContain('-c');
        expect(spawnOptions.args).toContain('model_reasoning_effort="high"');
        expect(spawnOptions.args).not.toContain('--model-reasoning-effort');
    });

    it('passes resume --last through while Codex is resolving the initial session', async () => {
        const controller = new AbortController();

        await codexLocal({
            abort: controller.signal,
            sessionId: null,
            path: workspacePath,
            onSessionFound: vi.fn(),
            codexArgs: ['--yolo', 'resume', '--last']
        });

        const spawnOptions = spawnWithTerminalGuardMock.mock.calls[0][0] as {
            args: string[];
        };
        expect(spawnOptions.args.slice(-3)).toEqual(['--yolo', 'resume', '--last']);
    });

    it('replaces resume --last with the resolved session ID during local handoff', async () => {
        const controller = new AbortController();
        const sessionId = '11111111-1111-4111-8111-111111111111';

        await codexLocal({
            abort: controller.signal,
            sessionId,
            path: workspacePath,
            onSessionFound: vi.fn(),
            codexArgs: [
                '--ask-for-approval', 'never',
                '--sandbox', 'danger-full-access',
                'resume', '--last'
            ]
        });

        const spawnOptions = spawnWithTerminalGuardMock.mock.calls[0][0] as {
            args: string[];
        };
        expect(spawnOptions.args.filter((arg) => arg === 'resume')).toEqual(['resume']);
        expect(spawnOptions.args).toContain(sessionId);
        expect(spawnOptions.args).not.toContain('--last');
        expect(spawnOptions.args).toContain('danger-full-access');
    });
});
