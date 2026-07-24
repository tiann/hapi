import { randomUUID } from 'node:crypto';
import type { ApiSessionClient } from '@/api/apiSession';
import type { AcpSdkBackend } from '@/agent/backends/acp';

type AcpSessionTitleBackend = Pick<AcpSdkBackend, 'setSessionInfoUpdateListener'>;
type AcpSessionTitleClient = Pick<ApiSessionClient, 'sendClaudeSessionMessage'>;

function isPlaceholderTitle(title: string): boolean {
    return title === 'Untitled'
        || /^(?:New|Child) session - \d{4}-\d{2}-\d{2}T/.test(title);
}

/** Syncs agent-generated ACP session titles into HAPI session metadata. */
export function registerAcpSessionTitleSync(
    backend: AcpSessionTitleBackend,
    client: AcpSessionTitleClient
): void {
    let lastTitle: string | null = null;

    backend.setSessionInfoUpdateListener(({ title }) => {
        if (typeof title !== 'string') {
            return;
        }
        const normalizedTitle = title.trim();
        if (!normalizedTitle || isPlaceholderTitle(normalizedTitle) || normalizedTitle === lastTitle) {
            return;
        }
        lastTitle = normalizedTitle;
        client.sendClaudeSessionMessage({
            type: 'summary',
            summary: normalizedTitle,
            leafUuid: randomUUID()
        });
    });
}
