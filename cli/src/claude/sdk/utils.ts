/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync, readFileSync } from 'node:fs'
import { execSync } from 'node:child_process'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { logger } from '@/ui/logger'

/**
 * Resolved Claude executable info.
 * - command: the binary to invoke (absolute path to .exe, or node executable for npm .cmd installs)
 * - prependArgs: args to insert before user args (e.g. the JS entry script for npm installs)
 */
export type ClaudeExecutable = {
    command: string
    prependArgs: string[]
}

/** Shorthand for constructing a node-based ClaudeExecutable from a JS entry script. */
function nodeExecutable(entryScript: string): ClaudeExecutable {
    const nodeCommand = process.env.NODE ?? 'node'
    return { command: nodeCommand, prependArgs: [entryScript] }
}

/**
 * Resolve a npm .cmd wrapper to its underlying JS entry script.
 * We extract the node_modules relative path from the .cmd and resolve it
 * against the .cmd file's directory.
 */
function resolveNpmCmdEntryScript(cmdPath: string): string | null {
    try {
        const content = readFileSync(cmdPath, 'utf8')
        // Match the node_modules entry script path regardless of how the prefix is expressed
        const match = content.match(/(node_modules\\[^"*\n]+\.(?:mjs|cjs|js))/i)
        if (match) {
            const relativePath = match[1].replace(/\\/g, '/')
            const cmdDir = dirname(cmdPath)
            const entryScript = join(cmdDir, relativePath)
            if (existsSync(entryScript)) {
                logger.debug(`[Claude SDK] Resolved .cmd entry script: ${entryScript}`)
                return entryScript
            }
        }
    } catch {
        // Failed to parse .cmd file
    }

    // Fallback: look for the package.json bin entry directly
    const cmdDir = dirname(cmdPath)
    const pkgJsonPath = join(cmdDir, 'node_modules', '@anthropic-ai', 'claude-code', 'package.json')
    try {
        if (existsSync(pkgJsonPath)) {
            const pkg = JSON.parse(readFileSync(pkgJsonPath, 'utf8'))
            const binEntry = typeof pkg.bin === 'string' ? pkg.bin : pkg.bin?.claude
            if (binEntry) {
                const entryScript = join(cmdDir, 'node_modules', '@anthropic-ai', 'claude-code', binEntry)
                if (existsSync(entryScript)) {
                    logger.debug(`[Claude SDK] Resolved entry script from package.json: ${entryScript}`)
                    return entryScript
                }
            }
        }
    } catch {
        // Failed to read package.json
    }

    return null
}

/**
 * Find Claude executable on Windows.
 * Returns ClaudeExecutable with absolute paths, no shell needed.
 *
 * Search order:
 * 1. Known .exe install paths (installer, winget)
 * 2. npm global install directories (.cmd → resolved to node + JS entry)
 * 3. 'where claude' fallback
 */
function findWindowsClaudePath(): ClaudeExecutable | null {
    const homeDir = homedir()

    // Known installation paths for Claude on Windows (.exe from installer/winget)
    const exeCandidates = [
        join(homeDir, '.local', 'bin', 'claude.exe'),
        join(homeDir, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        join(homeDir, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Anthropic.claude-code_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe'),
    ]

    for (const candidate of exeCandidates) {
        if (existsSync(candidate)) {
            logger.debug(`[Claude SDK] Found Windows claude.exe at: ${candidate}`)
            return { command: candidate, prependArgs: [] }
        }
    }

    // npm global install locations (.cmd wrappers → resolve to node + JS entry)
    const npmPrefixPaths = getNpmGlobalPrefixes()
    for (const prefix of npmPrefixPaths) {
        const cmdPath = join(prefix, 'claude.cmd')
        if (existsSync(cmdPath)) {
            const entryScript = resolveNpmCmdEntryScript(cmdPath)
            if (entryScript) {
                logger.debug(`[Claude SDK] Found npm global claude, using node + ${entryScript}`)
                return nodeExecutable(entryScript)
            }
            // .cmd exists but entry script unresolvable — don't retry via 'where'
            logger.debug(`[Claude SDK] Found claude.cmd but could not resolve entry script: ${cmdPath}`)
            return null
        }
    }

    // Try 'where claude' to find any extension (.exe, .cmd, .bat, etc.) in PATH
    try {
        const results = execSync('where claude', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            timeout: 5000
        }).trim().split('\n').map(s => s.trim()).filter(Boolean)

        for (const result of results) {
            if (!existsSync(result)) continue
            if (result.toLowerCase().endsWith('.exe')) {
                logger.debug(`[Claude SDK] Found Windows claude.exe via where: ${result}`)
                return { command: result, prependArgs: [] }
            }
            if (result.toLowerCase().endsWith('.cmd')) {
                const entryScript = resolveNpmCmdEntryScript(result)
                if (entryScript) {
                    logger.debug(`[Claude SDK] Found claude.cmd via where, using node + ${entryScript}`)
                    return nodeExecutable(entryScript)
                }
            }
        }
    } catch {
        // where didn't find it
    }

    return null
}

/**
 * Get potential npm global prefix directories on Windows.
 */
function getNpmGlobalPrefixes(): string[] {
    const homeDir = homedir()
    const prefixes: string[] = []
    const normalize = (p: string) => p.toLowerCase().replace(/[\\/]+$/, '')

    // Default npm global prefix on Windows: %APPDATA%\npm
    const appData = process.env.APPDATA
    if (appData) {
        prefixes.push(join(appData, 'npm'))
    }

    // Try to get actual npm prefix via 'npm config get prefix'
    try {
        const npmPrefix = execSync('npm config get prefix', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            timeout: 5000
        }).trim()
        if (npmPrefix && !prefixes.some(p => normalize(p) === normalize(npmPrefix))) {
            prefixes.push(npmPrefix)
        }
    } catch {
        // npm not available or timed out
    }

    return prefixes
}

/**
 * Try to find globally installed Claude CLI.
 * On Windows: Returns ClaudeExecutable with absolute path (no shell needed)
 * On Unix: Returns absolute path via which, or 'claude' command as fallback
 * Runs from home directory to avoid local cwd side effects
 */
function findGlobalClaudePath(): ClaudeExecutable | null {
    const homeDir = homedir()

    if (process.platform === 'win32') {
        return findWindowsClaudePath()
    }

    // Unix: try 'which' first (fast PATH lookup, no startup overhead)
    try {
        const result = execSync('which claude', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            timeout: 5000
        }).trim()
        if (result && existsSync(result)) {
            logger.debug(`[Claude SDK] Found global claude path via which: ${result}`)
            return { command: result, prependArgs: [] }
        }
    } catch {
        // which didn't find it
    }

    // Fallback: verify 'claude' is available by running it
    try {
        execSync('claude --version', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir,
            timeout: 5000
        })
        logger.debug('[Claude SDK] Global claude command available')
        return { command: 'claude', prependArgs: [] }
    } catch {
        // claude command not available globally
    }

    return null
}

// Module-level cache — the resolved executable is stable for the process lifetime
let _cachedExecutable: ClaudeExecutable | undefined

/**
 * Get default Claude Code executable info.
 *
 * Returns { command, prependArgs } so callers can spawn as:
 *   spawn(command, [...prependArgs, ...userArgs], { shell: false })
 *
 * Environment variables:
 * - HAPI_CLAUDE_PATH: Force a specific path to claude executable
 */
export function getClaudeCodeExecutable(): ClaudeExecutable {
    // Env var override is always checked fresh (allows runtime changes)
    if (process.env.HAPI_CLAUDE_PATH) {
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${process.env.HAPI_CLAUDE_PATH}`)
        return { command: process.env.HAPI_CLAUDE_PATH, prependArgs: [] }
    }

    if (_cachedExecutable) return _cachedExecutable

    const result = findGlobalClaudePath()
    if (!result) {
        throw new Error('Claude Code CLI not found on PATH. Install Claude Code or set HAPI_CLAUDE_PATH.')
    }
    _cachedExecutable = result
    return result
}

/**
 * Resolve a claude executable path string to a ClaudeExecutable.
 * Handles .cmd files from npm global install by extracting the underlying
 * JS entry script and using node directly (avoiding shell: true).
 */
export function resolveClaudeExecutable(executablePath: string): ClaudeExecutable {
    if (process.platform === 'win32') {
        const lower = executablePath.toLowerCase()
        if (lower.endsWith('.cmd') || lower.endsWith('.bat')) {
            const entryScript = resolveNpmCmdEntryScript(executablePath)
            if (entryScript) {
                return nodeExecutable(entryScript)
            }
        }
    }
    return { command: executablePath, prependArgs: [] }
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
