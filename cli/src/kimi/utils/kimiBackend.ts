import { AcpSdkBackend } from '@/agent/backends/acp';

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
 * Creates the ACP backend for `kimi acp`. Model selection is intentionally
 * NOT passed via environment: new kimi-code ignores a plain KIMI_MODEL var
 * (only the KIMI_MODEL_NAME provider-synthesis family exists), so the model
 * is applied over ACP (`session/set_model` / `session/set_config_option`)
 * after session creation — see kimiRemoteLauncher.
 */
export function createKimiBackend(): AcpSdkBackend {
    return new AcpSdkBackend({
        command: 'kimi',
        args: ['acp'],
        env: filterEnv(process.env),
        flavor: 'kimi',
    });
}
