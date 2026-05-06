import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
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
import { parseCodexSpecialCommand } from './codexSpecialCommands';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { resolveCodexSlashCommand } from './utils/slashCommands';

export { emitReadyIfIdle } from './utils/emitReadyIfIdle';

const REASONING_EFFORTS = new Set<ReasoningEffort>(['none', 'minimal', 'low', 'medium', 'high', 'xhigh'])

export async function runCodex(opts: {
    startedBy?: 'runner' | 'terminal';
    codexArgs?: string[];
    permissionMode?: PermissionMode;
    resumeSessionId?: string;
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

    const applySlashUpdates = (updates: {
        permissionMode?: PermissionMode;
        model?: string | null;
        modelReasoningEffort?: ReasoningEffort | null;
        collaborationMode?: EnhancedMode['collaborationMode'];
    } | undefined): void => {
        if (!updates) return;
        if (updates.permissionMode !== undefined) {
            currentPermissionMode = updates.permissionMode;
        }
        if (updates.model !== undefined) {
            currentModel = updates.model ?? undefined;
        }
        if (updates.modelReasoningEffort !== undefined) {
            currentModelReasoningEffort = updates.modelReasoningEffort ?? undefined;
        }
        if (updates.collaborationMode !== undefined) {
            currentCollaborationMode = updates.collaborationMode;
        }
        applyCurrentConfigToSession();
    };

    const syncCurrentConfigFromSession = (): void => {
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
    };

    let userMessageChain: Promise<void> = Promise.resolve();
    session.onUserMessage((message, localId) => {
        userMessageChain = userMessageChain.then(async () => {
            try {
                syncCurrentConfigFromSession();
                let text = message.content.text;
                let isolatedCommandText: string | null = null;
                const commands = await listSlashCommands('codex', workingDirectory).catch(() => []);
                const slash = resolveCodexSlashCommand(text, {
                    commands,
                    permissionMode: currentPermissionMode,
                    collaborationMode: currentCollaborationMode,
                    model: currentModel,
                    modelReasoningEffort: currentModelReasoningEffort
                });
                if (slash.kind !== 'passthrough') {
                    applySlashUpdates(slash.updates);
                    if (slash.message) {
                        session.sendAgentMessage({
                            type: 'message',
                            message: slash.message,
                            id: randomUUID()
                        });
                    }
                    if (slash.kind === 'handled') {
                        if (localId) session.emitMessagesConsumed([localId]);
                        return;
                    }
                    text = slash.text;
                } else {
                    const specialCommand = parseCodexSpecialCommand(message.content.text);
                    if (specialCommand.type) {
                        logger.debug(`[Codex] Detected special command: ${specialCommand.type}`);
                        isolatedCommandText = message.content.text.trim();
                    }
                }
                text = formatMessageWithAttachments(text, message.content.attachments);

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
                if (isolatedCommandText) {
                    messageQueue.pushIsolateAndClear(isolatedCommandText, enhancedMode, localId);
                    return;
                }
                messageQueue.push(text, enhancedMode, localId);
            } catch (error) {
                logger.debug('[Codex] Failed to handle user message', error);
                const enhancedMode: EnhancedMode = {
                    permissionMode: currentPermissionMode ?? 'default',
                    model: currentModel,
                    modelReasoningEffort: currentModelReasoningEffort,
                    collaborationMode: currentCollaborationMode
                };
                messageQueue.push(formatMessageWithAttachments(message.content.text, message.content.attachments), enhancedMode, localId);
            }
        }).catch((error) => {
            logger.debug('[Codex] User message handler chain failed', error);
        });
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
