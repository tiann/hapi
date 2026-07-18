import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import type { GrokPermissionMode } from '@hapi/protocol/types';
import { getGrokSandboxProfile } from './utils/grokSandbox';
import { buildGrokEnv } from './utils/grokEnv';

type GrokLocalOptions = {
    path: string;
    abort: AbortSignal;
    env: NodeJS.ProcessEnv;
    sessionId: string;
    resume?: boolean;
    permissionMode?: GrokPermissionMode;
    model?: string | null;
    effort?: string | null;
};

export function buildGrokLocalArgs(opts: {
    cwd: string;
    sessionId: string;
    resume?: boolean;
    permissionMode?: GrokPermissionMode;
    model?: string | null;
    effort?: string | null;
}): string[] {
    const args = ['--sandbox', getGrokSandboxProfile(opts.permissionMode)];
    if (opts.model) args.push('--model', opts.model);
    if (opts.effort) args.push('--reasoning-effort', opts.effort);
    args.push('--no-alt-screen', '--cwd', opts.cwd);
    args.push(opts.resume ? '--resume' : '--session-id', opts.sessionId);
    if (opts.permissionMode === 'safe-yolo' || opts.permissionMode === 'yolo') {
        args.push('--always-approve');
    }
    return args;
}

export function buildGrokLocalSpawnOptions(opts: GrokLocalOptions) {
    const args = buildGrokLocalArgs({
        cwd: opts.path,
        sessionId: opts.sessionId,
        resume: opts.resume,
        permissionMode: opts.permissionMode,
        model: opts.model,
        effort: opts.effort
    });
    return {
        command: 'grok',
        args,
        cwd: opts.path,
        env: buildGrokEnv(opts.env),
        signal: opts.abort,
        shell: false,
        logLabel: 'GrokLocal',
        spawnName: 'grok',
        installHint: 'Grok CLI',
        includeCause: true,
        logExit: true
    };
}

export async function grokLocal(opts: GrokLocalOptions): Promise<void> {
    const spawnOptions = buildGrokLocalSpawnOptions(opts);
    const { args } = spawnOptions;
    logger.debug(`[GrokLocal] Spawning grok with args: ${JSON.stringify(args)}`);
    await spawnWithTerminalGuard(spawnOptions);
}
