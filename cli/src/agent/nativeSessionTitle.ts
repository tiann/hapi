import type { ApiSessionClient } from '@/api/apiSession';
import type { Metadata } from '@/api/types';

type NativeSessionTitleMetadataClient = Pick<ApiSessionClient, 'getMetadata' | 'updateMetadata'>;

export function normalizeNativeSessionTitle(title: unknown): string | null {
    if (typeof title !== 'string') {
        return null;
    }
    const normalizedTitle = title.trim();
    if (!normalizedTitle
        || /^(?:Untitled|New Session)$/i.test(normalizedTitle)
        || /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T/i.test(normalizedTitle)) {
        return null;
    }
    return normalizedTitle;
}

/** Syncs a native agent title into HAPI metadata without creating a chat row. */
export function createNativeSessionTitleMetadataSync(
    client: NativeSessionTitleMetadataClient
): (title: unknown) => void {
    let lastTitle: string | null = null;

    return (title) => {
        const normalizedTitle = normalizeNativeSessionTitle(title);
        if (!normalizedTitle || normalizedTitle === lastTitle) {
            return;
        }
        lastTitle = normalizedTitle;

        if (metadataHasTitle(client.getMetadata(), normalizedTitle)) {
            return;
        }
        client.updateMetadata((metadata) => {
            if (metadataHasTitle(metadata, normalizedTitle)) {
                return metadata;
            }
            return {
                ...metadata,
                summary: {
                    text: normalizedTitle,
                    updatedAt: Date.now()
                }
            };
        });
    };
}

function metadataHasTitle(metadata: Readonly<Metadata> | null, title: string): boolean {
    return metadata?.name?.trim() === title || metadata?.summary?.text.trim() === title;
}
