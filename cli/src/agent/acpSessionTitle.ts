import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import { normalizeNativeSessionTitle } from '@/agent/nativeSessionTitle';

type AcpSessionTitleBackend = Pick<AcpSdkBackend, 'setSessionInfoUpdateListener'>;
type AcpSessionTitleClient = Pick<ApiSessionClient, 'sendClaudeSessionMessage'>;

/** Creates a normalized, deduplicated native-title sink for a HAPI session. */
function createSessionTitleSync(client: AcpSessionTitleClient): (title: unknown) => void {
    let lastTitle: string | null = null;

    return (title) => {
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
    };
}

/** Syncs agent-generated ACP session titles into HAPI session metadata. */
export function registerAcpSessionTitleSync(
    backend: AcpSessionTitleBackend,
    client: AcpSessionTitleClient
): void {
    const syncTitle = createSessionTitleSync(client);

    backend.setSessionInfoUpdateListener(({ title }) => {
        syncTitle(title);
    });
}
