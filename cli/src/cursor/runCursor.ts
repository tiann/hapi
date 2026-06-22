import { logger } from '@/ui/logger';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CursorSession } from './session';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import {
    resolveNullableSessionModel,
    resolveSessionConfigPermissionMode
} from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { enqueueCursorUserMessage } from './cursorUserMessageQueue';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

const formatFailureReason = (message: string): string => {
    const maxLength = 200;
    if (message.length <= maxLength) {
        return message;
    }
    return `${message.slice(0, maxLength)}...`;
};

export async function runCursor(opts: {
    startedBy?: 'runner' | 'terminal';
    cursorArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    model?: string;
    existingSessionId?: string;
    workingDirectory?: string;
}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[cursor] Starting with options: startedBy=${startedBy}`);

    const state: AgentState = {
        controlledByUser: false
    };
    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'cursor',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'cursor',
            startedBy,
            workingDirectory,
            agentState: state,
            model: opts.model
        });
    const { api, session } = bootstrap;

    const startingMode: 'local' | 'remote' = startedBy === 'runner' ? 'remote' : 'local';

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) =>
        hashObject({
            permissionMode: mode.permissionMode,
            model: mode.model
        })
    );

    const sessionWrapperRef: { current: CursorSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel = opts.model;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'cursor',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(currentModel);
        sessionInstance.pushKeepAlive();
        logger.debug(`[cursor] Synced session mode: permissionMode=${currentPermissionMode}, model=${currentModel}`);
    };

    session.onUserMessage((message, localId) => {
        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode ?? 'default',
            model: currentModel
        };
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        enqueueCursorUserMessage(messageQueue, formattedText, enhancedMode, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[cursor] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    session.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }

        const config = payload as {
            permissionMode?: unknown;
            model?: unknown;
            modelReasoningEffort?: unknown;
        };
        const applied: {
            permissionMode?: PermissionMode;
            model?: string | null;
        } = {};

        if (config.modelReasoningEffort !== undefined) {
            throw new Error('Invalid model reasoning effort');
        }

        const nextPermissionMode = config.permissionMode !== undefined
            ? resolveSessionConfigPermissionMode<PermissionMode>(config.permissionMode, 'cursor')
            : undefined;

        if (config.model !== undefined) {
            const requestedModel = resolveNullableSessionModel(config.model);
            const sessionInstance = sessionWrapperRef.current;
            if (!sessionInstance?.canApplyModelConfig()) {
                throw new Error('Cursor ACP session is not ready to apply model changes');
            }

            const appliedModel = await sessionInstance.applyModelConfig(requestedModel);
            currentModel = appliedModel ?? undefined;
            applied.model = appliedModel;
        }

        if (nextPermissionMode !== undefined) {
            currentPermissionMode = nextPermissionMode;
            applied.permissionMode = currentPermissionMode;

            const sessionInstance = sessionWrapperRef.current;
            if (sessionInstance) {
                sessionInstance.setPermissionMode(currentPermissionMode);
                sessionInstance.pushKeepAlive();
            }
        }

        return {
            applied: Object.keys(applied).length > 0
                ? applied
                : { permissionMode: currentPermissionMode }
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
            cursorArgs: opts.cursorArgs,
            startedBy,
            permissionMode: currentPermissionMode,
            resumeSessionId: opts.resumeSessionId,
            model: opts.model,
            sessionMetadata: bootstrap.metadata,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
        const errMsg = error instanceof Error ? error.message : String(error);
        session.sendSessionEvent({
            type: 'message',
            message: `Cursor Agent failed: ${errMsg}`
        });
        lifecycle.markCrash(error);
        logger.debug('[cursor] Loop error:', error);
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
