import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { AgyMode, PermissionMode } from './types';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { SessionEffort, SessionModel } from '@/api/types';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

/**
 * Headless (print-mode) agy session. agy is spawned per user turn with
 * `-p <msg> --conversation <uuid> --output-format stream-json`; the driver
 * maps NDJSON events onto the existing transcript-entry channel
 * (sendAgySessionMessage), so hub/web rendering is unchanged.
 */
export class AgySession extends AgentSessionBase<AgyMode> {
    readonly startedBy: 'runner' | 'terminal';
    localLaunchFailure: LocalLaunchFailure | null = null;
    /** Set by the headless driver; lets the CLI cancel a batch held in retry backoff. */
    cancelRetryDelivery: ((localId: string) => boolean) | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<AgyMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        permissionMode?: PermissionMode;
        model?: SessionModel;
        effort?: SessionEffort;
    }) {
        super({
            api: opts.api,
            client: opts.client,
            path: opts.path,
            logPath: opts.logPath,
            sessionId: opts.sessionId,
            messageQueue: opts.messageQueue,
            onModeChange: opts.onModeChange,
            mode: opts.mode,
            sessionLabel: 'AgySession',
            sessionIdLabel: 'Antigravity',
            applySessionIdToMetadata: (metadata, sessionId, extras) => ({
                ...metadata,
                agySessionId: sessionId,
                ...extras
            }),
            permissionMode: opts.permissionMode,
            model: opts.model,
            effort: opts.effort,
            acknowledgeMessagesOnDequeue: false
        });

        this.startedBy = opts.startedBy;
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.effort = opts.effort;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: SessionModel): void => {
        this.model = model;
    };

    setEffort = (effort: SessionEffort): void => {
        this.effort = effort;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    sendAgentMessage = (message: unknown): void => {
        this.client.sendAgentMessage(message);
    };

    sendUserMessage = (text: string): void => {
        this.client.sendUserMessage(text);
    };

    sendSessionEvent = (event: Parameters<ApiSessionClient['sendSessionEvent']>[0]): void => {
        this.client.sendSessionEvent(event);
    };
}
