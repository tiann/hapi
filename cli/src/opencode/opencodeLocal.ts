import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';

export async function opencodeLocal(opts: {
    path: string;
    abort: AbortSignal;
    env: NodeJS.ProcessEnv;
    sessionId?: string;
}): Promise<void> {
    const args: string[] = [];
    if (opts.sessionId) {
        if (process.platform === 'win32' && /[&|<>^()%!"\r\n]/u.test(opts.sessionId)) {
            throw new Error('Invalid sessionId');
        }
        args.push('--session', opts.sessionId);
    }

    logger.debug(`[OpencodeLocal] Spawning opencode with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command: 'opencode',
        args,
        cwd: opts.path,
        env: opts.env,
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'OpencodeLocal',
        spawnName: 'opencode',
        installHint: 'OpenCode CLI',
        includeCause: true,
        logExit: true
    });
}
