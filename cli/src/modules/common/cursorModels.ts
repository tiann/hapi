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
    if ((response.cliModelSkus?.length ?? 0) > 0) {
        return response;
    }

    const wires = (response.availableModels ?? []).filter((entry) => isCursorAcpWireModelId(entry.modelId));
    const filtered = filterCliSkusForWireBases([...cliSkus], wires);
    return filtered.length > 0 ? { ...response, cliModelSkus: filtered } : response;
}

async function enrichCursorModelsWithCliSkus(
    response: ListCursorModelsResponse
): Promise<ListCursorModelsResponse> {
    if ((response.cliModelSkus?.length ?? 0) > 0) {
        return response;
    }

    const wires = (response.availableModels ?? []).filter((entry) => isCursorAcpWireModelId(entry.modelId));
    if (wires.length === 0) {
        return response;
    }

    const shared = readSharedCursorModelsCache();
    if (shared?.cliModelSkus?.length) {
        return attachCliSkusToResponse(response, shared.cliModelSkus);
    }

    // Never spawn `agent --list-models` while an ACP session holds the CLI lock.
    if (isAgentAcpTransportActive()) {
        return response;
    }

    try {
        const probe = await runCursorModelProbe();
        const cliSkus = filterCliSkusForWireBases(probe.availableModels ?? [], wires);
        return cliSkus.length > 0 ? { ...response, cliModelSkus: cliSkus } : response;
    } catch {
        return response;
    }
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
        const cachedSkus = cache.response.cliModelSkus ?? shared?.cliModelSkus ?? [];
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

            const probeResponse = await runCursorModelProbe();
            if (cursorProbeResponseHasWireCatalog(probeResponse)) {
                return applyInMemoryCache(probeResponse);
            }

            // CLI `--list-models` returns slug ids without bracket params; never cache
            // those for the web picker (New Session would show only Default + current slug).
            if (acpResponse.success) {
                return acpResponse;
            }
            return probeResponse.success
                ? { success: true, availableModels: [], currentModelId: null }
                : probeResponse;
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
    void applyInMemoryCache(response);
}

export function _resetCursorModelsCacheForTests(): void {
    cache.expiresAt = 0;
    cache.response = { success: true, availableModels: [], currentModelId: null };
    inflight = null;
    _resetSharedCursorModelsCacheForTests();
}
