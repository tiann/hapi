import { logger } from '@/ui/logger';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CursorSession } from './session';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';

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
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[cursor] Starting with options: startedBy=${startedBy}`);

    const state: AgentState = {
        controlledByUser: false
    };
    const { api, session } = await bootstrapSession({
        flavor: 'cursor',
        startedBy,
        workingDirectory,
        agentState: state,
        model: opts.model
    });

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
    const currentModel = opts.model;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'cursor',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive()
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        logger.debug(`[cursor] Synced session permission mode: ${currentPermissionMode}`);
    };

    session.onUserMessage((message, localId) => {
        const enhancedMode: EnhancedMode = {
            permissionMode: currentPermissionMode ?? 'default',
            model: currentModel
        };
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, enhancedMode, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[cursor] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'cursor')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        syncSessionMode();
        return { applied: { permissionMode: currentPermissionMode } };
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
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
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
