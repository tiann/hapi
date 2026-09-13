import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyCodexConfigFile, resolveCodexHome } from './codexHome';

const temporaryDirectories: string[] = [];

async function createTemporaryDirectory(): Promise<string> {
    const directory = await mkdtemp(join(tmpdir(), 'hapi-codex-home-test-'));
    temporaryDirectories.push(directory);
    return directory;
}

afterEach(async () => {
    await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe('codexHome', () => {
    it('uses CODEX_HOME when configured and trims surrounding whitespace', () => {
        expect(resolveCodexHome({ CODEX_HOME: '  C:\\codex-home  ' })).toBe('C:\\codex-home');
    });

    it('copies config.toml without copying authentication or other state', async () => {
        const sourceHome = await createTemporaryDirectory();
        const targetHome = await createTemporaryDirectory();
        await writeFile(join(sourceHome, 'config.toml'), '[mcp_servers.example]\ncommand = "server"\n');
        await writeFile(join(sourceHome, 'auth.json'), '{"access_token":"not-copied"}\n');

        await expect(copyCodexConfigFile(sourceHome, targetHome))
            .resolves.toBe(join(targetHome, 'config.toml'));
        await expect(readFile(join(targetHome, 'config.toml'), 'utf8'))
            .resolves.toBe('[mcp_servers.example]\ncommand = "server"\n');
        await expect(readFile(join(targetHome, 'auth.json'), 'utf8')).rejects.toMatchObject({ code: 'ENOENT' });
    });

    it('treats a missing user config as a valid first-run state', async () => {
        const sourceHome = await createTemporaryDirectory();
        const targetHome = await createTemporaryDirectory();

        await expect(copyCodexConfigFile(sourceHome, targetHome)).resolves.toBeNull();
    });
});
