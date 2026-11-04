import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { isPeerToolsDisabled, withPeerToolsPreference } from '@/modules/common/peerTools';

export async function kimiLocal(opts: {
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
    yolo?: boolean;
    plan?: boolean;
    /** Session peer-tools snapshot; resolved preference pins the child env. */
    peerToolsDisabled?: boolean;
}): Promise<void> {
    const args: string[] = [];

    if (opts.sessionId) {
        args.push('--session', opts.sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.yolo) {
        args.push('--yolo');
    }
    if (opts.plan) {
        args.push('--plan');
    }

    logger.debug(`[KimiLocal] Spawning kimi with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command: getAgentLaunchCommand('kimi'),
        args,
        cwd: opts.path,
        // Pin the session's peer-tools preference so a Kimi agent shelling
        // `hapi ping-peer` resolves it in the fresh child process (#2056).
        env: withPeerToolsPreference(opts.peerToolsDisabled ?? isPeerToolsDisabled()),
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'KimiLocal',
        spawnName: 'kimi',
        installHint: 'Kimi CLI',
        includeCause: true,
        logExit: true
    });
}
