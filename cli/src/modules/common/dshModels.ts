import type { DshModelsResponse } from '@hapi/protocol/apiTypes'
import { createDshBackend } from '@/dsh/utils/dshBackend'

export type ListDshModelsForMachineResponse = DshModelsResponse

interface CacheEntry {
    expiresAt: number
    response: ListDshModelsForMachineResponse
}

const CACHE_TTL_MS = 60_000
const PROBE_TIMEOUT_MS = 30_000
let cache: CacheEntry | null = null
let inflight: Promise<ListDshModelsForMachineResponse> | null = null

/**
 * DSH models are machine-global (whatever the installed `dsh` exposes through
 * ACP configOptions), so one probe serves any spawn directory: start the ACP
 * server, open a throwaway session, and read the model config option. The
 * grouped-options flattening in AcpSdkBackend turns dsh's Zed-style grouped
 * picker into a flat `{ modelId, name }` list; ids are opaque strings (JSON
 * provider+model tuples) that callers must send back verbatim.
 */
async function runDshModelsProbe(): Promise<ListDshModelsForMachineResponse> {
    const backend = createDshBackend()
    try {
        const result = await Promise.race([
            (async () => {
                await backend.initialize()
                const sessionId = await backend.newSession({
                    cwd: process.cwd(),
                    mcpServers: []
                })
                const metadata = backend.getSessionModelsMetadata(sessionId)
                if (!metadata || metadata.availableModels.length === 0) {
                    return {
                        success: false,
                        error: 'DSH did not expose any models through ACP configOptions'
                    } satisfies ListDshModelsForMachineResponse
                }
                return {
                    success: true,
                    availableModels: metadata.availableModels,
                    currentModelId: metadata.currentModelId
                } satisfies ListDshModelsForMachineResponse
            })(),
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error(`DSH model probe timed out after ${PROBE_TIMEOUT_MS}ms`)), PROBE_TIMEOUT_MS)
            })
        ])
        return result
    } finally {
        await backend.disconnect().catch(() => {})
    }
}

export async function listDshModelsForMachine(): Promise<ListDshModelsForMachineResponse> {
    const now = Date.now()
    if (cache && cache.expiresAt > now) {
        return cache.response
    }
    if (inflight) {
        return await inflight
    }
    inflight = runDshModelsProbe()
        .then((response) => {
            cache = { expiresAt: Date.now() + CACHE_TTL_MS, response }
            return response
        })
        .catch((error: unknown) => {
            const message = error instanceof Error ? error.message : String(error)
            return { success: false, error: `Failed to list DSH models: ${message}` } satisfies ListDshModelsForMachineResponse
        })
        .finally(() => {
            inflight = null
        })
    return await inflight
}
