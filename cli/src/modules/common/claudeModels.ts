import { spawn } from 'node:child_process'
import { homedir } from 'node:os'
import type { ClaudeModelSummary, ClaudeModelsResponse } from '@hapi/protocol/apiTypes'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { killProcessByChildProcess } from '../../utils/process'
import { getErrorMessage } from './rpcResponses'

export type ListClaudeModelsRequest = Record<string, never>

export type ListClaudeModelsResponse = ClaudeModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListClaudeModelsResponse
}

// The catalog changes rarely (a CLI update, a different login, an alias the
// service moves to a newer model) and each probe starts a full claude process
// (~0.75s), so a successful answer is kept for a few minutes. Failures are not
// cached: a user who just logged in should not wait out the TTL.
const CACHE_TTL_MS = 5 * 60_000
const PROBE_TIMEOUT_MS = 15_000
const PROBE_REQUEST_ID = 'hapi-claude-models-probe'
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ListClaudeModelsResponse>>()

/**
 * Machine-level discovery of the models the `claude` CLI offers, read from the
 * `models` field of its `initialize` control response. No prompt is sent, so
 * the probe starts no turn and writes no transcript.
 *
 * `claude --print` loads the working directory's `.claude/settings*.json` and
 * `.mcp.json` without a workspace trust prompt, so any project hook or MCP
 * server there would run. The probe therefore runs from the home directory
 * and loads only user settings, no MCP servers, and no hooks at all (the
 * user's own hooks would otherwise fire on every catalog refresh).
 *
 * User settings stay loaded so the probe sees the same `env` a session does
 * (e.g. `ANTHROPIC_DEFAULT_OPUS_MODEL` changes what `opus` resolves to).
 * Project settings that redefine model aliases are ignored here, so in such
 * a directory the catalog can differ from what the session resolves.
 */
const CLAUDE_MODELS_PROBE_ARGS = [
    '--print',
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--setting-sources', 'user',
    '--strict-mcp-config',
    '--settings', JSON.stringify({ disableAllHooks: true }),
] as const

export type ClaudeModelsProbeLineResult =
    | { kind: 'models'; models: ClaudeModelSummary[] }
    | { kind: 'error'; error: string }

function asRecord(value: unknown): Record<string, unknown> | null {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null
}

function optionalString(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value : undefined
}

/**
 * A row without `supportsEffort` (or with `null`) has no effort control, but
 * only when the CLI reports effort support at all: a CLI that predates the
 * field would otherwise hide effort for every model. A model that supports
 * effort without listing levels keeps them unknown.
 */
function parseClaudeCatalog(rawModels: unknown): ClaudeModelSummary[] {
    if (!Array.isArray(rawModels)) {
        return []
    }
    const rows = rawModels.map(asRecord).filter((row): row is Record<string, unknown> => row !== null)
    const reportsEffortSupport = rows.some((row) => 'supportsEffort' in row)
    const models: ClaudeModelSummary[] = []
    for (const row of rows) {
        const value = optionalString(row.value)
        if (!value) {
            continue
        }
        const model: ClaudeModelSummary = { value }
        const displayName = optionalString(row.displayName)
        if (displayName) model.displayName = displayName
        if (reportsEffortSupport && row.supportsEffort !== true) {
            model.effortLevels = []
        } else if (Array.isArray(row.supportedEffortLevels)) {
            model.effortLevels = row.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
        }
        models.push(model)
    }
    return models
}

/** Scans one stdout line for the answer to the probe's initialize request. */
export function parseClaudeModelsProbeLine(line: string): ClaudeModelsProbeLineResult | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch {
        return null
    }
    const message = asRecord(parsed)
    if (message?.type !== 'control_response') return null
    const response = asRecord(message.response)
    if (response?.request_id !== PROBE_REQUEST_ID) return null
    if (response.subtype !== 'success') {
        return { kind: 'error', error: optionalString(response.error) ?? 'Claude rejected the model probe request' }
    }
    return { kind: 'models', models: parseClaudeCatalog(asRecord(response.response)?.models) }
}

function runClaudeModelsProbe(executable: string): Promise<ListClaudeModelsResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn(executable, [...CLAUDE_MODELS_PROBE_ARGS], {
            cwd: homedir(),
            env: withBunRuntimeEnv(process.env, { allowBunBeBun: false }),
            stdio: ['pipe', 'pipe', 'pipe'],
            // getDefaultClaudeCodePath resolves an absolute path (claude.exe on
            // Windows), matching how sessions spawn it.
            shell: false,
            windowsHide: process.platform === 'win32',
        })
        let stdoutBuffer = ''
        let stderr = ''
        let settled = false

        // The claude process stays up waiting for input, so every outcome
        // stops it before the caller sees a result.
        const finish = (settle: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            void (async () => {
                if (!child.pid) {
                    settle()
                    return
                }
                let stopped = false
                try {
                    stopped = await killProcessByChildProcess(child, false)
                        || await killProcessByChildProcess(child, true)
                } catch {
                    stopped = false
                }
                if (!stopped) {
                    reject(new Error(`Claude model probe could not be stopped (pid ${child.pid})`))
                    return
                }
                settle()
            })()
        }

        const timeout = setTimeout(() => {
            finish(() => reject(new Error('Claude model discovery timed out')))
        }, PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdoutBuffer += chunk.toString()
            let newlineIndex = stdoutBuffer.indexOf('\n')
            while (newlineIndex !== -1 && !settled) {
                const line = stdoutBuffer.slice(0, newlineIndex)
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
                newlineIndex = stdoutBuffer.indexOf('\n')
                const result = parseClaudeModelsProbeLine(line)
                if (result === null) continue
                if (result.kind === 'error') {
                    finish(() => reject(new Error(result.error)))
                    return
                }
                if (result.models.length === 0) {
                    finish(() => reject(new Error('Claude reported no models')))
                    return
                }
                finish(() => resolve({ success: true, availableModels: result.models }))
                return
            }
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            finish(() => reject(error))
        })
        child.on('close', (code) => {
            finish(() => reject(new Error(
                stderr.trim() || `claude exited with code ${code ?? 'unknown'} before answering the model probe`
            )))
        })
        // An early exit surfaces through 'close', not as an unhandled EPIPE.
        child.stdin?.on('error', () => { /* handled via close */ })
        child.stdin?.write(`${JSON.stringify({
            type: 'control_request',
            request_id: PROBE_REQUEST_ID,
            request: { subtype: 'initialize' },
        })}\n`)
    })
}

/** Clear the module-level probe cache and in-flight map between tests. */
export function _resetClaudeModelsCacheForTests(): void {
    cache.clear()
    inflight.clear()
}

/** Throws on failure; the RPC handler turns that into an error response. */
export async function listClaudeModels(): Promise<ListClaudeModelsResponse> {
    // Keyed by executable: HAPI_CLAUDE_PATH can point a runner at a different
    // claude install, whose catalog is its own.
    const executable = getDefaultClaudeCodePath()
    const now = Date.now()
    const cached = cache.get(executable)
    if (cached && cached.expiresAt > now) {
        return cached.response
    }

    const existing = inflight.get(executable)
    if (existing) {
        return existing
    }

    const pending = runClaudeModelsProbe(executable)
        .then((response) => {
            cache.set(executable, { expiresAt: Date.now() + CACHE_TTL_MS, response })
            return response
        })
        .catch((error) => {
            throw new Error(getErrorMessage(error, 'Failed to list Claude models'))
        })
        .finally(() => {
            inflight.delete(executable)
        })
    inflight.set(executable, pending)
    return pending
}
