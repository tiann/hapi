import { AcpSdkBackend } from '@/agent/backends/acp';
import { buildGeminiEnv, resolveGeminiRuntimeConfig } from './config';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

/**
 * Check if Bun-optimized Gemini CLI is available
 * Returns the path if both Bun and Bun-optimized Gemini are available, null otherwise
 */
function getBunGeminiPath(): string | null {
    try {
        const bunGeminiPath = join(homedir(), '.bun', 'install', 'global', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');

        // Check if Bun version of Gemini CLI exists
        if (!existsSync(bunGeminiPath)) {
            return null;
        }

        // Check if bun command itself is available on the system
        const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });

        if (bunCheck.error || bunCheck.status !== 0) {
            return null;
        }

        return bunGeminiPath;
    } catch {
        // If any error occurs during check, safely return null
        return null;
    }
}

export function createGeminiBackend(opts: {
    model?: string;
    token?: string;
    resumeSessionId?: string | null;
    hookSettingsPath?: string;
    cwd?: string;
}): AcpSdkBackend {
    const { model, token } = resolveGeminiRuntimeConfig({
        model: opts.model,
        token: opts.token
    });

    const args = ['--experimental-acp'];
    if (opts.resumeSessionId) {
        args.push('--resume', opts.resumeSessionId);
    }
    if (model) {
        args.push('--model', model);
    }

    const env = buildGeminiEnv({
        model,
        token,
        hookSettingsPath: opts.hookSettingsPath,
        cwd: opts.cwd
    });

    // Try to use Bun-optimized version if available (non-breaking)
    const bunGeminiPath = getBunGeminiPath();

    if (bunGeminiPath) {
        // Bun runtime available - use optimized version
        return new AcpSdkBackend({
            command: 'bun',
            args: ['run', bunGeminiPath, ...args],
            env: filterEnv(env)
        });
    }

    // Bun not available - safely fallback to standard gemini command
    // This ensures compatibility with all environments
    return new AcpSdkBackend({
        command: 'gemini',
        args,
        env: filterEnv(env)
    });
}
