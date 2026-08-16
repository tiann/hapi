import { spawn } from 'node:child_process'
import type { PiModelSummary, PiModelsResponse } from '@hapi/protocol/apiTypes'
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
 * Parse the `pi --list-models` table:
 *
 * ```
 * provider      model                     context  max-out  thinking  images
 * openai-codex  gpt-5.6-sol              272K     128K     yes       yes
 * ```
 *
 * Column values never contain whitespace, so splitting on runs of whitespace
 * is stable. `context`/`max-out` are human sizes (`128K`, `1M`, `202.8K`);
 * they are retained as strings — the session-scoped `get_available_models`
 * RPC remains the authoritative source for the numeric context window.
 */
export function parsePiModelsTable(output: string): PiModelSummary[] {
    const models: PiModelSummary[] = []
    const seen = new Set<string>()

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim()
        if (!line || line.startsWith('provider') || line.startsWith('===')) {
            continue
        }
        const columns = line.split(/\s{2,}/)
        if (columns.length < 5) {
            continue
        }
        const [provider, modelId, , , thinking] = columns
        if (!provider || !modelId || seen.has(`${provider}/${modelId}`)) {
            continue
        }
        seen.add(`${provider}/${modelId}`)
        models.push({
            provider,
            modelId,
            reasoning: thinking === 'yes',
        })
    }

    return models
}

function runPiModelsProbe(): Promise<ListPiModelsForMachineResponse> {
    return new Promise((resolve, reject) => {
        const child = spawn('pi', ['--list-models'], {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32',
        })
        let stdout = ''
        let stderr = ''
        let settled = false

        const timeout = setTimeout(() => {
            if (settled) return
            settled = true
            child.kill('SIGTERM')
            reject(new Error('Pi model discovery timed out'))
        }, PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            reject(error)
        })
        child.on('close', (code) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            if (code !== 0) {
                reject(new Error(
                    stderr.trim() || `pi --list-models exited with code ${code ?? 'unknown'}`
                ))
                return
            }
            const availableModels = parsePiModelsTable(stdout)
            resolve({ success: true, availableModels, currentModelId: null })
        })
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
