/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'

/**
 * Try to find globally installed Claude CLI
 * Returns 'claude' if the command works globally (preferred method for reliability)
 * Falls back to which/where to get actual path on Unix systems
 * Runs from home directory to avoid local cwd side effects
 */
function findGlobalClaudePath(): string | null {
    const homeDir = homedir()
    
    // PRIMARY: Check if 'claude' command works directly from home dir
    try {
        execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir
        })
        logger.debug('[Claude SDK] Global claude command available')
        return 'claude'
    } catch {
        // claude command not available globally
    }

    // FALLBACK for Unix: try which to get actual path
    if (process.platform !== 'win32') {
        try {
            const result = execSync('which claude', { 
                encoding: 'utf8', 
                stdio: ['pipe', 'pipe', 'pipe'],
                cwd: homeDir
            }).trim()
            if (result && existsSync(result)) {
                logger.debug(`[Claude SDK] Found global claude path via which: ${result}`)
                return result
            }
        } catch {
            // which didn't find it
        }
    }
    
    return null
}

/**
 * Get default path to Claude Code executable.
 *
 * Environment variables:
 * - HAPI_CLAUDE_PATH: Force a specific path to claude executable
 */
export function getDefaultClaudeCodePath(): string {
    // Allow explicit override via env var
    if (process.env.HAPI_CLAUDE_PATH) {
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${process.env.HAPI_CLAUDE_PATH}`)
        return process.env.HAPI_CLAUDE_PATH
    }

    // Find global claude
    const globalPath = findGlobalClaudePath()
    if (!globalPath) {
        throw new Error('Claude Code CLI not found on PATH. Install Claude Code or set HAPI_CLAUDE_PATH.')
    }
    return globalPath
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
