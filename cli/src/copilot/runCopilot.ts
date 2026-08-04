import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { copilotLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { CopilotSession } from './session';
import type { CopilotMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isCopilotAgentMode, isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { resolveCopilotRuntimeConfig } from './utils/config';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { resolveCopilotSlashCommand } from './utils/slashCommands';

export async function applyCopilotSlashAgentMode(
    currentAgentMode: import('@hapi/protocol').CopilotAgentMode,
    nextAgentMode: import('@hapi/protocol').CopilotAgentMode | undefined,
    activeSession: CopilotSession | null
): Promise<import('@hapi/protocol').CopilotAgentMode> {
    if (nextAgentMode === undefined || nextAgentMode === currentAgentMode) {
        return currentAgentMode;
    }
    if (!activeSession) {
        throw new Error('Copilot remote session is not ready for agent mode switching');
    }
    await activeSession.applyRemoteAgentMode(nextAgentMode);
    return nextAgentMode;
}

export function resolveCopilotQueueModel(model: string | null): string {
    return model ?? 'auto';
}

export async function runCopilot(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    copilotAgentMode?: import('@hapi/protocol').CopilotAgentMode;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[copilot] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[copilot] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    const runtimeConfig = resolveCopilotRuntimeConfig({ model: opts.model });
    const persistedModel = runtimeConfig.modelSource === 'default'
        ? undefined
        : runtimeConfig.model;

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'copilot',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'copilot',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: persistedModel
        });
    const { api, session } = bootstrap;

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<CopilotMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        model: mode.model,
        agentMode: mode.agentMode
    }));

    const sessionWrapperRef: { current: CopilotSession | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let currentAgentMode = opts.copilotAgentMode ?? 'interactive';
    let sessionModel: string | null = persistedModel ?? null;
    let resolvedModel = sessionModel ?? runtimeConfig.model ?? null;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'copilot',
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
        sessionInstance.setModel(sessionModel);
        sessionInstance.setAgentMode(currentAgentMode);
        sessionInstance.pushKeepAlive();

        logger.debug(`[copilot] Synced session config for keepalive: permissionMode=${currentPermissionMode}, agentMode=${currentAgentMode}, model=${resolvedModel}`);
    };

    const buildMode = (): CopilotMode => ({
        permissionMode: currentPermissionMode,
        model: resolvedModel ?? undefined,
        agentMode: currentAgentMode
    });

    const preparingLocalIds = new Set<string>();
    const cancelledBeforeEnqueue = new Set<string>();
    let userMessageChain: Promise<void> = Promise.resolve();

    session.onUserMessage((message, localId) => {
        if (localId) preparingLocalIds.add(localId);
        userMessageChain = userMessageChain.then(async () => {
            const wasCancelled = (): boolean => {
                if (!localId) return false;
                return cancelledBeforeEnqueue.delete(localId);
            };
            const pushPlain = () => {
                const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
                messageQueue.push(formattedText, buildMode(), localId);
            };
            let recognizedSlash = false;
            try {
                if (wasCancelled()) return;
                let text = message.content.text;
                const commands = await listSlashCommands('copilot', workingDirectory).catch(() => []);
                if (wasCancelled()) return;
                const slash = resolveCopilotSlashCommand(text, {
                    commands,
                    permissionMode: currentPermissionMode,
                    model: sessionModel,
                    agentMode: currentAgentMode
                });

                if (slash.kind !== 'passthrough') {
                    recognizedSlash = true;
                    if (sessionWrapperRef.current?.mode === 'local'
                        && (slash.updates?.permissionMode !== undefined
                            || slash.updates?.model !== undefined
                            || slash.updates?.agentMode !== undefined)) {
                        if (localId) {
                            session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                        }
                        session.sendAgentMessage({
                            type: 'message',
                            message: 'Copilot model, permission mode, and agent mode can only be changed for remote sessions.',
                            id: randomUUID()
                        });
                        sessionWrapperRef.current.pushKeepAlive();
                        return;
                    }
                    if (slash.updates) {
                        const requestedAgentMode = slash.updates.agentMode;
                        currentAgentMode = await applyCopilotSlashAgentMode(
                            currentAgentMode,
                            requestedAgentMode,
                            sessionWrapperRef.current
                        );
                        if (slash.updates.permissionMode !== undefined) {
                            currentPermissionMode = slash.updates.permissionMode;
                        }
                        if (slash.updates.model !== undefined) {
                            sessionModel = slash.updates.model;
                            resolvedModel = resolveCopilotQueueModel(sessionModel);
                        }
                        syncSessionMode();
                        if (wasCancelled()) return;
                    }
                    if (slash.kind === 'handled') {
                        if (localId) {
                            session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                        }
                        if (slash.message) {
                            session.sendAgentMessage({
                                type: 'message',
                                message: slash.message,
                                id: randomUUID()
                            });
                        }
                        sessionWrapperRef.current?.pushKeepAlive();
                        return;
                    }
                    if (slash.message) {
                        session.sendAgentMessage({
                            type: 'message',
                            message: slash.message,
                            id: randomUUID()
                        });
                    }
                    text = slash.text;
                }

                const formattedText = formatMessageWithAttachments(text, message.content.attachments);
                messageQueue.push(formattedText, buildMode(), localId);
            } catch (error) {
                logger.debug('[copilot] Failed to handle user message', error);
                if (wasCancelled()) return;
                if (recognizedSlash) {
                    if (localId) {
                        session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                    }
                    session.sendAgentMessage({
                        type: 'message',
                        message: error instanceof Error ? error.message : 'Failed to apply Copilot slash command',
                        id: randomUUID()
                    });
                    sessionWrapperRef.current?.pushKeepAlive();
                    return;
                }
                pushPlain();
            } finally {
                if (localId) {
                    preparingLocalIds.delete(localId);
                    cancelledBeforeEnqueue.delete(localId);
                }
            }
        }).catch((error) => {
            logger.debug('[copilot] User message handler chain failed', error);
        });
    });

    session.onCancelQueuedMessage((localId) => {
        const removedFromQueue = messageQueue.cancelByLocalId(localId);
        if (!removedFromQueue && preparingLocalIds.has(localId)) {
            cancelledBeforeEnqueue.add(localId);
        }
        logger.debug(`[copilot] cancelByLocalId(${localId}): ${removedFromQueue ? 'removed' : 'not found (best-effort)'}`);
        return removedFromQueue || cancelledBeforeEnqueue.has(localId);
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'copilot')) {
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
        const config = payload as { permissionMode?: unknown; model?: unknown; copilotAgentMode?: unknown };
        const applied: Record<string, unknown> = {};

        if (config.permissionMode !== undefined) {
            if (sessionWrapperRef.current?.mode === 'local') {
                throw new Error('Copilot permission mode can only be changed for remote sessions');
            }
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
            applied.permissionMode = currentPermissionMode;
        }

        if (config.model !== undefined) {
            if (sessionWrapperRef.current?.mode === 'local') {
                throw new Error('Copilot model can only be changed for remote sessions');
            }
            sessionModel = resolveModel(config.model);
            resolvedModel = resolveCopilotQueueModel(sessionModel);
            applied.model = sessionModel;
        }

        if (config.copilotAgentMode !== undefined) {
            if (!isCopilotAgentMode(config.copilotAgentMode)) {
                throw new Error('Invalid copilot agent mode');
            }
            if (config.copilotAgentMode !== currentAgentMode) {
                const activeSession = sessionWrapperRef.current;
                if (!activeSession) {
                    throw new Error('Copilot remote session is not ready for agent mode switching');
                }
                await activeSession.applyRemoteAgentMode(config.copilotAgentMode);
                currentAgentMode = config.copilotAgentMode;
            }
            applied.copilotAgentMode = currentAgentMode;
        }

        syncSessionMode();
        return { applied };
    });

    let crashed = false;

    try {
        await copilotLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: runtimeConfig.model,
            copilotAgentMode: currentAgentMode,
            resumeSessionId: opts.resumeSessionId,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            },
            onModelRollback: (model) => {
                sessionModel = model;
                resolvedModel = resolveCopilotQueueModel(model);
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[copilot] Loop error:', error);
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
