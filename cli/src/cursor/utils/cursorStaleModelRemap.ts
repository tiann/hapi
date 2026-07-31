import type { CursorModelsResponse } from '@hapi/protocol/apiTypes';
import {
    parseCursorAvailableModelsFromRejection,
    remapStaleCursorModelId
} from '@hapi/protocol';
import { readSharedCursorModelsCache } from '@/modules/common/cursorModelsSharedCache';

function isDefaultSpawnModel(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]';
}

export function catalogEntriesFromCursorModelsResponse(
    response: CursorModelsResponse | null | undefined
): { modelId: string }[] {
    if (!response?.success) {
        return [];
    }

    const entries: { modelId: string }[] = [];
    for (const entry of response.availableModels ?? []) {
        const modelId = entry.modelId?.trim();
        if (modelId) {
            entries.push({ modelId });
        }
    }
    for (const entry of response.cliModelSkus ?? []) {
        const modelId = entry.modelId?.trim();
        if (modelId) {
            entries.push({ modelId });
        }
    }
    return entries;
}

export function resolveCursorSpawnModel(
    model: string | null | undefined
): string | null | undefined {
    const trimmed = model?.trim();
    if (!trimmed || isDefaultSpawnModel(trimmed)) {
        return model;
    }

    const cached = catalogEntriesFromCursorModelsResponse(readSharedCursorModelsCache());
    if (cached.length === 0) {
        return model;
    }

    return remapStaleCursorModelId(trimmed, cached) ?? model;
}

export function tryRemapCursorSpawnModelFromError(
    model: string | null | undefined,
    ...sources: Array<string | null | undefined>
): string | null {
    const trimmed = model?.trim();
    if (!trimmed || isDefaultSpawnModel(trimmed)) {
        return null;
    }

    for (const source of sources) {
        if (!source?.trim()) {
            continue;
        }
        const available = parseCursorAvailableModelsFromRejection(source).map((modelId) => ({ modelId }));
        if (available.length === 0) {
            continue;
        }
        const remapped = remapStaleCursorModelId(trimmed, available);
        if (remapped && remapped !== trimmed) {
            return remapped;
        }
    }

    return null;
}

/** Retry stderr remap on the original legacy wire when cache pre-resolution picked a stale SKU. */
export function tryRemapCursorSpawnModelFromConnectError(
    resolvedSpawnModel: string | null | undefined,
    requestedSpawnModel: string | null | undefined,
    ...sources: Array<string | null | undefined>
): string | null {
    return tryRemapCursorSpawnModelFromError(resolvedSpawnModel, ...sources)
        ?? tryRemapCursorSpawnModelFromError(requestedSpawnModel, ...sources);
}
