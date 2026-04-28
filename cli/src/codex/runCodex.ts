import { logger } from '@/ui/logger';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CodexSession } from './session';
import { parseCodexCliOverrides } from './utils/codexCliOverrides';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { CodexCollaborationModeSchema, PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import type { ReasoningEffort } from './appServerTypes';
import { importCodexSessionHistory } from './importHistory';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export async function runCodex(opts: {
    startedBy?: 'runner' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    importHistory?: boolean;
    model?: string;
    modelReasoningEffort?: ReasoningEffort;
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

    let state: AgentState = {
        controlledByUser: false
    };
    const { api, session } = await bootstrapSession({
        flavor: 'codex',
        startedBy,
        workingDirectory,
        agentState: state,
        model: opts.model,
        modelReasoningEffort: opts.modelReasoningEffort
    });

    const startingMode: 'local' | 'remote' = startedBy === 'runner' ? 'remote' : 'local';

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        modelReasoningEffort: mode.modelReasoningEffort,
        collaborationMode: mode.collaborationMode
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel = opts.model;
    let currentModelReasoningEffort: ReasoningEffort | undefined = opts.modelReasoningEffort;
    let currentCollaborationMode: EnhancedMode['collaborationMode'] = 'default';

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'codex',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    if (opts.importHistory && opts.resumeSessionId) {
        try {
            const importedHistory = await importCodexSessionHistory({
                session,
                codexSessionId: opts.resumeSessionId
            });
            if (!opts.model && importedHistory.model) {
                currentModel = importedHistory.model;
            }
            if (
                !opts.modelReasoningEffort
                && importedHistory.modelReasoningEffort
                && REASONING_EFFORTS.has(importedHistory.modelReasoningEffort as ReasoningEffort)
            ) {
                currentModelReasoningEffort = importedHistory.modelReasoningEffort as ReasoningEffort;
            }
        } catch (error) {
            logger.debug('[codex] Failed to import Codex session history:', error);
            session.sendAgentMessage({
                type: 'message',
                message: `Failed to import Codex session history: ${error instanceof Error ? error.message : String(error)}`
            });
        }
    }

    const applyCurrentConfigToSession = (options?: { syncModel?: boolean }) => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        if (options?.syncModel !== false) {
            sessionInstance.setModel(currentModel ?? null);
        }
        sessionInstance.setModelReasoningEffort(currentModelReasoningEffort ?? null);
        sessionInstance.setCollaborationMode(currentCollaborationMode);
        logger.debug(
            `[Codex] Synced session config for keepalive: ` +
            `permissionMode=${currentPermissionMode}, model=${currentModel ?? 'auto'}, ` +
            `modelReasoningEffort=${currentModelReasoningEffort ?? 'default'}, collaborationMode=${currentCollaborationMode}`
        );
    };

    session.onUserMessage((message, localId) => {
        const sessionPermissionMode = sessionWrapperRef.current?.getPermissionMode();
        if (sessionPermissionMode && isPermissionModeAllowedForFlavor(sessionPermissionMode, 'codex')) {
            currentPermissionMode = sessionPermissionMode as PermissionMode;
        }
        const sessionModel = sessionWrapperRef.current?.getModel();
        if (sessionModel !== undefined) {
            currentModel = sessionModel ?? undefined;
        }
        const sessionModelReasoningEffort = sessionWrapperRef.current?.getModelReasoningEffort();
        if (sessionModelReasoningEffort !== undefined) {
            currentModelReasoningEffort = (sessionModelReasoningEffort ?? undefined) as ReasoningEffort | undefined;
        }
        const sessionCollaborationMode = sessionWrapperRef.current?.getCollaborationMode();
        if (sessionCollaborationMode) {
            currentCollaborationMode = sessionCollaborationMode;
        }

        const messagePermissionMode = currentPermissionMode;
        logger.debug(
            `[Codex] User message received with permission mode: ${currentPermissionMode}, ` +
            `model: ${currentModel ?? 'auto'}, modelReasoningEffort: ${currentModelReasoningEffort ?? 'default'}, ` +
            `collaborationMode: ${currentCollaborationMode}`
        );

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModel,
            modelReasoningEffort: currentModelReasoningEffort,
            collaborationMode: currentCollaborationMode
        };
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, enhancedMode, localId);
    });

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'codex')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveCollaborationMode = (value: unknown): EnhancedMode['collaborationMode'] => {
        if (value === null) {
            return 'default';
        }
        const parsed = CodexCollaborationModeSchema.safeParse(value);
        if (!parsed.success) {
            throw new Error('Invalid collaboration mode');
        }
        return parsed.data;
    };

    const resolveModelReasoningEffort = (value: unknown): ReasoningEffort | undefined => {
        if (value === null) {
            return undefined;
        }
        if (typeof value !== 'string' || !REASONING_EFFORTS.has(value as ReasoningEffort)) {
            throw new Error('Invalid model reasoning effort');
        }
        return value as ReasoningEffort;
    };

    const resolveModel = (value: unknown): string => {
        if (typeof value !== 'string') {
            throw new Error('Invalid model');
        }
        const trimmedValue = value.trim();
        if (!trimmedValue) {
            throw new Error('Invalid model');
        }
        return trimmedValue;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown; modelReasoningEffort?: unknown; collaborationMode?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        const shouldSyncModel = config.model !== undefined;
        if (shouldSyncModel) {
            currentModel = resolveModel(config.model);
        }

        if (config.modelReasoningEffort !== undefined) {
            currentModelReasoningEffort = resolveModelReasoningEffort(config.modelReasoningEffort);
        }

        if (config.collaborationMode !== undefined) {
            currentCollaborationMode = resolveCollaborationMode(config.collaborationMode);
        }

        applyCurrentConfigToSession({ syncModel: shouldSyncModel });
        const applied: {
            permissionMode: PermissionMode;
            model?: string | null;
            modelReasoningEffort: ReasoningEffort | null;
            collaborationMode: EnhancedMode['collaborationMode'];
        } = {
            permissionMode: currentPermissionMode,
            modelReasoningEffort: currentModelReasoningEffort ?? null,
            collaborationMode: currentCollaborationMode
        };
        if (shouldSyncModel) {
            applied.model = currentModel ?? null;
        }
        return {
            applied
        };
    });

    let crashed = false;

    try {
        await loop({
            path: workingDirectory,
            startingMode,
            messageQueue,
            api,
            session,
            codexArgs: opts.codexArgs,
            codexCliOverrides,
            startedBy,
            permissionMode: currentPermissionMode,
            model: currentModel,
            modelReasoningEffort: currentModelReasoningEffort,
            collaborationMode: currentCollaborationMode,
            resumeSessionId: opts.resumeSessionId,
            importHistory: opts.importHistory,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                applyCurrentConfigToSession();
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${formatFailureReason(localFailure.message)}`);
            lifecycle.setSessionEndReason('error');
        } else if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
