/**
 * Utility functions for Claude Code SDK integration
 * Provides helper functions for path resolution and logging
 */

import { existsSync, readFileSync } from 'node:fs'
import { execFileSync, execSync } from 'node:child_process'
import { homedir } from 'node:os'
import * as path from 'node:path'
import { logger } from '@/ui/logger'

const CLAUDE_PREFLIGHT_TIMEOUT_MS = 5_000
const WINDOWS_SHELL_SCRIPT_EXTENSIONS = new Set(['.bat', '.cmd', '.ps1'])

export type ClaudeCodeExecutableSource = 'env' | 'auto'

export interface ClaudeCodeExecutable {
    path: string
    source: ClaudeCodeExecutableSource
}

function isPathLike(value: string): boolean {
    return value.includes('/') || value.includes('\\') || /^[a-zA-Z]:/.test(value)
}

export function isClaudeCodeCommandOnly(value: string): boolean {
    return !isPathLike(value)
}

function isWindowsShellScript(value: string): boolean {
    return WINDOWS_SHELL_SCRIPT_EXTENSIONS.has(path.extname(value).toLowerCase())
}

export function getClaudeCodeExecutableShell(value: string): boolean {
    return process.platform === 'win32' && (isClaudeCodeCommandOnly(value) || isWindowsShellScript(value))
}

function normalizePathForCompare(value: string): string {
    return path.resolve(value).toLowerCase()
}

function getCurrentEntrypointPaths(): string[] {
    return [process.execPath, process.argv[1]]
        .filter((value): value is string => Boolean(value))
        .map(normalizePathForCompare)
}

function isTimeoutError(error: unknown): boolean {
    if (!error || typeof error !== 'object') {
        return false
    }
    const maybeError = error as { killed?: boolean; signal?: string; message?: string }
    return Boolean(
        maybeError.killed ||
        maybeError.signal === 'SIGTERM' ||
        maybeError.message?.includes('ETIMEDOUT') ||
        maybeError.message?.includes('timed out')
    )
}

function formatExecFailure(error: unknown): string {
    if (!error || typeof error !== 'object') {
        return String(error)
    }

    const maybeError = error as { status?: number; signal?: string; stderr?: Buffer | string; stdout?: Buffer | string; message?: string }
    const parts: string[] = []

    if (typeof maybeError.status === 'number') {
        parts.push(`exit code ${maybeError.status}`)
    }
    if (maybeError.signal) {
        parts.push(`signal ${maybeError.signal}`)
    }

    const stderr = maybeError.stderr?.toString().trim()
    const stdout = maybeError.stdout?.toString().trim()
    const output = stderr || stdout || maybeError.message
    if (output) {
        parts.push(output.slice(0, 500))
    }

    return parts.join(': ') || 'unknown error'
}

function assertNotCurrentHapiExecutable(customPath: string): void {
    const normalizedCustomPath = normalizePathForCompare(customPath)
    if (getCurrentEntrypointPaths().includes(normalizedCustomPath)) {
        throw new Error(
            `HAPI_CLAUDE_PATH points back to HAPI itself: ${customPath}. ` +
            'Set it to the Claude Code executable or a Claude-compatible wrapper.'
        )
    }
}

function assertNoObviousWrapperRecursion(customPath: string): void {
    if (!isWindowsShellScript(customPath) && path.extname(customPath).toLowerCase() !== '.sh') {
        return
    }

    let content: string
    try {
        content = readFileSync(customPath, 'utf8').toLowerCase()
    } catch {
        return
    }

    const normalizedCustomPath = normalizePathForCompare(customPath)
    const normalizedContent = content.replace(/\//g, '\\')
    const recursiveTargets = [
        customPath.toLowerCase(),
        normalizedCustomPath,
        ...getCurrentEntrypointPaths()
    ].flatMap(value => {
        const normalizedValue = value.replace(/\//g, '\\')
        return [normalizedValue, `"${normalizedValue}"`, `'${normalizedValue}'`]
    })

    if (recursiveTargets.some(target => normalizedContent.includes(target))) {
        throw new Error(
            `HAPI_CLAUDE_PATH wrapper appears to call itself or HAPI again: ${customPath}. ` +
            'Point it at a non-recursive Claude-compatible wrapper.'
        )
    }
}

function assertNoWindowsPathWrapperLoop(customPath: string): void {
    if (process.platform !== 'win32' || isClaudeCodeCommandOnly(customPath)) {
        return
    }

    let candidates: string[] = []
    try {
        candidates = execSync('where claude', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homedir()
        })
            .split(/\r?\n/)
            .map(candidate => candidate.trim())
            .filter(Boolean)
    } catch {
        return
    }

    const normalizedCustomPath = customPath.toLowerCase().replace(/\//g, '\\')
    for (const candidate of candidates) {
        if (!isWindowsShellScript(candidate)) {
            continue
        }

        let content: string
        try {
            content = readFileSync(candidate, 'utf8').toLowerCase().replace(/\//g, '\\')
        } catch {
            continue
        }

        if (content.includes(normalizedCustomPath)) {
            throw new Error(
                `HAPI_CLAUDE_PATH may recurse through PATH wrapper ${candidate}. ` +
                `That wrapper calls ${customPath}, so a Claude-compatible wrapper that delegates to ` +
                '`claude` can loop back into itself. Point PATH `claude` at the real Claude Code binary.'
            )
        }
    }
}

function preflightCustomClaudePath(customPath: string): void {
    if (isClaudeCodeCommandOnly(customPath)) {
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH command: ${customPath}`)
        return
    }

    if (!existsSync(customPath)) {
        throw new Error(`HAPI_CLAUDE_PATH does not exist: ${customPath}`)
    }

    assertNotCurrentHapiExecutable(customPath)
    assertNoObviousWrapperRecursion(customPath)
    assertNoWindowsPathWrapperLoop(customPath)

    try {
        execFileSync(customPath, ['--version'], {
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            cwd: homedir(),
            env: {
                ...process.env,
                DISABLE_AUTOUPDATER: '1'
            },
            shell: getClaudeCodeExecutableShell(customPath),
            timeout: CLAUDE_PREFLIGHT_TIMEOUT_MS,
            windowsHide: true
        })
    } catch (error) {
        if (isTimeoutError(error)) {
            throw new Error(
                `HAPI_CLAUDE_PATH preflight timed out after ${CLAUDE_PREFLIGHT_TIMEOUT_MS}ms: ${customPath}. ` +
                'If this is a wrapper, check for recursive invocation or interactive startup prompts.'
            )
        }
        logger.debug(`[Claude SDK] HAPI_CLAUDE_PATH --version preflight failed for ${customPath}: ${formatExecFailure(error)}`)
    }
}

/**
 * Find Claude executable path on Windows.
 * Returns absolute path to claude.exe for use with shell: false
 */
function findWindowsClaudePath(): string | null {
    const homeDir = homedir()

    // Known installation paths for Claude on Windows
    const candidates = [
        path.join(homeDir, '.local', 'bin', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Programs', 'claude', 'claude.exe'),
        path.join(homeDir, 'AppData', 'Local', 'Microsoft', 'WinGet', 'Packages', 'Anthropic.claude-code_Microsoft.Winget.Source_8wekyb3d8bbwe', 'claude.exe'),
    ]

    for (const candidate of candidates) {
        if (existsSync(candidate)) {
            logger.debug(`[Claude SDK] Found Windows claude.exe at: ${candidate}`)
            return candidate
        }
    }

    // Try 'where claude' to find in PATH
    try {
        const result = execSync('where claude.exe', {
            encoding: 'utf8',
            stdio: ['pipe', 'pipe', 'pipe'],
            cwd: homeDir
        }).trim().split('\n')[0].trim()
        if (result && existsSync(result)) {
            logger.debug(`[Claude SDK] Found Windows claude.exe via where: ${result}`)
            return result
        }
    } catch {
        // where didn't find it
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
export function resolveClaudeCodeExecutable(): ClaudeCodeExecutable {
    // Allow explicit override via env var
    const customClaudePath = process.env.HAPI_CLAUDE_PATH?.trim()
    if (customClaudePath) {
        preflightCustomClaudePath(customClaudePath)
        logger.debug(`[Claude SDK] Using HAPI_CLAUDE_PATH: ${customClaudePath}`)
        return { path: customClaudePath, source: 'env' }
    }

    // Find global claude
    const globalPath = findGlobalClaudePath()
    if (!globalPath) {
        throw new Error('Claude Code CLI not found on PATH. Install Claude Code or set HAPI_CLAUDE_PATH.')
    }
    return { path: globalPath, source: 'auto' }
}

export function getDefaultClaudeCodePath(): string {
    return resolveClaudeCodeExecutable().path
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
