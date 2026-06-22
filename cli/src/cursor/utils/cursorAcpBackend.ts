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

function isDefaultSpawnModel(model: string | null | undefined): boolean {
    if (!model) return true;
    const normalized = model.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]';
}

export function createCursorAcpBackend(opts: { cwd: string; model?: string | null }): AcpSdkBackend {
    const args = ['acp'];
    if (!isDefaultSpawnModel(opts.model)) {
        args.unshift('--model', opts.model!.trim());
    }

    return new AcpSdkBackend({
        command: 'agent',
        args,
        env: filterEnv(process.env),
        flavor: 'cursor',
    });
}

export const CURSOR_ACP_REQUIRED_MESSAGE =
    'Cursor ACP mode is required for new Cursor remote sessions. Run `agent update` and verify `agent help acp`.';
