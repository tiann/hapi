import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { normalizeNativeSessionTitle } from '@/agent/nativeSessionTitle';

type AcpSessionTitleBackend = Pick<AcpSdkBackend, 'setSessionInfoUpdateListener'>;
type AcpSessionTitleClient = Pick<
    ApiSessionClient,
    'sendClaudeSessionMessage' | 'getMetadata' | 'updateMetadata'
>;

export interface AcpSessionTitleController {
    syncNativeTitle: (title: unknown) => void;
    markManualTitle: () => void;
}

/** Creates a normalized, deduplicated native-title sink for a HAPI session. */
export function createAcpSessionTitleSync(client: AcpSessionTitleClient): AcpSessionTitleController {
    let lastTitle: string | null = null;
    // Survives launcher recreation / session resume via session metadata, so a
    // manual change_title rename is not overwritten by later native titles.
    let manual = client.getMetadata()?.acpManualTitle === true;

    return {
        syncNativeTitle: (title) => {
            if (manual) {
                return;
            }
            const normalizedTitle = normalizeNativeSessionTitle(title);
            if (!normalizedTitle || normalizedTitle === lastTitle) {
                return;
            }
            lastTitle = normalizedTitle;
            client.sendClaudeSessionMessage({
                type: 'summary',
                summary: normalizedTitle,
                leafUuid: randomUUID()
            });
        },
        markManualTitle: () => {
            if (manual) {
                return;
            }
            manual = true;
            client.updateMetadata((metadata) => ({
                ...metadata,
                acpManualTitle: true
            }));
        }
    };
}

/** Syncs agent-generated ACP session titles into HAPI session metadata. */
export function registerAcpSessionTitleSync(
    backend: AcpSessionTitleBackend,
    client: AcpSessionTitleClient,
    controller?: AcpSessionTitleController
): void {
    const titleSync = controller ?? createAcpSessionTitleSync(client);

    backend.setSessionInfoUpdateListener(({ title }) => {
        titleSync.syncNativeTitle(title);
    });
}
