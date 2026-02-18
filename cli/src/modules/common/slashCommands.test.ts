import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSlashCommands } from './slashCommands';

describe('listSlashCommands', () => {
    let claudeConfigDir: string;
    let codexHomeDir: string;
    let previousClaudeConfigDir: string | undefined;
    let previousCodexHome: string | undefined;

    beforeEach(async () => {
        previousClaudeConfigDir = process.env.CLAUDE_CONFIG_DIR;
        previousCodexHome = process.env.CODEX_HOME;

        claudeConfigDir = await mkdtemp(join(tmpdir(), 'hapi-claude-config-'));
        codexHomeDir = await mkdtemp(join(tmpdir(), 'hapi-codex-home-'));

        process.env.CLAUDE_CONFIG_DIR = claudeConfigDir;
        process.env.CODEX_HOME = codexHomeDir;
    });

    it('includes new for claude', async () => {
        const commands = await listSlashCommands('claude');
        expect(commands.some((command) => command.name === 'new')).toBe(true);
    });

    it('includes new for codex', async () => {
        const commands = await listSlashCommands('codex');
        expect(commands.some((command) => command.name === 'new')).toBe(true);
    });

    it('includes new for gemini', async () => {
        const commands = await listSlashCommands('gemini');
        expect(commands.some((command) => command.name === 'new')).toBe(true);
    });

    it('includes new for opencode', async () => {
        const commands = await listSlashCommands('opencode');
        expect(commands.some((command) => command.name === 'new')).toBe(true);
    });

    afterEach(async () => {
        if (previousClaudeConfigDir === undefined) {
            delete process.env.CLAUDE_CONFIG_DIR;
        } else {
            process.env.CLAUDE_CONFIG_DIR = previousClaudeConfigDir;
        }

        if (previousCodexHome === undefined) {
            delete process.env.CODEX_HOME;
        } else {
            process.env.CODEX_HOME = previousCodexHome;
        }

        await rm(claudeConfigDir, { recursive: true, force: true });
        await rm(codexHomeDir, { recursive: true, force: true });
    });
});
