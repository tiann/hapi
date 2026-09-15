import { spawn } from 'node:child_process';
import { createMessageConnection, StreamMessageReader, StreamMessageWriter } from 'vscode-jsonrpc/node';
import { asString, isObject } from '@hapi/protocol';
import type { CopilotModelsResponse, CopilotModelSummary } from '@hapi/protocol/apiTypes';
import { createCopilotBackend } from '@/copilot/utils/copilotBackend';
import { getErrorMessage } from './rpcResponses';

export interface ListCopilotModelsForCwdRequest {
    cwd?: string;
}

export type ListCopilotModelsForCwdResponse = CopilotModelsResponse;

interface CacheEntry {
    expiresAt: number;
    response: ListCopilotModelsForCwdResponse;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const cache = new Map<string, CacheEntry>();
const inflight = new Map<string, Promise<ListCopilotModelsForCwdResponse>>();

function normalizeAvailableModels(rawModels: unknown): CopilotModelSummary[] {
    if (!Array.isArray(rawModels)) return [];
    const out: CopilotModelSummary[] = [];
    const seen = new Set<string>();
    for (const entry of rawModels) {
        if (!isObject(entry)) continue;
        const modelId = asString(entry.modelId)
            ?? asString(entry.id)
            ?? asString(entry.value);
        if (!modelId || seen.has(modelId)) continue;
        seen.add(modelId);
        const name = asString(entry.name)
            ?? (modelId === 'auto' ? 'Auto' : undefined);
        out.push(name ? { modelId, name } : { modelId });
    }
    return out;
}

function extractModelConfigOption(response: Record<string, unknown>): {
    currentValue: string | null;
    options: unknown[];
} | null {
    if (!Array.isArray(response.configOptions)) return null;

    for (const entry of response.configOptions) {
        if (!isObject(entry)) continue;
        if (asString(entry.category) !== 'model') continue;
        return {
            currentValue: asString(entry.currentValue),
            options: Array.isArray(entry.options) ? entry.options : []
        };
    }

    return null;
}

function extractModelsFromAcpResponse(response: unknown): {
    availableModels: CopilotModelSummary[];
    currentModelId: string | null;
} {
    if (!isObject(response)) {
        return { availableModels: [], currentModelId: null };
    }

    const meta = isObject(response._meta) ? response._meta : null;
    const modelState = meta && isObject(meta.modelState) ? meta.modelState : null;
    const configModelOption = extractModelConfigOption(response);
    const rawModels = Array.isArray(response.availableModels)
        ? response.availableModels
        : modelState && Array.isArray(modelState.availableModels)
            ? modelState.availableModels
            : configModelOption?.options ?? null;
    const rawCurrent = asString(response.currentModelId)
        ?? (modelState ? asString(modelState.currentModelId) : null)
        ?? configModelOption?.currentValue
        ?? null;

    return {
        availableModels: normalizeAvailableModels(rawModels),
        currentModelId: rawCurrent
    };
}

/**
 * Copilot ACP session/new does not advertise a model catalog (only mode +
 * permissions). The SDK headless protocol exposes subscription-aware models
 * via `models.list` — Student plans typically return only `auto`.
 */
async function listModelsViaSdkHeadless(): Promise<CopilotModelSummary[]> {
    const command = process.env.COPILOT_CLI_PATH ?? 'copilot';
    const child = spawn(command, ['--headless', '--stdio', '--no-auto-update'], {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env
    });

    if (!child.stdin || !child.stdout) {
        child.kill();
        throw new Error('Failed to open Copilot headless stdio pipes');
    }

    const connection = createMessageConnection(
        new StreamMessageReader(child.stdout),
        new StreamMessageWriter(child.stdin)
    );
    connection.listen();

    const exitPromise = new Promise<never>((_, reject) => {
        child.once('exit', (code) => {
            reject(new Error(`Copilot headless exited with code ${code ?? 'unknown'}`));
        });
        child.once('error', (error) => {
            reject(error);
        });
    });

    try {
        const result = await Promise.race([
            connection.sendRequest('models.list', {}),
            exitPromise,
            new Promise<never>((_, reject) => {
                setTimeout(() => reject(new Error('Timed out listing Copilot models')), PROBE_TIMEOUT_MS);
            })
        ]);
        const models = isObject(result) && Array.isArray(result.models)
            ? result.models
            : Array.isArray(result)
                ? result
                : [];
        return normalizeAvailableModels(models);
    } finally {
        try {
            connection.dispose();
        } catch {
            // ignore
        }
        if (!child.killed) {
            child.kill();
        }
    }
}

async function listModelsViaAcpProbe(cwd: string): Promise<{
    availableModels: CopilotModelSummary[];
    currentModelId: string | null;
}> {
    const backend = createCopilotBackend();
    try {
        await backend.initialize();
        const sessionId = await backend.newSession({ cwd, mcpServers: [] });
        const metadata = backend.getSessionModelsMetadata(sessionId);
        const modelOption = backend.getConfigOptionByCategory(sessionId, 'model');
        return extractModelsFromAcpResponse({
            availableModels: metadata?.availableModels,
            currentModelId: metadata?.currentModelId,
            configOptions: modelOption ? [{
                category: 'model',
                currentValue: modelOption.currentValue,
                options: modelOption.options
            }] : []
        });
    } finally {
        await backend.disconnect().catch(() => {});
    }
}

async function runCopilotProbe(cwd: string): Promise<ListCopilotModelsForCwdResponse> {
    try {
        // Prefer SDK headless models.list — subscription-aware (Student → auto only).
        const sdkModels = await listModelsViaSdkHeadless();
        if (sdkModels.length > 0) {
            return {
                success: true,
                availableModels: sdkModels,
                currentModelId: sdkModels.find((model) => model.modelId === 'auto')?.modelId
                    ?? sdkModels[0]?.modelId
                    ?? null
            };
        }
    } catch {
        // Fall through to ACP probe; never invent a static catalog.
    }

    try {
        const acp = await listModelsViaAcpProbe(cwd || process.cwd());
        return {
            success: true,
            availableModels: acp.availableModels,
            currentModelId: acp.currentModelId
        };
    } catch (error) {
        return {
            success: false,
            error: getErrorMessage(error, 'Failed to list Copilot models'),
            availableModels: [],
            currentModelId: null
        };
    }
}

export async function listCopilotModelsForCwd(cwd: string): Promise<ListCopilotModelsForCwdResponse> {
    const key = cwd || process.cwd();
    const cached = cache.get(key);
    if (cached && cached.expiresAt > Date.now()) {
        return cached.response;
    }

    const pending = inflight.get(key);
    if (pending) {
        return pending;
    }

    const promise = runCopilotProbe(key).then((response) => {
        cache.set(key, { expiresAt: Date.now() + CACHE_TTL_MS, response });
        inflight.delete(key);
        return response;
    }).catch((error) => {
        inflight.delete(key);
        throw error;
    });

    inflight.set(key, promise);
    return promise;
}

export async function buildCopilotModelsResponseFromBackend(
    sessionId: string,
    backend: {
        getSessionModelsMetadata: (id: string) => {
            availableModels: CopilotModelSummary[];
            currentModelId: string | null;
        } | undefined;
        getConfigOptionByCategory: (id: string, category: string) => {
            currentValue?: string;
            options?: Array<{ value: string; name?: string }>;
        } | undefined;
    },
    cwd?: string
): Promise<ListCopilotModelsForCwdResponse> {
    const metadata = backend.getSessionModelsMetadata(sessionId);
    const modelOption = backend.getConfigOptionByCategory(sessionId, 'model');
    const parsed = extractModelsFromAcpResponse({
        availableModels: metadata?.availableModels,
        currentModelId: metadata?.currentModelId,
        configOptions: modelOption ? [{
            category: 'model',
            currentValue: modelOption.currentValue,
            options: modelOption.options
        }] : []
    });

    // The ACP metadata snapshot freezes at session/new; the probe (shared with
    // the create-session form, 60s cache) stays fresh as the subscription
    // catalog changes. Probe first, fall back to the snapshot when it fails;
    // currentModelId always comes from the live session either way.
    //
    // The probe is bounded to 5s (Promise.race): listCopilotModelsForCwd can
    // spend 30s in the headless SDK probe plus up to 120s per ACP request,
    // while the hub session RPC deadline is 120s — a stalled probe must never
    // consume it before the snapshot fallback below runs.
    let probeResponse: ListCopilotModelsForCwdResponse | null = null;
    let probeTimer: ReturnType<typeof setTimeout> | undefined;
    try {
        const probe = await Promise.race([
            listCopilotModelsForCwd(cwd ?? process.cwd()),
            new Promise<null>((resolve) => {
                probeTimer = setTimeout(() => resolve(null), 5_000);
            }),
        ]);
        if (probe?.success) {
            return {
                success: true,
                availableModels: probe.availableModels ?? [],
                currentModelId: parsed.currentModelId ?? metadata?.currentModelId ?? null
            };
        }
        probeResponse = probe;
    } catch {
        // fall through to the ACP snapshot below
    } finally {
        clearTimeout(probeTimer);
    }

    if (parsed.availableModels.length > 0) {
        return {
            success: true,
            availableModels: parsed.availableModels,
            currentModelId: parsed.currentModelId ?? metadata?.currentModelId ?? null
        };
    }

    // Probe failed and ACP has no catalog — surface the probe's error (or a
    // generic one) rather than throwing past the RPC handler.
    return {
        ...(probeResponse ?? { success: false as const, error: 'Failed to list Copilot models' }),
        currentModelId: parsed.currentModelId ?? metadata?.currentModelId ?? null
    };
}
