import { logger } from '@/ui/logger';
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard';

/**
 * Filter out 'resume' subcommand which is managed internally by hapi.
 * Cursor CLI format: `agent resume` or `agent resume <chatId>`
 */
export function filterResumeSubcommand(args: string[]): string[] {
    if (args.length === 0 || args[0] !== 'resume') {
        return args;
    }

    if (args.length > 1 && !args[1].startsWith('-')) {
        logger.debug(`[CursorLocal] Filtered 'resume ${args[1]}' - session managed by hapi`);
        return args.slice(2);
    }

    logger.debug(`[CursorLocal] Filtered 'resume' - session managed by hapi`);
    return args.slice(1);
}

export async function cursorLocal(opts: {
    abort: AbortSignal;
    chatId: string | null;
    path: string;
    model?: string;
    mode?: 'plan' | 'ask' | 'debug';
    yolo?: boolean;
    autoReview?: boolean;
    worktree?: boolean | string;
    addDirs?: readonly string[];
    onChatFound?: (chatId: string) => void;
    cursorArgs?: string[];
}): Promise<void> {
    const args: string[] = [];

    if (opts.chatId) {
        args.push('--resume', opts.chatId);
        opts.onChatFound?.(opts.chatId);
    }

    if (opts.model) {
        args.push('--model', opts.model);
    }

    if (opts.mode) {
        args.push('--mode', opts.mode);
    }

    if (opts.yolo) {
        args.push('--yolo');
    }

    if (opts.autoReview) {
        args.push('--auto-review');
    }

    if (opts.worktree !== undefined && opts.worktree !== false) {
        args.push('--worktree');
        if (typeof opts.worktree === 'string' && opts.worktree.trim()) {
            args.push(opts.worktree.trim());
        }
    }

    for (const dir of opts.addDirs ?? []) {
        const trimmed = dir.trim();
        if (trimmed) {
            args.push('--add-dir', trimmed);
        }
    }

    if (opts.cursorArgs) {
        const safeArgs = filterResumeSubcommand(opts.cursorArgs);
        args.push(...safeArgs);
    }

    logger.debug(`[CursorLocal] Spawning agent with args: ${JSON.stringify(args)}`);

    if (opts.abort.aborted) {
        logger.debug('[CursorLocal] Abort already signaled before spawn; skipping launch');
        return;
    }

    await spawnWithTerminalGuard({
        command: 'agent',
        args,
        cwd: opts.path,
        env: process.env,
        signal: opts.abort,
        logLabel: 'CursorLocal',
        spawnName: 'agent',
        installHint: 'Cursor Agent CLI (curl https://cursor.com/install -fsS | bash)',
        includeCause: true,
        logExit: true,
        shell: process.platform === 'win32'
    });
}
