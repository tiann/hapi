import { ApiClient, ApiSessionClient } from '@/lib'
import { MessageQueue2 } from '@/utils/MessageQueue2'
import { AgentSessionBase } from '@/agent/sessionBase'
import type { PermissionMode } from '@hapi/protocol/types'
import type { DshMode } from './types'

/** Remote-only HAPI session wrapper for the fresh-session DSH ACP server. */
export class DshSession extends AgentSessionBase<DshMode> {
    readonly startedBy: 'runner' | 'terminal'

    constructor(opts: {
        api: ApiClient
        client: ApiSessionClient
        path: string
        logPath: string
        messageQueue: MessageQueue2<DshMode>
        onModeChange: (mode: 'local' | 'remote') => void
        startedBy: 'runner' | 'terminal'
        permissionMode?: PermissionMode
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: null,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: 'remote',
            sessionLabel: 'DshSession',
            sessionIdLabel: 'DeepSeek Harness ACP',
            // The official ACP server supports fresh sessions only. Keep its
            // process-local id out of HAPI metadata so inactive rows cannot
            // advertise a resume path the server does not implement.
            applySessionIdToMetadata: (metadata) => metadata,
            permissionMode: opts.permissionMode
        })
        this.startedBy = opts.startedBy
    }

    /** Runtime permission-mode updates (SetSessionConfig RPC). Writes the
     *  inherited field so `getPermissionMode()` — read by the ACP permission
     *  bridge on every permission request — sees the change immediately. */
    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode
    }

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message)
    }

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event)
    }
}
