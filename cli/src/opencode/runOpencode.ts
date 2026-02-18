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
import { parseSpecialCommand } from '@/parsers/specialCommands';

export async function runOpencode(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
} = {}): Promise<void> {
    const workingDirectory = process.env.HAPI_TARGET_CWD || process.cwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[opencode] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[opencode] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    const { api, session } = await bootstrapSession({
        flavor: 'opencode',
        startedBy,
        workingDirectory,
        agentState: initialState
    });

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<OpencodeMode>((mode) => hashObject({
        permissionMode: mode.permissionMode
    }));

    const sessionWrapperRef: { current: OpencodeSession | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
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
        logger.debug(`[opencode] Synced session permission mode for keepalive: ${currentPermissionMode}`);
    };

    session.onUserMessage((message) => {
        const mode: OpencodeMode = {
            permissionMode: currentPermissionMode
        };

        const specialCommand = parseSpecialCommand(message.content.text);
        if (specialCommand.type === 'new') {
            logger.debug('[opencode] Detected /new command');
            messageQueue.pushIsolateAndClear('/new', mode);
            return;
        }

        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, mode);
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'opencode')) {
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

    try {
        await opencodeLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
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
        lifecycle.markCrash(error);
        logger.debug('[opencode] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
