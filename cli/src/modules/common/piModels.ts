import { spawn } from 'node:child_process'
import type { PiModelSummary, PiModelsResponse } from '@hapi/protocol/apiTypes'
import { parsePiModels } from '../../pi/schemas'
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
 * The probe is spawned with discovery disabled (`--no-session,
 * --no-extensions, --no-skills, --no-prompt-templates, --no-tools`): no
 * session file is written, no user extensions run, and startup stays fast
 * (measured ~0.6s vs ~1.6-2.4s for the old table probe).
 */
const PI_PROBE_ARGS = [
    '--mode', 'rpc',
    '--no-session',
    '--no-extensions',
    '--no-skills',
    '--no-prompt-templates',
    '--no-tools',
] as const

const PROBE_RPC_ID = 'hapi-machine-models-probe'

/** Extract the get_available_models response from one stdout line, if present. */
export function parsePiModelsProbeLine(line: string): PiModelSummary[] | null {
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
    if (record.success !== true) return null
    return parsePiModels(record.data)
}

function runPiModelsProbe(): Promise<ListPiModelsForMachineResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('pi', [...PI_PROBE_ARGS], {
            env: process.env,
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
            child.kill('SIGTERM')
            settle()
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
                const availableModels = parsePiModelsProbeLine(line)
                if (availableModels !== null) {
                    finish(() => resolve({ success: true, availableModels, currentModelId: null }))
                    return
                }
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
