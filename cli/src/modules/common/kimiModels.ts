import { spawn } from 'node:child_process'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { asString, isObject } from '@hapi/protocol'
import type { KimiModelSummary, KimiModelsResponse } from '@hapi/protocol/apiTypes'
import { readKimiLocalConfig } from '@/kimi/utils/config'
import { logger } from '@/ui/logger'
import { getErrorMessage } from './rpcResponses'

export interface ListKimiModelsForCwdRequest {
    cwd?: string
}

export type ListKimiModelsForCwdResponse = KimiModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListKimiModelsForCwdResponse
}

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 15_000
const cache = new Map<string, CacheEntry>()
const inflight = new Map<string, Promise<ListKimiModelsForCwdResponse>>()

export function buildKimiProviderListArgs(): string[] {
    return ['provider', 'list', '--json']
}

/**
 * Extract only the fields HAPI is allowed to transmit. Everything else in the
 * `kimi provider list --json` output (api keys, base urls, upstream model ids,
 * context sizes) stays on the machine.
 */
function normalizeModelEntry(entry: Record<string, unknown>, keyAlias: string | null): KimiModelSummary | null {
    const modelId = asString(entry.modelId)
        ?? asString(entry.alias)
        ?? asString(entry.id)
        ?? keyAlias
    if (!modelId) return null
    const name = asString(entry.displayName) ?? asString(entry.name) ?? undefined
    const provider = asString(entry.provider) ?? undefined
    return {
        modelId,
        ...(name ? { name } : {}),
        ...(provider ? { provider } : {})
    }
}

/**
 * Parse `kimi provider list --json`. Handles the real shape
 * `{ providers: {...}, models: { "<alias>": { provider, displayName, ... } } }`
 * plus tolerant variants: a bare `models` map, an array of model entries, and
 * a `providers` map whose entries carry nested `models`. Only whitelisted
 * fields are returned, so secrets in the payload can never leak through.
 */
export function parseKimiProviderListOutput(
    output: string,
    defaultModel?: string
): {
    availableModels: KimiModelSummary[]
    currentModelId: string | null
} {
    const availableModels: KimiModelSummary[] = []
    const seen = new Set<string>()

    const push = (entry: Record<string, unknown>, keyAlias: string | null) => {
        const model = normalizeModelEntry(entry, keyAlias)
        if (!model || seen.has(model.modelId)) return
        seen.add(model.modelId)
        availableModels.push(model)
    }

    const jsonStart = output.indexOf('{')
    const arrayStart = output.indexOf('[')
    const start = jsonStart === -1
        ? arrayStart
        : arrayStart !== -1 && arrayStart < jsonStart ? arrayStart : jsonStart
    if (start === -1) {
        throw new Error('kimi provider list produced no JSON output')
    }
    let data: unknown
    try {
        data = JSON.parse(output.slice(start))
    } catch {
        throw new Error('kimi provider list produced invalid JSON output')
    }

    const collectModelMap = (value: unknown) => {
        if (!isObject(value)) return
        for (const [alias, entry] of Object.entries(value)) {
            if (isObject(entry)) push(entry, alias)
        }
    }

    if (Array.isArray(data)) {
        for (const entry of data) {
            if (isObject(entry)) push(entry, null)
        }
    } else if (isObject(data)) {
        collectModelMap(data.models)
        if (availableModels.length === 0 && isObject(data.providers)) {
            for (const providerEntry of Object.values(data.providers)) {
                if (!isObject(providerEntry)) continue
                if (isObject(providerEntry.models)) {
                    collectModelMap(providerEntry.models)
                } else {
                    push(providerEntry, null)
                }
            }
        }
    }

    availableModels.sort((a, b) => {
        const providerOrder = (a.provider ?? '').localeCompare(b.provider ?? '')
        return providerOrder !== 0 ? providerOrder : a.modelId.localeCompare(b.modelId)
    })

    const currentModelId = defaultModel?.trim() || null
    return { availableModels, currentModelId }
}

function describeProbeExit(code: number | null, signal: NodeJS.Signals | null): string {
    if (signal) return `kimi provider list was terminated by ${signal}`
    return `kimi provider list exited with code ${code}`
}

async function runKimiProviderListProbe(): Promise<ListKimiModelsForCwdResponse> {
    return await new Promise((resolve, reject) => {
        const child = spawn(getAgentLaunchCommand('kimi'), buildKimiProviderListArgs(), {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32'
        })
        let stdout = ''
        let stderr = ''
        let settled = false

        // Exactly one of timeout / spawn error / close settles the probe, and
        // the settling work is wrapped: a throw from an event callback would
        // otherwise escape this promise and reach the runner's
        // uncaughtException shutdown handler instead of the caller's catch.
        const settle = (outcome: () => void) => {
            if (settled) return
            settled = true
            clearTimeout(timeout)
            try {
                outcome()
            } catch (error) {
                reject(error)
            }
        }

        const timeout = setTimeout(() => {
            settle(() => {
                try {
                    child.kill('SIGTERM')
                } catch (error) {
                    logger.debug('Failed to kill the Kimi model discovery probe:', error)
                }
                reject(new Error('Kimi model discovery timed out'))
            })
        }, PROBE_TIMEOUT_MS)

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString()
        })
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString()
        })
        child.on('error', (error) => {
            settle(() => reject(error))
        })
        // Parse on 'close', not 'exit': stdio must be drained first, and the
        // parser runs inside settle() so malformed output rejects the probe.
        child.on('close', (code, signal) => {
            settle(() => {
                if (code !== 0) {
                    reject(new Error(stderr.trim() || describeProbeExit(code, signal)))
                    return
                }
                const defaultModel = readKimiLocalConfig().model
                resolve({ success: true, ...parseKimiProviderListOutput(stdout, defaultModel) })
            })
        })
    })
}

export async function listKimiModelsForCwd(cwd: string): Promise<ListKimiModelsForCwdResponse> {
    const trimmed = cwd?.trim()
    if (!trimmed) return { success: false, error: 'cwd is required' }

    const cached = cache.get(trimmed)
    if (cached && cached.expiresAt > Date.now()) return cached.response

    const running = inflight.get(trimmed)
    if (running) return running

    const promise = (async () => {
        try {
            const response = await runKimiProviderListProbe()
            if (response.success) {
                cache.set(trimmed, { expiresAt: Date.now() + CACHE_TTL_MS, response })
            }
            return response
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover Kimi models')
            }
        } finally {
            inflight.delete(trimmed)
        }
    })()

    inflight.set(trimmed, promise)
    return promise
}

export function _resetKimiModelsCacheForTests(): void {
    cache.clear()
    inflight.clear()
}
