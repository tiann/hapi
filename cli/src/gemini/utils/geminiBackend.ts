import { AcpSdkBackend } from '@/agent/backends/acp';
import { buildGeminiEnv, resolveGeminiRuntimeConfig } from './config';
import { getBunGeminiPath } from './bunGeminiPath';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
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
