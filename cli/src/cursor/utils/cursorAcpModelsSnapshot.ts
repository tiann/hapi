import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { CursorModelSummary } from '@hapi/protocol/apiTypes';

export type CursorModelsSnapshot = {
    availableModels: CursorModelSummary[];
    currentModelId: string | null;
    /** ACP advertised the parameterized picker (bare bases + fast/thought_level options). */
    parameterized?: boolean;
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
 * Zed-style Cursor catalog: `configOptions` model category lists every model id;
 * `availableModels` alone is often one variant per base family.
 *
 * Cursor's parameterized picker advertises bare model bases plus separate
 * `fast` / `thought_level` config options. Cursor rejects every bracket id whose
 * parameter set is not that model's complete set, and those per-model sets are not
 * derivable from the options, so no wire ids are ever synthesized here: the
 * advertised values are kept verbatim (bare bases are accepted by `--model`, with
 * defaults applied) and the requested parameters are applied over ACP config
 * options by `applyParameterizedCursorModel`.
 */
export function buildCursorModelsSnapshotFromAcp(
    backend: CursorAcpModelSnapshotBackend,
    sessionId: string
): CursorModelsSnapshot | null {
    const metadata = backend.getSessionModelsMetadata(sessionId);
    const modelOption = findConfigOption(backend, sessionId, 'model');

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

    const parameterized = Boolean(
        modelOption?.options?.length
        && modelOption.options.every((option) => {
            const value = option.value.trim();
            return value.length > 0 && !value.includes('[');
        })
    );

    return {
        availableModels: [...merged.values()],
        currentModelId: metadata?.currentModelId ?? modelOption?.currentValue ?? null,
        ...(parameterized ? { parameterized: true } : {})
    };
}
