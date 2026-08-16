import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { agyLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { AgyMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import type { SessionEffort, SessionModel } from '@/api/types';

export async function runAgy(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[agy] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    // agy is headless-only: the web is the primary surface, so sessions always
    // start in remote mode (no PTY, no local TUI mode).
    const startingMode: 'local' | 'remote' = opts.startingMode ?? 'remote';

    const initialState: AgentState = {
        controlledByUser: false,
        startingMode
    };

    const initialModel = opts.model ?? null;

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'agy',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'agy',
            startedBy,
            workingDirectory,
            tag: `__hapi_agy_${randomUUID()}`,
            agentState: initialState,
            model: initialModel ?? undefined,
            effort: opts.effort ?? undefined
        });
    const { api, session } = bootstrap;

    const messageQueue = new MessageQueue2<AgyMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        effort: mode.effort,
    }));

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'request-review';
    let sessionModel: SessionModel = initialModel;
    let sessionEffort: SessionEffort | undefined = opts.effort ?? undefined;

    const sessionWrapperRef: { current: any | null } = { current: null };

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'agy',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onBeforeClose: () => sessionWrapperRef.current?.kill(),
        onAfterClose: () => undefined,
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    let crashed = false;

    try {
        const syncSessionMode = () => {
            const sessionInstance = sessionWrapperRef.current;
            if (!sessionInstance) return;
            sessionInstance.setPermissionMode(currentPermissionMode);
            sessionInstance.setModel(sessionModel);
            sessionInstance.setEffort(sessionEffort);
            sessionInstance.pushKeepAlive();
            logger.debug(`[agy] Synced session config: permissionMode=${currentPermissionMode}, model=${sessionModel ?? '(default)'}`);
        };

        session.onUserMessage((message, localId) => {
            const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
            // Snapshot the spawn config at ENQUEUE time: a prompt queued while the
            // session runs on model A must not run on B if the user switches the
            // live session model before dequeue.
            const mode: AgyMode = {
                permissionMode: currentPermissionMode,
                model: sessionModel,
                effort: sessionEffort,
            };
            messageQueue.push(formattedText, mode, localId);
        });

        session.onCancelQueuedMessage((localId) => {
            // A batch held in the driver's retry backoff is outside MessageQueue2;
            // the driver-owned cancel handles it (returns true when removed).
            const retryRemoved = sessionWrapperRef.current?.cancelRetryDelivery?.(localId) ?? false;
            if (retryRemoved) {
                logger.debug(`[agy] cancelByLocalId(${localId}): removed from retry backoff`);
                return true;
            }
            const removed = messageQueue.cancelByLocalId(localId);
            logger.debug(`[agy] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found'}`);
            return removed;
        });

        registerSessionConfigRpc<PermissionMode>({
            rpcHandlerManager: session.rpcHandlerManager,
            flavor: 'agy',
            modelMode: 'nullable',
            onApply: async (config) => {
                if (config.permissionMode !== undefined) {
                    currentPermissionMode = config.permissionMode;
                }
                if (config.model !== undefined) {
                    sessionModel = config.model;
                }
            },
            onAfterApply: syncSessionMode
        });

        await agyLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined,
            effort: sessionEffort,
            resumeSessionId: opts.resumeSessionId,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[agy] Loop error:', error);
    } finally {
        if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
