import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { CursorModelSummary } from '@hapi/protocol/apiTypes';

export type CursorModelsSnapshot = {
    availableModels: CursorModelSummary[];
    currentModelId: string | null;
};

type CursorAcpModelSnapshotBackend = Pick<AcpSdkBackend, 'getSessionModelsMetadata' | 'getConfigOptionByCategory'>
    & Partial<Pick<AcpSdkBackend, 'getSessionConfigOptions'>>;

function findConfigOption(
    backend: CursorAcpModelSnapshotBackend,
    sessionId: string,
    key: string
) {
    return backend.getConfigOptionByCategory?.(sessionId, key)
        ?? backend.getSessionConfigOptions?.(sessionId)?.find((option) => option.id === key || option.category === key);
}

function mergeModelEntries(
    target: Map<string, CursorModelSummary>,
    entries: Iterable<{ modelId: string; name?: string | null }>
): void {
    for (const entry of entries) {
        const modelId = entry.modelId.trim();
        if (!modelId) continue;

        const name = entry.name?.trim();
        const existing = target.get(modelId);
        if (!existing) {
            target.set(modelId, name && name !== modelId ? { modelId, name } : { modelId });
            continue;
        }
        if (!existing.name && name && name !== modelId) {
            target.set(modelId, { modelId, name });
        }
    }
}

/**
 * Zed-style Cursor catalog: `configOptions` model category lists every wire id;
 * `availableModels` alone is often one variant per base family.
 */
export function buildCursorModelsSnapshotFromAcp(
    backend: CursorAcpModelSnapshotBackend,
    sessionId: string
): CursorModelsSnapshot | null {
    const metadata = backend.getSessionModelsMetadata(sessionId);
    const modelOption = findConfigOption(backend, sessionId, 'model');
    const fastOption = findConfigOption(backend, sessionId, 'fast');

    if (!metadata && !modelOption) {
        return null;
    }

    const merged = new Map<string, CursorModelSummary>();
    const parameterizedFastModels: CursorModelSummary[] = [];

    if (modelOption?.options?.length && fastOption?.options?.length) {
        const fastValues = fastOption.options
            .map((option) => option.value.trim())
            .filter((value) => value === 'false' || value === 'true');
        if (fastValues.length > 0) {
            for (const option of modelOption.options) {
                const modelId = option.value.trim();
                if (!modelId || modelId.includes('[')) {
                    continue;
                }
                for (const fast of fastValues) {
                    parameterizedFastModels.push({
                        modelId: `${modelId}[fast=${fast}]`,
                        name: option.name
                    });
                }
            }
        }
    }

    if (parameterizedFastModels.length > 0) {
        mergeModelEntries(merged, parameterizedFastModels);
    } else if (modelOption?.options?.length) {
        mergeModelEntries(merged, modelOption.options.map((option) => ({
            modelId: option.value,
            name: option.name
        })));
    }

    if (metadata?.availableModels?.length) {
        mergeModelEntries(
            merged,
            parameterizedFastModels.length > 0
                ? metadata.availableModels.filter((entry) => entry.modelId.includes('['))
                : metadata.availableModels
        );
    }

    if (merged.size === 0) {
        return null;
    }

    const currentModelId = parameterizedFastModels.length > 0 && modelOption?.currentValue && fastOption?.currentValue
        ? `${modelOption.currentValue}[fast=${fastOption.currentValue}]`
        : metadata?.currentModelId
            ?? modelOption?.currentValue
            ?? null;

    return {
        availableModels: [...merged.values()],
        currentModelId
    };
}
