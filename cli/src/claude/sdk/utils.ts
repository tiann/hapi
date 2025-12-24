/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { logger } from '@/ui/logger'

/**
 * Create a clean environment without local node_modules/.bin in PATH
 * This ensures we find the global claude, not the local one
 */
export function getCleanEnv(): NodeJS.ProcessEnv {
    const env = { ...process.env }
    const cwd = process.cwd()
    const pathSep = process.platform === 'win32' ? ';' : ':'
    const pathKey = process.platform === 'win32' ? 'Path' : 'PATH'
    
    // Also check for PATH on Windows (case can vary)
    const actualPathKey = Object.keys(env).find(k => k.toLowerCase() === 'path') || pathKey
    
    if (env[actualPathKey]) {
        // Remove any path that contains the current working directory (local node_modules/.bin)
        const cleanPath = env[actualPathKey]!
            .split(pathSep)
            .filter(p => {
                const normalizedP = p.replace(/\\/g, '/').toLowerCase()
                const normalizedCwd = cwd.replace(/\\/g, '/').toLowerCase()
                return !normalizedP.startsWith(normalizedCwd)
            })
            .join(pathSep)
        env[actualPathKey] = cleanPath
        logger.debug(`[Claude SDK] Cleaned PATH, removed local paths from: ${cwd}`)
    }
    
    return env
}

/**
 * Try to find globally installed Claude CLI
 * Returns 'claude' if the command works globally (preferred method for reliability)
 * Falls back to which/where to get actual path on Unix systems
 * Runs from home directory with clean PATH to avoid picking up local node_modules/.bin
 */
function findGlobalClaudePath(): string | null {
    const homeDir = homedir()
    const cleanEnv = getCleanEnv()
    
    // PRIMARY: Check if 'claude' command works directly from home dir with clean PATH
    try {
        execSync('claude --version', { 
            encoding: 'utf8', 
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            env: cleanEnv
        })
        logger.debug('[Claude SDK] Global claude command available (checked with clean PATH)')
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
                cwd: homeDir,
                env: cleanEnv
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
