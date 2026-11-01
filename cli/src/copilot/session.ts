import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { CopilotMode, PermissionMode } from './types';
import type { CopilotAgentMode } from '@hapi/protocol';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class CopilotSession extends AgentSessionBase<CopilotMode> {
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    private remoteAgentModeApplier: ((mode: CopilotAgentMode) => Promise<void>) | null = null;
    private remoteEffortApplier: ((effort: string | null) => Promise<string | null>) | null = null;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<CopilotMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        permissionMode?: PermissionMode;
        effort?: string | null;
        agentMode?: CopilotAgentMode;
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
            sessionLabel: 'CopilotSession',
            sessionIdLabel: 'Copilot',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                copilotSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            effort: opts.effort
        });

        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.effort = opts.effort;
        this.agentMode = opts.agentMode ?? 'interactive';
    }

    agentMode: CopilotAgentMode;

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: string | null): void => {
        this.model = model;
    };

    setEffort = (effort: string | null | undefined): void => {
        this.effort = effort;
    };

    setAgentMode = (mode: CopilotAgentMode): void => {
        this.agentMode = mode;
    };

    getAgentMode = (): CopilotAgentMode => this.agentMode;

    setRemoteAgentModeApplier = (applier: ((mode: CopilotAgentMode) => Promise<void>) | null): void => {
        this.remoteAgentModeApplier = applier;
    };

    setRemoteEffortApplier = (applier: ((effort: string | null) => Promise<string | null>) | null): void => {
        this.remoteEffortApplier = applier;
    };

    applyRemoteAgentMode = async (mode: CopilotAgentMode): Promise<void> => {
        if (this.thinking) {
            throw new Error('Wait for the current Copilot turn to finish before changing agent mode');
        }
        if (!this.remoteAgentModeApplier) {
            throw new Error('Copilot agent mode switching is unavailable for this session');
        }
        await this.remoteAgentModeApplier(mode);
    };

    applyRemoteEffort = async (effort: string | null): Promise<string | null> => {
        if (this.thinking) {
            throw new Error('Wait for the current Copilot turn to finish before changing effort');
        }
        if (!this.remoteEffortApplier) {
            throw new Error('Copilot effort switching is unavailable for this session');
        }
        return await this.remoteEffortApplier(effort);
    };

    protected override getKeepAliveRuntime() {
        return {
            ...(super.getKeepAliveRuntime() ?? {}),
            copilotAgentMode: this.agentMode
        };
    }

    pushKeepAlive = (): void => {
        this.client.keepAlive(this.thinking, this.mode, {
            permissionMode: this.permissionMode,
            model: this.model,
            effort: this.effort,
            copilotAgentMode: this.agentMode
        });
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
