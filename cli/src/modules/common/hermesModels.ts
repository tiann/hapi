import type { HermesModelsResponse } from '@hapi/protocol/apiTypes'
import { createHermesBackend } from '@/hermes/utils/hermesBackend'
import { resolveHermesConfigModels } from '@/hermes/utils/hermesConfiguredModels'

export type ListHermesModelsForMachineResponse = HermesModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListHermesModelsForMachineResponse
}

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 30_000
let cache: CacheEntry | null = null
let inflight: Promise<ListHermesModelsForMachineResponse> | null = null

/**
 * Hermes models are machine-global (curated models for the configured Hermes
 * provider, plus the configured default), so one ACP probe serves any spawn
 * directory: initialize `hermes acp`, open a throwaway session, and read
 * `models` metadata before disconnecting.
 */
async function runHermesModelsProbe(): Promise<ListHermesModelsForMachineResponse> {
    const backend = createHermesBackend()
    try {
        const result = await Promise.race([
            (async () => {
                await backend.initialize()
                const sessionId = await backend.newSession({
                    cwd: process.cwd(),
                    mcpServers: []
                })
                const metadata = backend.getSessionModelsMetadata(sessionId)
                const configuredModels = resolveHermesConfigModels(undefined, metadata?.currentModelId)
                const availableModels = configuredModels ?? metadata?.availableModels ?? []
                if (availableModels.length === 0) {
                    return {
                        success: false,
                        error: 'Hermes did not expose any models through ACP'
                    } satisfies ListHermesModelsForMachineResponse
                }
                return {
                    success: true,
                    availableModels,
                    currentModelId: metadata?.currentModelId ?? availableModels[0]?.modelId ?? null
                } satisfies ListHermesModelsForMachineResponse
            })(),
            new Promise<never>((_, reject) => {
                setTimeout(
                    () => reject(new Error(`Hermes model probe timed out after ${PROBE_TIMEOUT_MS}ms`)),
                    PROBE_TIMEOUT_MS
                )
            })
        ])
        return result
    } finally {
        await backend.disconnect().catch(() => {})
    }
}

export async function listHermesModelsForMachine(): Promise<ListHermesModelsForMachineResponse> {
    const now = Date.now()
    if (cache && cache.expiresAt > now) {
        return cache.response
    }
    if (inflight) {
        return await inflight
    }
    inflight = runHermesModelsProbe()
        .then((response) => {
            if (response.success) {
                cache = { expiresAt: Date.now() + CACHE_TTL_MS, response }
            }
            return response
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            return {
                success: false,
                error: `Failed to list Hermes models: ${message}`
            } satisfies ListHermesModelsForMachineResponse
        })
        .finally(() => {
            inflight = null
        })
    return await inflight
}
