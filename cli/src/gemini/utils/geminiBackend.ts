import { AcpSdkBackend } from '@/agent/backends/acp';
import { buildGeminiEnv, resolveGeminiRuntimeConfig } from './config';

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

    return new AcpSdkBackend({
        command: 'gemini',
        args,
        env: filterEnv(env)
    });
}
