/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { spawn, execSync, type ChildProcess, type ExecSyncOptionsWithStringEncoding } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { logger } from '@/ui/logger'
import type { Writable } from 'node:stream'

/**
 * Try to find globally installed Claude CLI
 * Returns 'claude' if the command works globally (preferred method for reliability)
 */
function findGlobalClaudePath(): string | null {
    // PRIMARY: Check if 'claude' command works directly from home dir
    try {
        execSync('claude --version', {
            stdio: 'ignore',
            timeout: 1000,
            encoding: 'utf-8'
        } as any)
        return 'claude'
    } catch (e) {
        // Ignore
    }

    // claude command not available globally
    // Try to find it via which/where
    try {
        const command = process.platform === 'win32' ? 'where claude' : 'which claude'
        const result = execSync(command, { encoding: 'utf-8' } as any).trim().split('\r\n')[0].split('\n')[0];
        if (result && existsSync(result.trim())) {
            return result.trim()
        }
    } catch (e) {
        // Ignore
    }

    return null
}

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
        const npmRoot = execSync('npm root -g', { encoding: 'utf-8' } as any).trim().replace(/[\r\n]/g, '');
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
            const where = execSync('where claude', { encoding: 'utf-8' } as any).trim().split(/[\r\n]+/)[0];
            if (where) target = where;
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
