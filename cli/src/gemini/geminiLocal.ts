import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { spawnWithAbort } from '@/utils/spawnWithAbort';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

/**
 * Check if Bun-optimized Gemini CLI is available
 * Returns the path if available, null otherwise
 */
function getBunGeminiPath(): string | null {
    try {
        const bunGeminiPath = join(homedir(), '.bun', 'install', 'global', 'node_modules', '@google', 'gemini-cli', 'dist', 'index.js');

        // Check if Bun version exists
        if (!existsSync(bunGeminiPath)) {
            return null;
        }

        // Check if bun command is available
        const bunCheck = spawnSync('bun', ['--version'], { stdio: 'ignore' });

        if (bunCheck.error || bunCheck.status !== 0) {
            logger.debug('[GeminiLocal] Bun command not available, falling back to standard Gemini CLI');
            return null;
        }

        return bunGeminiPath;
    } catch (error) {
        logger.debug('[GeminiLocal] Error checking Bun availability:', error);
        return null;
    }
}

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
            // Use Bun runtime for faster startup
            logger.info('[GeminiLocal] Using Bun-optimized Gemini CLI (faster startup)');
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
            logger.info('[GeminiLocal] Using standard Gemini CLI (fallback mode)');
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
