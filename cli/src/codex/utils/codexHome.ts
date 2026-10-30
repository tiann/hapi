import { copyFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

export function resolveCodexHome(env: NodeJS.ProcessEnv = process.env): string {
    const configuredHome = env.CODEX_HOME?.trim();
    return configuredHome ? configuredHome : join(homedir(), '.codex');
}

/**
 * Copy only Codex's user config into a runner-owned home.
 *
 * Runner-spawned Codex sessions use a temporary CODEX_HOME for token auth.
 * Copying config.toml preserves user MCP settings without copying auth files
 * or unrelated state. A missing source config is a valid first-run state.
 */
export async function copyCodexConfigFile(sourceHome: string, targetHome: string): Promise<string | null> {
    if (resolve(sourceHome) === resolve(targetHome)) {
        return null;
    }

    const targetConfigPath = join(targetHome, 'config.toml');
    try {
        await copyFile(join(sourceHome, 'config.toml'), targetConfigPath);
        return targetConfigPath;
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
            return null;
        }
        throw error;
    }
}
