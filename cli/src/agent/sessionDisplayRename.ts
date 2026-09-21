import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type SessionDisplayRenameClient = Pick<ApiSessionClient, 'updateMetadata'>;

/**
 * Explicit agent/operator rename: set metadata.name (same field as web
 * renameSession / PATCH /sessions/:id). Distinct from native/generated
 * summaries, which must not overwrite an intentional name.
 */
export function normalizeSessionDisplayTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const normalized = title.replace(/\s+/g, ' ').trim();
    return normalized.length > 0 ? normalized : null;
}

export function applySessionDisplayRename(
    client: SessionDisplayRenameClient,
    title: unknown
): boolean {
    const normalized = normalizeSessionDisplayTitle(title);
    if (!normalized) {
        return false;
    }

    client.updateMetadata((metadata: Metadata) => {
        if (metadata.name?.trim() === normalized) {
            return metadata;
        }
        return {
            ...metadata,
            name: normalized
        };
    });
    return true;
}
