import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { loop, type EnhancedMode, type PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CodexSession } from './session';
import { parseCodexCliOverrides } from './utils/codexCliOverrides';
import { bootstrapSession } from '@/agent/sessionFactory';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

export async function runCodex(opts: {
    startedBy?: 'daemon' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
}): Promise<void> {
    const workingDirectory = process.cwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[codex] Starting with options: startedBy=${startedBy}`);

    let state: AgentState = {
        controlledByUser: false
    };
    const { api, session } = await bootstrapSession({
        flavor: 'codex',
        startedBy,
        workingDirectory,
        agentState: state
    });

    const startingMode: 'local' | 'remote' = startedBy === 'daemon' ? 'remote' : 'local';

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: startingMode === 'local'
    }));

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        logger.debug(`[Codex] Synced session permission mode for keepalive: ${currentPermissionMode}`);
    };

    session.onUserMessage((message) => {
        const messagePermissionMode = currentPermissionMode;
        logger.debug(`[Codex] User message received with permission mode: ${currentPermissionMode}`);

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default'
        };
        messageQueue.push(message.content.text, enhancedMode);
    });

    let cleanupStarted = false;
    let exitCode = 0;
    let archiveReason = 'User terminated';

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    const cleanup = async (code: number = exitCode) => {
        if (cleanupStarted) {
            return;
        }
        cleanupStarted = true;
        logger.debug('[codex] Cleanup start');
        restoreTerminalState();
        try {
            const sessionWrapper = sessionWrapperRef.current;
            if (sessionWrapper) {
                sessionWrapper.stopKeepAlive();
            }

            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                lifecycleState: 'archived',
                lifecycleStateSince: Date.now(),
                archivedBy: 'cli',
                archiveReason
            }));

            session.sendSessionDeath();
            await session.flush();
            await session.close();

            logger.debug('[codex] Cleanup complete, exiting');
            process.exit(code);
        } catch (error) {
            logger.debug('[codex] Error during cleanup:', error);
            process.exit(1);
        }
    };

    process.on('SIGTERM', () => cleanup(0));
    process.on('SIGINT', () => cleanup(0));

    process.on('uncaughtException', (error) => {
        logger.debug('[codex] Uncaught exception:', error);
        exitCode = 1;
        archiveReason = 'Session crashed';
        cleanup(1);
    });

    process.on('unhandledRejection', (reason) => {
        logger.debug('[codex] Unhandled rejection:', reason);
        exitCode = 1;
        archiveReason = 'Session crashed';
        cleanup(1);
    });

    registerKillSessionHandler(session.rpcHandlerManager, cleanup);

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: PermissionMode };

        if (config.permissionMode !== undefined) {
            const validModes: PermissionMode[] = ['default', 'read-only', 'safe-yolo', 'yolo'];
            if (!validModes.includes(config.permissionMode)) {
                throw new Error('Invalid permission mode');
            }
            currentPermissionMode = config.permissionMode;
        }

        syncSessionMode();
        return { applied: { permissionMode: currentPermissionMode } };
    });

    let loopError: unknown = null;
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
            onModeChange: (newMode) => {
                session.sendSessionEvent({ type: 'switch', mode: newMode });
                session.updateAgentState((currentState) => ({
                    ...currentState,
                    controlledByUser: newMode === 'local'
                }));
            },
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        loopError = error;
        exitCode = 1;
        archiveReason = 'Session crashed';
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            exitCode = 1;
            archiveReason = `Local launch failed: ${formatFailureReason(localFailure.message)}`;
        }
        await cleanup(loopError ? 1 : exitCode);
    }
}
