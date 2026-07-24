import { isCursorAcpCatalogModelId } from '@hapi/protocol';
import { createCursorAcpBackend } from '@/cursor/utils/cursorAcpBackend';
import { buildCursorModelsSnapshotFromAcp } from '@/cursor/utils/cursorAcpModelsSnapshot';
import type { ListCursorModelsResponse } from './cursorModels';
import { getErrorMessage } from './rpcResponses';

function hasAcpWireCatalog(response: ListCursorModelsResponse): boolean {
    return (response.availableModels ?? []).some((model) => isCursorAcpCatalogModelId(model.modelId));
}

/**
 * Short-lived `agent acp` subprocess: `initialize` + `session/new` to capture the
 * Zed-style wire catalog. Used for New Session when no on-disk ACP cache exists.
 */
export async function runCursorAcpModelProbe(cwd?: string): Promise<ListCursorModelsResponse> {
    const resolvedCwd = cwd?.trim() || process.cwd();
    const backend = createCursorAcpBackend({ cwd: resolvedCwd });

    try {
        await backend.initialize();
        const sessionId = await backend.newSession({
            cwd: resolvedCwd,
            mcpServers: []
        });
        const snapshot = buildCursorModelsSnapshotFromAcp(backend, sessionId);
        if (!snapshot || snapshot.availableModels.length === 0) {
            return { success: false, error: 'Cursor ACP session/new returned no models' };
        }

        const response: ListCursorModelsResponse = {
            success: true,
            availableModels: snapshot.availableModels,
            currentModelId: snapshot.currentModelId
        };
        if (!hasAcpWireCatalog(response)) {
            return { success: false, error: 'Cursor ACP catalog has no wire model ids' };
        }
        return response;
    } catch (error) {
        return {
            success: false,
            error: getErrorMessage(error, 'Failed to discover Cursor models via ACP')
        };
    } finally {
        await backend.disconnect().catch(() => undefined);
    }
}

export function cursorProbeResponseHasWireCatalog(response: ListCursorModelsResponse): boolean {
    return response.success === true && hasAcpWireCatalog(response);
}
