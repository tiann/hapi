import { ApiClient, ApiSessionClient } from '@/lib';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { AgentSessionBase } from '@/agent/sessionBase';
import type { EnhancedMode, PermissionMode } from './loop';
import type { CodexCliOverrides } from './utils/codexCliOverrides';
import type { LocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { SessionModel, SessionModelReasoningEffort, SessionServiceTier } from '@/api/types';
import type { DeliveryOutcomeClient } from './deliveryOutcomeClient';
import { randomUUID } from 'node:crypto';
import type { DeliveryAttemptState } from '@hapi/protocol';
import { invalidateCodexQueueDurably } from './durableQueueInvalidation';

type LocalLaunchFailure = {
    message: string;
    exitReason: LocalLaunchExitReason;
};

export class CodexSession extends AgentSessionBase<EnhancedMode> {
    readonly codexArgs?: string[];
    readonly codexCliOverrides?: CodexCliOverrides;
    readonly startedBy: 'runner' | 'terminal';
    readonly startingMode: 'local' | 'remote';
    localLaunchFailure: LocalLaunchFailure | null = null;
    readonly deliveryOutcomes?: DeliveryOutcomeClient;
    readonly onAmbiguousDelivery?: () => void;

    constructor(opts: {
        api: ApiClient;
        client: ApiSessionClient;
        path: string;
        logPath: string;
        sessionId: string | null;
        messageQueue: MessageQueue2<EnhancedMode>;
        onModeChange: (mode: 'local' | 'remote') => void;
        mode?: 'local' | 'remote';
        startedBy: 'runner' | 'terminal';
        startingMode: 'local' | 'remote';
        codexArgs?: string[];
        codexCliOverrides?: CodexCliOverrides;
        permissionMode?: PermissionMode;
        model?: SessionModel;
        modelReasoningEffort?: SessionModelReasoningEffort;
        serviceTier?: SessionServiceTier;
        collaborationMode?: EnhancedMode['collaborationMode'];
        deliveryOutcomes?: DeliveryOutcomeClient;
        onAmbiguousDelivery?: () => void;
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
            sessionLabel: 'CodexSession',
            sessionIdLabel: 'Codex',
            applySessionIdToMetadata: (metadata, sessionId) => ({
                ...metadata,
                codexSessionId: sessionId
            }),
            permissionMode: opts.permissionMode,
            model: opts.model,
            modelReasoningEffort: opts.modelReasoningEffort,
            serviceTier: opts.serviceTier,
            collaborationMode: opts.collaborationMode
        });

        this.codexArgs = opts.codexArgs;
        this.codexCliOverrides = opts.codexCliOverrides;
        this.startedBy = opts.startedBy;
        this.startingMode = opts.startingMode;
        this.permissionMode = opts.permissionMode;
        this.model = opts.model;
        this.modelReasoningEffort = opts.modelReasoningEffort;
        this.serviceTier = opts.serviceTier;
        this.collaborationMode = opts.collaborationMode;
        this.deliveryOutcomes = opts.deliveryOutcomes;
        this.onAmbiguousDelivery = opts.onAmbiguousDelivery;
    }

    setPermissionMode = (mode: PermissionMode): void => {
        this.permissionMode = mode;
    };

    setModel = (model: SessionModel): void => {
        this.model = model;
    };

    setModelReasoningEffort = (modelReasoningEffort: SessionModelReasoningEffort): void => {
        this.modelReasoningEffort = modelReasoningEffort;
    };

    setServiceTier = (serviceTier: SessionServiceTier): void => {
        this.serviceTier = serviceTier;
    };

    setCollaborationMode = (mode: EnhancedMode['collaborationMode']): void => {
        this.collaborationMode = mode;
    };

    recordLocalLaunchFailure = (message: string, exitReason: LocalLaunchExitReason): void => {
        this.localLaunchFailure = { message, exitReason };
    };

    invalidateQueuedMessages = async (
        reason: string,
        state: Extract<DeliveryAttemptState, 'canceled' | 'superseded' | 'ambiguous'>
    ): Promise<void> => {
        const attemptId = randomUUID();
        await invalidateCodexQueueDurably({
            queue: this.queue,
            reason,
            state,
            attemptId,
            recordTerminal: this.deliveryOutcomes
                ? async (items, terminalAttemptId, terminalState) => await this.deliveryOutcomes!.recordTerminal(
                    items,
                    terminalAttemptId,
                    terminalState
                )
                : undefined
        });
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
