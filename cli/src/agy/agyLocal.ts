import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';
import { isNativeAgyConversationId } from './utils/agyBackend';
import { buildAgyEnv } from './utils/config';

export function buildAgyLocalArgs(opts: {
    additionalDirectories?: readonly string[];
    logFile?: string;
    sessionId: string | null;
    model?: string;
    permissionMode?: string;
}): string[] {
    const args: string[] = [];

    for (const dir of opts.additionalDirectories ?? []) {
        const trimmed = dir.trim();
        if (trimmed) {
            args.push('--add-dir', trimmed);
        }
    }
    if (opts.logFile?.trim()) {
        args.push('--log-file', opts.logFile.trim());
    }
    const sessionId = opts.sessionId;
    if (sessionId && isNativeAgyConversationId(sessionId)) {
        args.push('--conversation', sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.permissionMode === 'read-only' || opts.permissionMode === 'safe-yolo') {
        args.push('--sandbox');
    }
    if (opts.permissionMode === 'yolo' || opts.permissionMode === 'safe-yolo') {
        args.push('--dangerously-skip-permissions');
    }
    return args;
}

export async function agyLocal(opts: {
    additionalDirectories?: string[];
    logFile?: string;
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
    permissionMode?: string;
}): Promise<void> {
    const args = buildAgyLocalArgs(opts);

    logger.debug(`[AntigravityAgyLocal] Spawning agy with args: ${JSON.stringify(args)}`);

    await spawnWithTerminalGuard({
        command: 'agy',
        args,
        cwd: opts.path,
        env: buildAgyEnv({ model: opts.model, cwd: opts.path }),
        signal: opts.abort,
        shell: process.platform === 'win32',
        logLabel: 'AntigravityAgyLocal',
        spawnName: 'agy',
        installHint: 'Antigravity agy CLI',
        includeCause: true,
        logExit: true
    });
}
