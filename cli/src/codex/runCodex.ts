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
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { parseSpecialCommand } from '@/parsers/specialCommands';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

export async function runCodex(opts: {
    startedBy?: 'runner' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
    model?: string;
}): Promise<void> {
    const workingDirectory = process.env.HAPI_TARGET_CWD || process.cwd();
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

    const startingMode: 'local' | 'remote' = startedBy === 'runner' ? 'remote' : 'local';

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<EnhancedMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        collaborationMode: mode.collaborationMode
    }));

    const codexCliOverrides = parseCodexCliOverrides(opts.codexArgs);
    const sessionWrapperRef: { current: CodexSession | null } = { current: null };

    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentModel = opts.model;
    let currentCollaborationMode: EnhancedMode['collaborationMode'];

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'codex',
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
        logger.debug(`[Codex] Synced session permission mode for keepalive: ${currentPermissionMode}`);
    };

    session.onUserMessage((message) => {
        const messagePermissionMode = currentPermissionMode;
        logger.debug(`[Codex] User message received with permission mode: ${currentPermissionMode}`);

        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: currentModel,
            collaborationMode: currentCollaborationMode
        };

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        if (specialCommand.type === 'clear') {
            logger.debug('[Codex] Detected /clear command');
            messageQueue.pushIsolateAndClear('/clear', enhancedMode);
            return;
        }

        if (specialCommand.type === 'new') {
            logger.debug('[Codex] Detected /new command');
            messageQueue.pushIsolateAndClear('/new', enhancedMode);
            return;
        }

        if (specialCommand.type === 'model') {
            logger.debug('[Codex] Detected /model command');
            // Extract model name from "/model <name>" and update currentModel
            const modelArg = message.content.text.trim().slice('/model'.length).trim();
            if (modelArg) {
                currentModel = modelArg;
                logger.debug(`[Codex] Model changed to: ${currentModel}`);
            }
            // Push isolate to trigger session reset with new model config
            const updatedMode: EnhancedMode = {
                permissionMode: messagePermissionMode ?? 'default',
                model: currentModel,
                collaborationMode: currentCollaborationMode
            };
            messageQueue.pushIsolateAndClear('/model', updatedMode);
            return;
        }

        const formattedText = formatMessageWithAttachments(
            message.content.text,
            message.content.attachments,
            {
                agent: 'codex',
                cwd: workingDirectory
            }
        );
        messageQueue.push(formattedText, enhancedMode);
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
            return undefined;
        }
        if (typeof value !== 'string') {
            throw new Error('Invalid collaboration mode');
        }
        const trimmed = value.trim();
        if (trimmed !== 'plan' && trimmed !== 'default') {
            throw new Error('Invalid collaboration mode');
        }
        return trimmed as EnhancedMode['collaborationMode'];
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as {
            permissionMode?: unknown;
            collaborationMode?: unknown;
            model?: unknown;
        };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.collaborationMode !== undefined) {
            currentCollaborationMode = resolveCollaborationMode(config.collaborationMode);
        }

        if (config.model !== undefined) {
            if (typeof config.model !== 'string' || config.model.trim().length === 0) {
                throw new Error('Invalid model');
            }
            currentModel = config.model.trim();
        }

        syncSessionMode();
        return {
            applied: {
                permissionMode: currentPermissionMode,
                collaborationMode: currentCollaborationMode,
                model: currentModel
            }
        };
    });

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
            resumeSessionId: opts.resumeSessionId,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        lifecycle.markCrash(error);
        logger.debug('[codex] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${formatFailureReason(localFailure.message)}`);
        }
        await lifecycle.cleanupAndExit();
    }
}
