/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { spawn, execSync, type ChildProcess } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '@/ui/logger'
import type { Writable } from 'node:stream'

/**
 * Try to find Claude Code JS entrypoint in global npm modules
 */
function findNpmGlobalClaudeJs(): string | null {
    // 1. Direct check in common Windows global npm path
    if (process.platform === 'win32' && process.env.APPDATA) {
        const commonPath = join(process.env.APPDATA, 'npm', 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
        if (existsSync(commonPath)) return commonPath;
    }

    // 2. Try npm root -g
    try {
        const npmRoot = execSync('npm root -g', { encoding: 'utf-8', shell: true }).trim().replace(/[\r\n]/g, '');
        if (npmRoot) {
            const jsPath = join(npmRoot, '@anthropic-ai', 'claude-code', 'cli.js');
            if (existsSync(jsPath)) return jsPath;
        }
    } catch (e) {}

    return null;
}

/**
 * Resolve any claude command/path to the actual JS file if possible
 */
function resolveToJs(inputPath: string): string {
    if (process.platform !== 'win32') return inputPath;

    let target = inputPath;

    // If it's just 'claude', find where it is
    if (target === 'claude') {
        try {
            const where = execSync('where claude', { encoding: 'utf-8' }).trim().split(/[\r\n]+/)[0];
            if (where && existsSync(where)) target = where;
        } catch (e) {}
    }

    // Try to find neighbor JS (for NPM wrapper .cmd)
    if (target.toLowerCase().endsWith('.cmd')) {
        try {
            const potentialJs = join(dirname(target), 'node_modules', '@anthropic-ai', 'claude-code', 'cli.js');
            if (existsSync(potentialJs)) return potentialJs;
        } catch (e) {}
    }

    // If no JS found, return the original (likely the native .exe or wrapper)
    return target;
}

/**
 * Get default path to Claude Code executable.
 */
export function getDefaultClaudeCodePath(): string {
    // 1. User override
    if (process.env.HAPI_CLAUDE_PATH) {
        return resolveToJs(process.env.HAPI_CLAUDE_PATH);
    }

    // 2. Try NPM JS first (most stable for HAPI if installed)
    const npmJs = findNpmGlobalClaudeJs();
    if (npmJs) return npmJs;

    // 3. Fallback to global command (Native exe/cmd)
    return resolveToJs('claude');
}

/**
 * Log debug message
 */
export function logDebug(message: string): void {
    if (process.env.DEBUG) {
        logger.debug(message)
        console.log(message)
    }
}

/**
 * Stream async messages to stdin
 */
export async function streamToStdin(
    stream: AsyncIterable<unknown>,
    stdin: NodeJS.WritableStream,
    abort?: AbortSignal
): Promise<void> {
    for await (const message of stream) {
        if (abort?.aborted) break
        stdin.write(JSON.stringify(message) + '\n')
    }
    stdin.end()
}
