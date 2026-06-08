import { spawn } from 'node:child_process';
import type { CursorModelsResponse, CursorModelSummary } from '@hapi/protocol/apiTypes';
import { isAgentAcpTransportActive } from '@/agent/backends/acp/agentCliGuard';
import { getCursorAcpModelsSnapshot } from '@/cursor/utils/cursorAcpModelsBridge';
import { getErrorMessage } from './rpcResponses';
import {
    readSharedCursorModelsCache,
    writeSharedCursorModelsCache,
    _resetSharedCursorModelsCacheForTests
} from './cursorModelsSharedCache';
import {
    cursorCliSkuBaseId,
    cursorModelBaseId,
    isCursorAcpWireModelId
} from '@hapi/protocol';
import {
    cursorProbeResponseHasWireCatalog,
    runCursorAcpModelProbe
} from './cursorAcpModelProbe';

export function buildCursorModelsSeedPayload(
    snapshot: {
        availableModels: CursorModelSummary[];
        currentModelId: string | null;
        cliModelSkus?: readonly CursorModelSummary[];
    },
    shared?: CursorModelsResponse | null
): ListCursorModelsResponse {
    const cliModelSkus = mergeCliModelSkus(
        snapshot.cliModelSkus ?? [],
        shared?.cliModelSkus ?? []
    );
    return {
        success: true,
        availableModels: snapshot.availableModels,
        currentModelId: snapshot.currentModelId,
        ...(cliModelSkus.length > 0 ? { cliModelSkus } : {})
    };
}

export function mergeCliModelSkus(
    ...lists: readonly (readonly CursorModelSummary[])[]
): CursorModelSummary[] {
    const merged = new Map<string, CursorModelSummary>();
    for (const list of lists) {
        for (const entry of list) {
            const modelId = entry.modelId.trim();
            if (!modelId) {
                continue;
            }
            if (!merged.has(modelId)) {
                merged.set(modelId, entry);
            }
        }
    }
    return [...merged.values()];
}

function filterCliSkusForWireBases(
    cliSkus: CursorModelSummary[],
    wires: CursorModelSummary[]
): CursorModelSummary[] {
    const wireBases = new Set(
        wires.map((entry) => cursorModelBaseId(entry.modelId)).filter((base) => base.length > 0)
    );

    return cliSkus.filter((entry) => {
        const modelId = entry.modelId.trim();
        if (!modelId || modelId === 'auto' || isCursorAcpWireModelId(modelId)) {
            return false;
        }
        return wireBases.has(cursorCliSkuBaseId(modelId));
    });
}

function attachCliSkusToResponse(
    response: ListCursorModelsResponse,
    cliSkus: readonly CursorModelSummary[]
): ListCursorModelsResponse {
    const wires = (response.availableModels ?? []).filter((entry) => isCursorAcpWireModelId(entry.modelId));
    const filtered = filterCliSkusForWireBases([...cliSkus], wires);
    const merged = mergeCliModelSkus(response.cliModelSkus ?? [], filtered);
    if (merged.length === 0) {
        return response;
    }
    if (merged.length === (response.cliModelSkus?.length ?? 0)) {
        return response;
    }
    return { ...response, cliModelSkus: merged };
}

async function enrichCursorModelsWithCliSkus(
    response: ListCursorModelsResponse
): Promise<ListCursorModelsResponse> {
    const wires = (response.availableModels ?? []).filter((entry) => isCursorAcpWireModelId(entry.modelId));
    if (wires.length === 0) {
        return response;
    }

    const candidates: CursorModelSummary[] = [];
    const shared = readSharedCursorModelsCache();
    if (shared?.cliModelSkus?.length) {
        candidates.push(...shared.cliModelSkus);
    }

    // Never spawn `agent --list-models` while an ACP session holds the CLI lock.
    if (!isAgentAcpTransportActive()) {
        try {
            const probe = await runCursorModelProbe();
            candidates.push(...(probe.availableModels ?? []));
        } catch {
            // Keep partial candidates from shared cache.
        }
    }

    if (candidates.length === 0) {
        return response;
    }

    return attachCliSkusToResponse(response, candidates);
}

export type ListCursorModelsResponse = CursorModelsResponse;

interface CacheEntry {
    expiresAt: number;
    response: ListCursorModelsResponse;
}

const CACHE_TTL_MS = 60_000;
const PROBE_TIMEOUT_MS = 30_000;
const cache: CacheEntry = {
    expiresAt: 0,
    response: { success: true, availableModels: [], currentModelId: null }
};
let inflight: Promise<ListCursorModelsResponse> | null = null;

export function parseCursorModelsOutput(output: string): {
    availableModels: CursorModelSummary[];
    currentModelId: string | null;
} {
    const availableModels: CursorModelSummary[] = [];
    let currentModelId: string | null = null;

    for (const rawLine of output.split(/\r?\n/)) {
        const line = rawLine.trim();
        if (!line || line === 'Available models' || line.startsWith('Tip:')) {
            continue;
        }

        const separatorIndex = line.indexOf(' - ');
        if (separatorIndex <= 0) {
            continue;
        }

        const modelId = line.slice(0, separatorIndex).trim();
        const rawName = line.slice(separatorIndex + 3).trim();
        if (!modelId || !rawName) {
            continue;
        }

        const isCurrent = /\s*\(current\)\s*$/.test(rawName);
        const isDefault = /\s*\(default\)\s*$/.test(rawName);
        const name = rawName.replace(/\s*\((?:current|default)\)\s*$/, '').trim();
        availableModels.push(name && name !== modelId ? { modelId, name } : { modelId });

        if (isCurrent) {
            currentModelId = modelId;
        } else if (isDefault && currentModelId === null) {
            currentModelId = modelId;
        }
    }

    return { availableModels, currentModelId };
}

async function runCursorModelProbe(): Promise<ListCursorModelsResponse> {
    if (isAgentAcpTransportActive()) {
        throw new Error('Cursor ACP transport is active');
    }

    return await new Promise((resolve, reject) => {
        const child = spawn('agent', ['--list-models'], {
            env: process.env,
            stdio: ['ignore', 'pipe', 'pipe'],
            shell: process.platform === 'win32',
            windowsHide: process.platform === 'win32'
        });
        let stdout = '';
        let stderr = '';
        let settled = false;

        const timeout = setTimeout(() => {
            if (settled) return;
            settled = true;
            child.kill('SIGTERM');
            reject(new Error('Cursor model discovery timed out'));
        }, PROBE_TIMEOUT_MS);

        child.stdout?.on('data', (chunk) => {
            stdout += chunk.toString();
        });
        child.stderr?.on('data', (chunk) => {
            stderr += chunk.toString();
        });
        child.on('error', (error) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            reject(error);
        });
        child.on('exit', (code) => {
            if (settled) return;
            settled = true;
            clearTimeout(timeout);
            if (code !== 0) {
                reject(new Error(stderr.trim() || `agent --list-models exited with code ${code}`));
                return;
            }

            resolve({
                success: true,
                ...parseCursorModelsOutput(stdout)
            });
        });
    });
}

async function applyInMemoryCache(response: ListCursorModelsResponse): Promise<ListCursorModelsResponse> {
    const enriched = await enrichCursorModelsWithCliSkus(response);
    if ((enriched.availableModels?.length ?? 0) > 0) {
        cache.expiresAt = Date.now() + CACHE_TTL_MS;
        cache.response = enriched;
        writeSharedCursorModelsCache(enriched);
    }
    return enriched;
}

/** ACP session snapshot (Zed-style); falls back to seeded / on-disk cache from the last live session. */
async function listCursorModelsWhileAcpActive(): Promise<ListCursorModelsResponse> {
    const acp = getCursorAcpModelsSnapshot();
    if (acp && acp.availableModels.length > 0) {
        return applyInMemoryCache({ success: true, ...acp });
    }
    // Session child writes the on-disk cache; prefer it over this process's in-memory entry.
    const shared = readSharedCursorModelsCache();
    if (shared) {
        return applyInMemoryCache(shared);
    }
    if (cache.expiresAt > Date.now() && (cache.response.availableModels?.length ?? 0) > 0) {
        const shared = readSharedCursorModelsCache();
        const cachedSkus = mergeCliModelSkus(
            cache.response.cliModelSkus ?? [],
            shared?.cliModelSkus ?? []
        );
        return attachCliSkusToResponse(cache.response, cachedSkus);
    }
    return { success: true, availableModels: [], currentModelId: null };
}

export async function listCursorModels(): Promise<ListCursorModelsResponse> {
    if (isAgentAcpTransportActive()) {
        return listCursorModelsWhileAcpActive();
    }

    const acp = getCursorAcpModelsSnapshot();
    if (acp && acp.availableModels.length > 0) {
        return applyInMemoryCache({ success: true, ...acp });
    }

    if (cache.expiresAt > Date.now() && (cache.response.availableModels?.length ?? 0) > 0) {
        return enrichCursorModelsWithCliSkus(cache.response);
    }

    const shared = readSharedCursorModelsCache();
    if (shared) {
        return applyInMemoryCache(shared);
    }

    if (inflight) {
        return inflight;
    }

    inflight = (async () => {
        try {
            const acpResponse = await runCursorAcpModelProbe();
            if (cursorProbeResponseHasWireCatalog(acpResponse)) {
                return applyInMemoryCache(acpResponse);
            }

            let probeResponse: ListCursorModelsResponse | null = null;
            if (!isAgentAcpTransportActive()) {
                probeResponse = await runCursorModelProbe();
                if (cursorProbeResponseHasWireCatalog(probeResponse)) {
                    return applyInMemoryCache(probeResponse);
                }
            }

            // CLI `--list-models` returns slug ids without bracket params; never cache
            // those for the web picker (New Session would show only Default + current slug).
            if (acpResponse.success) {
                return acpResponse;
            }
            if (probeResponse?.success) {
                return { success: true, availableModels: [], currentModelId: null };
            }
            return probeResponse ?? acpResponse;
        } catch (error) {
            return {
                success: false,
                error: getErrorMessage(error, 'Failed to discover Cursor models')
            };
        } finally {
            inflight = null;
        }
    })();

    return inflight;
}

export function seedCursorModelsCache(response: ListCursorModelsResponse): void {
    if ((response.availableModels?.length ?? 0) > 0) {
        writeSharedCursorModelsCache(response);
    }
    void applyInMemoryCache(response);
}

export function _resetCursorModelsCacheForTests(): void {
    cache.expiresAt = 0;
    cache.response = { success: true, availableModels: [], currentModelId: null };
    inflight = null;
    _resetSharedCursorModelsCacheForTests();
}
