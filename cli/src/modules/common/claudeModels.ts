import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { asString, isObject } from '@hapi/protocol'
import type { ClaudeModelSummary, ClaudeModelsResponse } from '@hapi/protocol/apiTypes'
import { getDefaultClaudeCodePath } from '@/claude/sdk/utils'
import { withBunRuntimeEnv } from '@/utils/bunRuntime'
import { killProcessByChildProcess } from '@/utils/process'
import { getErrorMessage } from './rpcResponses'

export interface ListClaudeModelsForCwdRequest {
    cwd?: string
}

export type ListClaudeModelsForCwdResponse = ClaudeModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListClaudeModelsForCwdResponse
}

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 30_000

// Keyed by machine-local cwd. All instances of this CLI process on this
// machine share one process-local cache (the machine identity itself is
// implicit -- one HAPI CLI process only ever represents one machine), so cwd
// is the only dimension that can collide between two distinct catalogs
// worth caching separately. A CLI upgrade or account switch invalidates
// naturally within the 60s TTL; there is no longer-lived persistence to go
// stale across either.
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ListClaudeModelsForCwdResponse>>()

function normalizeClaudeModels(rawModels: unknown): ClaudeModelSummary[] {
    if (!Array.isArray(rawModels)) return []
    const out: ClaudeModelSummary[] = []
    for (const entry of rawModels) {
        if (!isObject(entry)) continue
        const value = asString(entry.value)
        const displayName = asString(entry.displayName)
        if (!value || !displayName) continue
        const resolvedModel = asString(entry.resolvedModel)
        const supportedEffortLevels = Array.isArray(entry.supportedEffortLevels)
            ? entry.supportedEffortLevels.filter((level): level is string => typeof level === 'string')
            : undefined

        out.push({
            value,
            displayName,
            ...(resolvedModel ? { resolvedModel } : {}),
            ...(supportedEffortLevels ? { supportedEffortLevels } : {})
        })
    }
    return out
}

/**
 * Spawn a short-lived headless `claude -p --input-format stream-json` process
 * scoped to `cwd`, send a single `list_models` control request over stdin, and
 * resolve with the parsed catalog from the first `control_response`. No
 * prompt is ever sent, so this never triggers a model call. The subprocess is
 * killed as soon as a response (or a terminal failure) is observed.
 */
function runClaudeListModelsProbe(cwd: string): Promise<ListClaudeModelsForCwdResponse> {
    return new Promise((resolve) => {
        let executable: string
        try {
            executable = getDefaultClaudeCodePath()
        } catch (error) {
            resolve({ success: false, error: getErrorMessage(error, 'Claude Code CLI not found') })
            return
        }

        const child = spawn(executable, [
            '-p',
            '--input-format', 'stream-json',
            '--output-format', 'stream-json',
            '--verbose',
            // No prompt is ever sent and no MCP servers are configured for
            // this call, so there is no reason to let the workspace's own
            // .mcp.json boot project MCP servers just to answer list_models.
            '--strict-mcp-config',
            // This probe can run against an arbitrary cwd before the user
            // ever starts a session there (e.g. NewSession re-probes on every
            // directory change), so it must not load that directory's own
            // .claude/settings*.json -- a project SessionStart hook would
            // otherwise get to run arbitrary commands just from opening the
            // model picker. 'user' (not '') keeps user-level settings so
            // auth-dependent setups still resolve a catalog.
            '--setting-sources', 'user'
        ], {
            cwd,
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: false,
            windowsHide: process.platform === 'win32',
            // Matches every other claude spawn in this repo (query.ts,
            // claudeLocal.ts): without this, BUN_BE_BUN is inherited from the
            // parent HAPI process and can make the claude binary itself try
            // to run under Bun's Node-compat shim instead of its own runtime.
            env: withBunRuntimeEnv(process.env, { allowBunBeBun: false })
        })

        let settled = false
        const finish = (result: ListClaudeModelsForCwdResponse) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            // killProcessByChildProcess(..., true) kills the whole process
            // tree (Unix) -- a bare child.kill() only signals this pid, and
            // --strict-mcp-config aside, a `claude -p` invocation can still
            // spawn its own subprocesses that would otherwise be orphaned on
            // every cache-miss probe.
            void killProcessByChildProcess(child, true).catch(() => {
                // Best-effort teardown; the result above is already decided.
            })
            resolve(result)
        }

        const timeout = setTimeout(() => {
            finish({ success: false, error: 'Timed out listing Claude models' })
        }, PROBE_TIMEOUT_MS)

        const requestId = randomUUID()
        let buffer = ''
        let stderr = ''

        child.stdout?.on('data', (chunk: Buffer) => {
            buffer += chunk.toString()
            let newlineIndex: number
            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex).trim()
                buffer = buffer.slice(newlineIndex + 1)
                if (!line) continue

                let message: unknown
                try {
                    message = JSON.parse(line)
                } catch {
                    continue
                }
                if (!isObject(message) || message.type !== 'control_response') continue

                const response = isObject(message.response) ? message.response : null
                // Query (query.ts) routes control_responses by request_id for
                // exactly this reason: nothing stops another in-flight
                // control_response (this same claude process can field
                // others, e.g. a stray permission prompt) from arriving
                // first. Without this check, that unrelated response gets
                // parsed as the model list, its absent `models` field
                // normalizes to `[]`, and the probe fails with the misleading
                // "Claude reported no models" instead of waiting for the
                // actual list_models reply.
                if (asString(response?.request_id) !== requestId) continue
                const payload = response && isObject(response.response) ? response.response : null
                const models = payload ? normalizeClaudeModels(payload.models) : []

                if (models.length > 0) {
                    finish({ success: true, models })
                } else {
                    finish({ success: false, error: asString(response?.error) ?? 'Claude reported no models' })
                }
            }
        })

        child.stderr?.on('data', (chunk: Buffer) => {
            stderr += chunk.toString()
        })

        child.on('error', (error) => {
            finish({ success: false, error: getErrorMessage(error, 'Failed to spawn Claude for model discovery') })
        })

        child.on('exit', (code) => {
            finish({ success: false, error: stderr.trim() || `claude exited with code ${code ?? 'unknown'}` })
        })

        // Writing to stdin after the child has already exited (e.g. it died
        // before we got to the write below) emits an 'error' on the stream
        // itself -- a plain Node Socket/Writable, not this ChildProcess --
        // and an unhandled 'error' event is a hard throw that would escape
        // this Promise executor entirely. Left unhandled, that throw becomes
        // an uncaughtException in the CLI process, and run.ts's global
        // handler treats any uncaughtException as fatal and calls
        // requestShutdown() -- i.e. one failed model-catalog probe could take
        // the whole runner daemon down. child.on('error') above only covers
        // spawn failures, not this. The 'exit'/'error' handlers above already
        // decide the probe's result, so this handler only needs to swallow
        // the event and prevent the throw.
        child.stdin?.on('error', () => {})

        child.stdin?.write(JSON.stringify({
            request_id: requestId,
            type: 'control_request',
            request: { subtype: 'list_models' }
        }) + '\n')
    })
}

/**
 * Discover the Claude model catalog the CLI (and the account/org policy
 * behind it) actually offers for `cwd`, via the `list_models` control
 * request. Results are cached for 60 seconds per cwd; concurrent requests
 * for the same cwd are coalesced via a single-flight promise so we never
 * spawn more than one probe at a time per cwd. Failures and empty catalogs
 * are never cached, so a transient probe failure does not wedge the picker
 * into a fallback for the rest of the TTL window.
 */
export async function listClaudeModelsForCwd(cwd: string): Promise<ListClaudeModelsForCwdResponse> {
    const trimmed = cwd?.trim()
    if (!trimmed) {
        return { success: false, error: 'cwd is required' }
    }

    const cached = cache.get(trimmed)
    if (cached && cached.expiresAt > Date.now()) {
        return cached.response
    }

    const existing = inflight.get(trimmed)
    if (existing) {
        return existing
    }

    const promise = (async () => {
        try {
            const response = await runClaudeListModelsProbe(trimmed)
            if (response.success && (response.models?.length ?? 0) > 0) {
                cache.set(trimmed, {
                    expiresAt: Date.now() + CACHE_TTL_MS,
                    response
                })
            }
            return response
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover Claude models')
            } satisfies ListClaudeModelsForCwdResponse
        } finally {
            inflight.delete(trimmed)
        }
    })()

    inflight.set(trimmed, promise)
    return promise
}

/**
 * Clear the in-process cache. Exposed for tests.
 */
export function _resetClaudeModelsCacheForTests(): void {
    cache.clear()
    inflight.clear()
}
