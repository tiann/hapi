/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { homedir } from 'node:os'
import path from 'node:path'
import { logger } from '@/ui/logger'

const windowsPath = path.win32

/**
 * Find Claude executable path on Windows.
 * Returns absolute path to claude.exe for use with shell: false
 */
function resolveWindowsNpmShimExecutable(shimPath: string): string | null {
    const shimDirectory = windowsPath.dirname(shimPath)
    const executableName = windowsPath.basename(shimPath, windowsPath.extname(shimPath))
    const packageExecutable = windowsPath.join(shimDirectory, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', `${executableName}.exe`)

    if (existsSync(packageExecutable)) {
        logger.debug(`[Claude SDK] Resolved Windows npm shim ${shimPath} to ${packageExecutable}`)
        return packageExecutable
    }

    return null
}

function resolveWindowsClaudePathCandidate(candidate: string): string | null {
    if (!existsSync(candidate)) {
        return null
    }

    if (windowsPath.extname(candidate).toLowerCase() === '.exe') {
        return candidate
    }

    return resolveWindowsNpmShimExecutable(candidate)
}

function findWhereResults(command: string): string[] {
    try {
        const result = execFileSync('where.exe', [command], {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir()
        })

        return result
            .split(/\r?\n/)
            .map((line) => line.trim())
            .filter(Boolean)
    } catch {
        return []
    }
}

function findWindowsClaudePath(): string | null {
    const homeDir = homedir()

    // Known installation paths for Claude on Windows
    const candidates = [
        path.join(homeDir, '.local', 'bin', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Anthropic.claude-code_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe'),
    ]

    for (const candidate of candidates) {
        const resolved = resolveWindowsClaudePathCandidate(candidate)
        if (resolved) {
            logger.debug(`[Claude SDK] Found Windows claude.exe at: ${resolved}`)
            return resolved
        }
    }

    // Try PATH lookup. npm global installs usually expose claude.cmd/claude
    // shims, while HAPI spawns Claude with shell:false and needs the real exe.
    for (const command of ['claude.exe', 'claude.cmd', 'claude']) {
        for (const result of findWhereResults(command)) {
            const resolved = resolveWindowsClaudePathCandidate(result)
            if (resolved) {
                logger.debug(`[Claude SDK] Found Windows claude.exe via where ${command}: ${resolved}`)
                return resolved
            }
        }
    }

    return null
}

/**
 * Try to find globally installed Claude CLI
 * On Windows: Returns absolute path to claude.exe (for shell: false)
 * On Unix: Returns 'claude' if command works, or actual path via which
 * Runs from home directory to avoid local cwd side effects
 */
function findGlobalClaudePath(): string | null {
    const homeDir = homedir()

    // Windows: Always return absolute path for shell: false compatibility
    if (process.platform === 'win32') {
        return findWindowsClaudePath()
    }

    // Unix: Check if 'claude' command works directly from home dir
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

    return null
}

/**
 * Get default path to Claude Code executable.
 *
 * Environment variables:
 * - HAPI_CLAUDE_PATH: Force a specific path to claude executable
 */
export function getDefaultClaudeCodePath(): string {
    // Allow explicit override via env var. On Windows, tolerate npm
    // shim paths (`claude.cmd` / extensionless `claude`) by resolving them
    // to the real `claude.exe` because Claude is spawned with shell:false.
    if (process.env.HAPI_CLAUDE_PATH) {
        const configuredPath = process.env.HAPI_CLAUDE_PATH
        if (process.platform === 'win32') {
            const resolved = resolveWindowsClaudePathCandidate(configuredPath)
            if (resolved) {
                logger.debug(`[Claude SDK] Using resolved HAPI_CLAUDE_PATH: ${resolved}`)
                return resolved
            }
        }
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${configuredPath}`)
        return configuredPath
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
