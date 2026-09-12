import { spawn } from 'node:child_process'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { homedir } from 'node:os'
import { parse } from 'node:path'
import type { PiModelSummary, PiModelsResponse } from '@hapi/protocol/apiTypes'
import { parsePiModels } from '../../pi/schemas'
import { killProcessByChildProcess } from '../../utils/process'
import { getErrorMessage } from './rpcResponses'

export type ListPiModelsForMachineRequest = Record<string, never>

export type ListPiModelsForMachineResponse = PiModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListPiModelsForMachineResponse
}

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 15_000
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ListPiModelsForMachineResponse>>()

/**
 * Machine-level Pi model discovery via a short-lived `pi --mode rpc` probe.
 *
 * The previous `pi --list-models` text-table probe lost every field the
 * table does not print — most importantly `thinkingLevelMap`, so the
 * create-session form could never offer model-accurate thinking levels
 * (xhigh/max are map-opt-in and were permanently hidden). The RPC probe
 * returns the same full model records as the session-scoped
 * `get_available_models` RPC and goes through the same `parsePiModels`
 * schema, so machine-level and session-level catalogs cannot drift.
 *
 * Extensions must stay enabled: `pi.registerProvider` lets an extension
 * contribute whole model providers, and the old `--list-models` probe listed
 * those models. Verified with a project-local `.pi/extensions` provider:
 * `--no-extensions` returned 29 models while the default run and the old table
 * probe both returned 30 (the extension's model present). Disabling them would
 * silently hide those models from the create-session form only.
 *
 * Discovery that cannot contribute models is still disabled (`--no-session`,
 * `--no-skills`, `--no-prompt-templates`, `--no-tools`): no session file is
 * written and no skill/prompt/tool loading is paid for. The probe still starts
 * faster than the old table probe (~2.1s vs ~1.6-2.4s measured, with a 60s
 * cache in front of it).
 */
const PI_PROBE_ARGS = [
    '--mode', 'rpc',
    '--no-session',
    '--no-skills',
    '--no-prompt-templates',
    '--no-tools',
] as const

const PROBE_RPC_ID = 'hapi-machine-models-probe'

/**
 * Result of scanning one RPC stdout line for the probe response.
 *
 * - `null`: unrelated traffic (events, other responses, non-JSON noise).
 * - `models`: successful get_available_models response for our probe id.
 * - `error`: explicit failure response — surface Pi's own error text
 *   immediately instead of letting the probe run into the generic timeout
 *   (the RPC child is interactive and will not exit on its own).
 */
export type PiModelsProbeLineResult =
    | { kind: 'models'; models: PiModelSummary[] }
    | { kind: 'error'; error: string }

export function parsePiModelsProbeLine(line: string): PiModelsProbeLineResult | null {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) return null
    let parsed: unknown
    try {
        parsed = JSON.parse(trimmed)
    } catch {
        return null
    }
    if (typeof parsed !== 'object' || parsed === null) return null
    const record = parsed as Record<string, unknown>
    if (record.type !== 'response' || record.command !== 'get_available_models') return null
    // Only accept the response to our own request id so a future probe that
    // multiplexes RPCs cannot mis-attribute another get_available_models call.
    if (record.id !== PROBE_RPC_ID) return null
    if (record.success !== true) {
        const error = typeof record.error === 'string' && record.error.trim()
            ? record.error
            : 'Pi rejected the model probe request'
        return { kind: 'error', error }
    }
    return { kind: 'models', models: parsePiModels(record.data) }
}

/**
 * Working directory for the probe child.
 *
 * Normally the runner's own cwd: a runner started inside a project must keep
 * seeing that project's `.pi/extensions` providers, which the replaced
 * `--list-models` probe also surfaced (verified: a project-local provider is
 * present from the project dir and absent from home).
 *
 * A filesystem root is the exception. Under launchd/systemd the runner cwd is
 * `/`, and starting Pi there is pathological — project discovery plus
 * extensions that scan from the working directory walk the entire tree.
 * Measured on macOS with 9 global extensions: 16.8s at `/` (past
 * PROBE_TIMEOUT_MS, so discovery failed on every call) versus 1.3s at home
 * and 2.8s in a real project. There is no project to discover at a root
 * anyway, so home loses nothing there.
 */
export function resolveProbeCwd(): string {
    let cwd: string
    try {
        cwd = process.cwd()
    } catch {
        // cwd can be gone (deleted directory); home is always resolvable.
        return homedir()
    }
    return cwd === parse(cwd).root ? homedir() : cwd
}

function runPiModelsProbe(): Promise<ListPiModelsForMachineResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn(getAgentLaunchCommand('pi'), [...PI_PROBE_ARGS], {
            env: process.env,
            // Probe from the runner's cwd, falling back to home at a
            // filesystem root (see resolveProbeCwd).
            cwd: resolveProbeCwd(),
            stdio: ['pipe', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32',
        })
        let stdoutBuffer = ''
        let stderr = ''
        let settled = false

        const finish = (settle: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            // The probe child has no further use once the response (or a
            // failure) landed; never leave an interactive pi process behind.
            // killProcessByChildProcess tears down the whole tree (taskkill /T
            // on Windows, where shell:true makes `child` the shell; tree kill
            // on Unix) and returns false when something survived.
            //
            // A surviving process must not be ignored: the Windows graceful
            // path is `taskkill /T` without /F and escalates nothing on its
            // own, so a repeatedly-refused probe child would accumulate
            // interactive Pi processes. Escalate to the forced path, and only
            // settle once the tree is confirmed gone — the caller never
            // observes completion while a probe child is still alive.
            void (async () => {
                // No pid means the child never started (e.g. spawn ENOENT):
                // there is nothing to leak, and the real spawn error is
                // already on its way through the 'error' handler.
                if (!child.pid) {
                    settle()
                    return
                }
                let stopped = false
                try {
                    stopped = await killProcessByChildProcess(child, false)
                    if (!stopped) {
                        stopped = await killProcessByChildProcess(child, true)
                    }
                } catch {
                    stopped = false
                }
                if (!stopped) {
                    // Report the leak instead of caching a result that came
                    // with an orphaned child; the next call re-probes.
                    reject(new Error(
                        `Pi model probe could not be stopped (pid ${child.pid ?? 'unknown'}); refusing to report a result with a surviving probe process`
                    ))
                    return
                }
                settle()
            })()
        }

        const timeout = setTimeout(() => {
            finish(() => reject(new Error('Pi model discovery timed out')))
        }, PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdoutBuffer += chunk.toString()
            // The RPC stream is line-delimited JSON; scan every complete line
            // for the get_available_models response and ignore the rest
            // (lifecycle events, unrelated responses).
            let newlineIndex = stdoutBuffer.indexOf('\n')
            while (newlineIndex !== -1 && !settled) {
                const line = stdoutBuffer.slice(0, newlineIndex)
                stdoutBuffer = stdoutBuffer.slice(newlineIndex + 1)
                newlineIndex = stdoutBuffer.indexOf('\n')
                const probeResult = parsePiModelsProbeLine(line)
                if (probeResult === null) continue
                if (probeResult.kind === 'error') {
                    // Explicit RPC failure: surface Pi's own error right away
                    // instead of degrading it into the generic timeout.
                    finish(() => reject(new Error(probeResult.error)))
                    return
                }
                finish(() => resolve({
                    success: true,
                    availableModels: probeResult.models,
                    currentModelId: null,
                }))
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
                stderr.trim() || `pi exited with code ${code ?? 'unknown'} before answering the model probe`
            )))
        })
        // pi exiting before the request lands must surface as the close-path
        // error, not an unhandled EPIPE crash.
        child.stdin?.on('error', () => { /* handled via close */ })
        child.stdin?.write(`${JSON.stringify({ id: PROBE_RPC_ID, type: 'get_available_models' })}\n`)
    })
}

/** Clear the module-level probe cache and in-flight map between tests. */
export function _resetPiModelsCacheForTests(): void {
    cache.clear()
    inflight.clear()
}

export async function listPiModelsForMachine(): Promise<ListPiModelsForMachineResponse> {
    const now = Date.now()
    const cached = cache.get('default')
    if (cached && cached.expiresAt > now) {
        return cached.response
    }

    const existing = inflight.get('default')
    if (existing) {
        return existing
    }

    const pending = runPiModelsProbe()
        .then((response) => {
            cache.set('default', { expiresAt: now + CACHE_TTL_MS, response })
            inflight.delete('default')
            return response
        })
        .catch((error) => {
            inflight.delete('default')
            throw new Error(getErrorMessage(error, 'Failed to list Pi models'))
        })
    inflight.set('default', pending)
    return pending
}
