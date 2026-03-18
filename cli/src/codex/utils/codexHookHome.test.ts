import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const harness = vi.hoisted(() => ({
    configuration: {
        happyHomeDir: ''
    }
}));

vi.mock('@/configuration', () => ({
    configuration: harness.configuration
}));

vi.mock('@/ui/logger', () => ({
    logger: {
        debug: () => {},
        warn: () => {},
        info: () => {},
        infoDeveloper: () => {},
        logFilePath: '/tmp/test.log'
    }
}));

import { createCodexHookHome } from './codexHookHome';

describe('createCodexHookHome', () => {
    let sandboxDir: string;
    let baseCodexHomeDir: string;
    let originalCodexHome: string | undefined;

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'codex-hook-home-'));
        harness.configuration.happyHomeDir = join(sandboxDir, 'happy-home');
        baseCodexHomeDir = join(sandboxDir, 'base-codex-home');
        await mkdir(join(baseCodexHomeDir, 'sessions'), { recursive: true });

        originalCodexHome = process.env.CODEX_HOME;
        process.env.CODEX_HOME = baseCodexHomeDir;
    });

    afterEach(async () => {
        if (originalCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = originalCodexHome;
        }

        await rm(sandboxDir, { recursive: true, force: true });
    });

    it('merges existing hooks and shares mutable top-level files with the real CODEX_HOME', async () => {
        await writeFile(join(baseCodexHomeDir, 'auth.json'), '{"token":"abc"}');
        await writeFile(join(baseCodexHomeDir, 'config.toml'), 'model = "o3"\n');
        await writeFile(
            join(baseCodexHomeDir, 'hooks.json'),
            JSON.stringify({
                hooksConfig: {
                    enabled: true
                },
                hooks: {
                    SessionStart: [
                        {
                            matcher: 'resume',
                            hooks: [{ type: 'command', command: 'echo existing-start' }]
                        }
                    ],
                    Stop: [
                        {
                            matcher: '*',
                            hooks: [{ type: 'command', command: 'echo existing-stop' }]
                        }
                    ]
                }
            })
        );
        await writeFile(join(baseCodexHomeDir, 'sessions', 'session.jsonl'), '[]');

        const hookHome = await createCodexHookHome({
            port: 4111,
            token: 'secret-token'
        });

        try {
            expect(await readFile(join(hookHome.codexHomeDir, 'auth.json'), 'utf-8')).toBe('{"token":"abc"}');
            expect(await readFile(join(hookHome.codexHomeDir, 'config.toml'), 'utf-8')).toBe('model = "o3"\n');
            expect(await readFile(join(hookHome.codexHomeDir, 'sessions', 'session.jsonl'), 'utf-8')).toBe('[]');

            const hooks = JSON.parse(await readFile(join(hookHome.codexHomeDir, 'hooks.json'), 'utf-8')) as {
                hooks?: {
                    SessionStart?: Array<{
                        matcher?: string;
                        hooks?: Array<{
                            command?: string;
                        }>;
                    }>;
                    Stop?: Array<{
                        hooks?: Array<{
                            command?: string;
                        }>;
                    }>;
                };
                hooksConfig?: {
                    enabled?: boolean;
                };
            };

            expect(hooks.hooksConfig?.enabled).toBe(true);
            expect(hooks.hooks?.Stop?.[0]?.hooks?.[0]?.command).toBe('echo existing-stop');
            expect(hooks.hooks?.SessionStart).toHaveLength(2);
            expect(hooks.hooks?.SessionStart?.[0]?.hooks?.[0]?.command).toBe('echo existing-start');
            expect(hooks.hooks?.SessionStart?.[1]?.hooks?.[0]?.command).toContain('hook-forwarder');
            expect(hooks.hooks?.SessionStart?.[1]?.hooks?.[0]?.command).toContain('--port 4111');
            expect(hooks.hooks?.SessionStart?.[1]?.hooks?.[0]?.command).toContain('--token secret-token');

            await writeFile(join(hookHome.codexHomeDir, 'history.jsonl'), '{"text":"saved prompt"}\n');
            await writeFile(join(hookHome.codexHomeDir, 'config.toml'), 'model = "o4"\n');

            expect(await readFile(join(baseCodexHomeDir, 'history.jsonl'), 'utf-8')).toBe('{"text":"saved prompt"}\n');
            expect(await readFile(join(baseCodexHomeDir, 'config.toml'), 'utf-8')).toBe('model = "o4"\n');
        } finally {
            await hookHome.cleanup();
        }

        expect(existsSync(hookHome.codexHomeDir)).toBe(false);
    });
});
