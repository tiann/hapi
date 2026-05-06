import { logger } from '@/ui/logger';
import { opencodeLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { OpencodeSession } from './session';
import type { OpencodeMode, PermissionMode } from './types';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { startOpencodeHookServer } from './utils/startOpencodeHookServer';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';

export async function runOpencode(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    resumeSessionId?: string;
} = {}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[opencode] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[opencode] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    // Persist only when the user (or runner) explicitly chose a model on launch.
    // Mid-session selections are persisted by the hub via the set-session-config RPC,
    // not by this initial bootstrap.
    const initialModel = opts.model ?? null;

    const { api, session } = await bootstrapSession({
        flavor: 'opencode',
        startedBy,
        workingDirectory,
        agentState: initialState,
        model: initialModel ?? undefined
    });

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<OpencodeMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model ?? null
    }));

    const sessionWrapperRef: { current: OpencodeSession | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let sessionModel: string | null = initialModel;
    const hookServer = await startOpencodeHookServer({
        onEvent: (event) => {
            const currentSession = sessionWrapperRef.current;
            if (!currentSession) {
                return;
            }
            currentSession.emitHookEvent(event);
        }
    });
    const hookUrl = `http://127.0.0.1:${hookServer.port}/hook/opencode`;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'opencode',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onAfterClose: () => {
            hookServer.stop();
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(sessionModel);

        // Notify hub immediately so the UI reflects the change without
        // waiting for the next 2s keepalive tick.
        sessionInstance.pushKeepAlive();

        logger.debug(`[opencode] Synced session config for keepalive: permissionMode=${currentPermissionMode}, model=${sessionModel ?? '(default)'}`);
    };

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        const mode: OpencodeMode = {
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined
        };
        messageQueue.push(formattedText, mode, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[opencode] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'opencode')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveModel = (value: unknown): string | null => {
        if (value === null) {
            return null;
        }
        if (typeof value !== 'string' || value.trim().length === 0) {
            throw new Error('Invalid model');
        }
        return value.trim();
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown };
        const applied: Record<string, unknown> = {};

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
            applied.permissionMode = currentPermissionMode;
        }

        if (config.model !== undefined) {
            sessionModel = resolveModel(config.model);
            applied.model = sessionModel;
        }

        syncSessionMode();
        return { applied };
    });

    let crashed = false;

    try {
        await opencodeLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined,
            resumeSessionId: opts.resumeSessionId,
            hookServer,
            hookUrl,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[opencode] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`);
            lifecycle.setSessionEndReason('error');
        } else if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
