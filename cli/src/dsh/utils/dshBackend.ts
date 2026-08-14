import { AcpSdkBackend } from '@/agent/backends/acp';
import type { DshPermissionMode } from '@hapi/protocol/types';

function filterEnv(env: NodeJS.ProcessEnv): Record<string, string> {
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(env)) {
        if (value !== undefined) {
            result[key] = value;
        }
    }
    return result;
}

export interface DshBackendOptions {
    permissionMode?: DshPermissionMode;
    effort?: string;
    model?: string;
    preset?: string;
}

/**
 * ACP process args for DeepSeek Harness (DSH). DSH exposes ACP through the
 * `dsh-acp-demo` bin (the automation-only ACP server), booted from a cordis.yml
 * composition that mounts the DeepSeek LLM adapter plus the sandbox/bash/fs tool
 * stack. The config path resolves from `DSH_ACP_CONFIG`, defaulting to
 * `./cordis.yml` in the session cwd.
 */
export function buildDshAcpArgs(preset?: string): string[] {
    // DSH_ACP_CONFIG wins when set; otherwise the preset selects the cordis.yml
    // composition ('ptc' -> code-mode overlay, everything else -> standard).
    const config = process.env.DSH_ACP_CONFIG
        ?? (preset === 'ptc' ? './code-mode.cordis.yml' : './cordis.yml');
    return ['--config', config];
}

/**
 * DSH's ACP is automation-only and offers no runtime config (no
 * session/set_model or session/set_config_option), so every user-facing option
 * is fixed at spawn time through environment variables that the cordis.yml
 * reads via `!!js process.env.XXX ?? default`.
 */
export function buildDshEnv(opts: DshBackendOptions = {}): Record<string, string> {
    const env = filterEnv(process.env);
    // Permission: Hapi 'yolo' -> DSH 'danger-full-access' (never ask);
    // anything else -> 'workspace-write' (sandbox default, asks before a wider retry).
    env.DSH_PERMISSION_MODE = opts.permissionMode === 'yolo' ? 'danger-full-access' : 'workspace-write';
    // Reasoning effort: DSH accepts off/high/max.
    if (opts.effort) {
        env.DSH_REASONING_EFFORT = opts.effort;
    }
    // Model id: deepseek-v4-pro / deepseek-v4-flash.
    if (opts.model) {
        env.DSH_MODEL = opts.model;
    }
    return env;
}

export function createDshBackend(opts: DshBackendOptions = {}): AcpSdkBackend {
    return new AcpSdkBackend({
        command: process.env.DSH_ACP_CLI ?? 'dsh-acp-demo',
        args: buildDshAcpArgs(opts.preset),
        env: buildDshEnv(opts),
        flavor: 'dsh',
    });
}
