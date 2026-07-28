import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';

export async function kimiLocal(opts: {
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
    yolo?: boolean;
    plan?: boolean;
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

    const env: NodeJS.ProcessEnv = {
        ...process.env
    };

    logger.debug(`[KimiLocal] Spawning kimi with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command: 'kimi',
        args,
        cwd: opts.path,
        env,
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'KimiLocal',
        spawnName: 'kimi',
        installHint: 'Kimi CLI',
        includeCause: true,
        logExit: true
    });
}
