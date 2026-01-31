import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import { getBunGeminiPath } from './utils/bunGeminiPath';

export async function geminiLocal(opts: {
    path: string;
    sessionId: string | null;
    abort: AbortSignal;
    model?: string;
    approvalMode?: string;
    allowedTools?: string[];
    hookSettingsPath?: string;
}): Promise<void> {
    // Check if Bun-optimized version is available
    const bunGeminiPath = getBunGeminiPath();

    const args: string[] = [];

    if (opts.sessionId) {
        args.push('--resume', opts.sessionId);
    }
    if (opts.model) {
        args.push('--model', opts.model);
    }
    if (opts.approvalMode) {
        args.push('--approval-mode', opts.approvalMode);
    }
    if (opts.allowedTools && opts.allowedTools.length > 0) {
        args.push('--allowed-tools', ...opts.allowedTools);
    }

    const env: NodeJS.ProcessEnv = {
        ...process.env,
        GEMINI_PROJECT_DIR: opts.path
    };
    if (opts.hookSettingsPath) {
        env.GEMINI_CLI_SYSTEM_SETTINGS_PATH = opts.hookSettingsPath;
    }

    process.stdin.pause();
    try {
        if (bunGeminiPath) {
            // Use Bun runtime for faster startup (~2x faster than Node.js)
            logger.debug('[GeminiLocal] Using Bun-optimized Gemini CLI (faster startup)');
            await spawnWithAbort({
                command: 'bun',
                args: ['run', bunGeminiPath, ...args],
                cwd: opts.path,
                env,
                signal: opts.abort,
                shell: process.platform === 'win32',
                logLabel: 'GeminiLocal',
                spawnName: 'gemini',
                installHint: 'Gemini CLI',
                includeCause: true,
                logExit: true
            });
        } else {
            // Fallback to original gemini command (non-breaking)
            logger.debug('[GeminiLocal] Using standard Gemini CLI (fallback mode)');
            await spawnWithAbort({
                command: 'gemini',
                args,
                cwd: opts.path,
                env,
                signal: opts.abort,
                shell: process.platform === 'win32',
                logLabel: 'GeminiLocal',
                spawnName: 'gemini',
                installHint: 'Gemini CLI',
                includeCause: true,
                logExit: true
            });
        }
    } finally {
        process.stdin.resume();
        restoreTerminalState();
    }
}
