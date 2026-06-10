import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { CursorModelSummary } from '@hapi/protocol/apiTypes';

export type CursorModelsSnapshot = {
    availableModels: CursorModelSummary[];
    currentModelId: string | null;
};

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
    backend: Pick<AcpSdkBackend, 'getSessionModelsMetadata' | 'getConfigOptionByCategory'>,
    sessionId: string
): CursorModelsSnapshot | null {
    const metadata = backend.getSessionModelsMetadata(sessionId);
    const modelOption = backend.getConfigOptionByCategory?.(sessionId, 'model');

    if (!metadata && !modelOption) {
        return null;
    }

    const merged = new Map<string, CursorModelSummary>();

    if (modelOption?.options?.length) {
        mergeModelEntries(merged, modelOption.options.map((option) => ({
            modelId: option.value,
            name: option.name
        })));
    }

    if (metadata?.availableModels?.length) {
        mergeModelEntries(merged, metadata.availableModels);
    }

    if (merged.size === 0) {
        return null;
    }

    const currentModelId = metadata?.currentModelId
        ?? modelOption?.currentValue
        ?? null;

    return {
        availableModels: [...merged.values()],
        currentModelId
    };
}
