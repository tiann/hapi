import type { DshModelsResponse, DshReasoningEffortOption } from '@hapi/protocol/apiTypes'
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
 *
 * Reasoning efforts are enumerated per model by switching the throwaway
 * session onto each candidate (`session/set_config_option` re-advertises the
 * full configOptions for the new model, and AcpSdkBackend captures them), then
 * reading the `reasoning_effort` option (category thought_level). The options
 * are provider-level for the stock deepseek adapter, but the switch is the
 * only agent-agnostic way to learn each model's space — and a model whose
 * switch fails simply carries no reasoningEfforts (the UI hides the effort
 * field for it). The session is throwaway and closed right after.
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
                    // dsh sessions are durable on disk and session/new always
                    // flushes: without an explicit session/close (advertised
                    // under sessionCapabilities), every probe would leave one
                    // throwaway durable session behind in ~/.dsh. Best effort —
                    // a close failure must not mask the probe result, and the
                    // disconnect below still tears the child down.
                    await backend.sendExtensionRequest('session/close', { sessionId }, { timeoutMs: 5000 })
                        .catch(() => {})
                    return {
                        success: false,
                        error: 'DSH did not expose any models through ACP configOptions'
                    } satisfies ListDshModelsForMachineResponse
                }

                const modelOption = backend.getConfigOptionByCategory(sessionId, 'model')
                const effortByModel = new Map<string, DshReasoningEffortOption[]>()
                const currentThoughtLevel = backend.getConfigOptionByCategory(sessionId, 'thought_level')
                if (metadata.currentModelId && currentThoughtLevel) {
                    effortByModel.set(metadata.currentModelId, currentThoughtLevel.options)
                }
                if (modelOption) {
                    for (const model of metadata.availableModels) {
                        if (model.modelId === metadata.currentModelId) continue
                        try {
                            await backend.setConfigOption(sessionId, modelOption.id, model.modelId)
                            const thoughtLevel = backend.getConfigOptionByCategory(sessionId, 'thought_level')
                            if (thoughtLevel) {
                                effortByModel.set(model.modelId, thoughtLevel.options)
                            }
                        } catch {
                            // One unswitchable model must not fail the whole
                            // catalog: leave its entry without efforts (the
                            // effort picker hides for it).
                        }
                    }
                }

                await backend.sendExtensionRequest('session/close', { sessionId }, { timeoutMs: 5000 })
                    .catch(() => {})
                return {
                    success: true,
                    availableModels: metadata.availableModels.map((model) => ({
                        ...model,
                        ...(effortByModel.has(model.modelId)
                            ? { reasoningEfforts: effortByModel.get(model.modelId) }
                            : {})
                    })),
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
