import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, SessionEffort, SessionModel } from '@/api/types';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { classifyClaudeSlashCatalog, extractSDKMetadata } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { startHappyServer, toClaudeAllowedHapiMcpTools } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/modules/common/hooks/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import type { Session } from './session';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatAttachmentsForClaude, formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { normalizeClaudeSessionModel } from './model';
import { normalizeClaudeSessionEffort } from './effort';
import { normalizeHookPermissionMode } from './utils/hookPermissionMode';
import { getInvokedCwd } from '@/utils/invokedCwd';
import {
    CLAUDE_CONVERSATION_HISTORY,
    toConversationHistoryCapabilities
} from '@hapi/protocol/conversationHistory';
import { listSkills, type SkillSummary } from '@/modules/common/skills';

export interface StartOptions {
    model?: string
    effort?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartRunner?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'runner' | 'terminal'
    existingSessionId?: string
    workingDirectory?: string
    resumeSessionId?: string
}

export async function runClaude(options: StartOptions = {}): Promise<void> {
    const workingDirectory = options.workingDirectory ?? getInvokedCwd();
    const startedBy = options.startedBy ?? 'terminal';

    // Log environment info at startup
    logger.debugLargeJson('[START] HAPI process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${startedBy}, startingMode=${options.startingMode}`);

    // Validate runner spawn requirements
    if (startedBy === 'runner' && options.startingMode === 'local') {
        logger.debug('Runner spawn requested with local mode - forcing remote mode');
        options.startingMode = 'remote';
        // TODO: Eventually we should error here instead of silently switching
        // throw new Error('Runner-spawned sessions cannot use local/interactive mode');
    }

    const initialState: AgentState = {};
    const initialModel = normalizeClaudeSessionModel(options.model);
    const initialEffort = normalizeClaudeSessionEffort(options.effort);
    const bootstrap = options.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: options.existingSessionId,
            flavor: 'claude',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'claude',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: initialModel ?? undefined,
            effort: initialEffort ?? undefined
        });
    const { api, session, sessionInfo } = bootstrap;
    logger.debug(`Session created: ${sessionInfo.id}`);

    const currentSessionRef: { current: Session | null } = { current: null };
    let resolveSessionReady!: (session: Session) => void;
    const sessionReady = new Promise<Session>((resolve) => {
        resolveSessionReady = resolve;
    });
    let nativeSkills: SkillSummary[] | null = null;

    const loadCatalog = async () => {
        const [sdkMetadata, discoveredSkills] = await Promise.all([
            extractSDKMetadata({ cwd: workingDirectory, claudeArgs: options.claudeArgs }),
            listSkills(workingDirectory, { flavor: 'claude' })
        ]);
        return {
            sdkMetadata,
            catalog: classifyClaudeSlashCatalog(
                sdkMetadata.slashCommands,
                discoveredSkills,
                sdkMetadata.skills
            )
        };
    };
    let catalogPromise: ReturnType<typeof loadCatalog> | null = null;
    const getCatalog = (): ReturnType<typeof loadCatalog> => {
        if (!catalogPromise) {
            catalogPromise = loadCatalog().then((result) => {
                const { sdkMetadata, catalog } = result;
                logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
                if (sdkMetadata.slashCommands === undefined) {
                    catalogPromise = null;
                    if (sdkMetadata.tools !== undefined) {
                        session.updateMetadata((currentMetadata) => ({
                            ...currentMetadata,
                            tools: sdkMetadata.tools
                        }));
                    }
                    return result;
                }
                nativeSkills = catalog.skills;
                currentSessionRef.current?.setNativeSkillNames(catalog.skills.map((skill) => skill.name));
                session.updateMetadata((currentMetadata) => ({
                    ...currentMetadata,
                    tools: sdkMetadata.tools,
                    slashCommands: catalog.commands
                }));
                logger.debug('[start] Session metadata updated with SDK capabilities');
                return result;
            }).catch((error) => {
                catalogPromise = null;
                throw error;
            });
        }
        return catalogPromise;
    };
    session.rpcHandlerManager.registerHandler(RPC_METHODS.ListSkills, async () => {
        const result = await getCatalog();
        return result.sdkMetadata.slashCommands === undefined
            ? { success: false, error: 'Claude skill catalog unavailable' }
            : { success: true, skills: result.catalog.skills };
    });

    // Extract SDK metadata in background and update session when ready
    void getCatalog().catch((error) => {
        logger.debug('[start] Failed to update session metadata:', error);
    });

    // Start HAPI MCP server
    const happyServer = await startHappyServer(session);
    logger.debug(`[START] HAPI MCP server started at ${happyServer.url}`);

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            const currentSession = currentSessionRef.current;
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }

            // Inherit the mode the user picked inside the interactive TUI
            // (shift+tab) so a later local→remote switch keeps it. Only the
            // local settings file registers the hooks that carry
            // permission_mode, but gate on local mode anyway so a remote SDK
            // process can never fight with web/RPC-driven state.
            const hookPermissionMode = normalizeHookPermissionMode(data.permission_mode);
            if (
                hookPermissionMode
                && currentSession?.mode === 'local'
                && hookPermissionMode !== currentPermissionMode
            ) {
                logger.debug(`[START] Inheriting permission mode from local Claude: ${currentPermissionMode} -> ${hookPermissionMode}`);
                currentPermissionMode = hookPermissionMode;
                syncSessionModes();
                currentSession.pushKeepAlive();
                session.sendSessionEvent({
                    type: 'permission-mode-changed',
                    mode: hookPermissionMode
                });
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    const hookSettingsPath = generateHookSettingsFile(hookServer.port, hookServer.token, {
        filenamePrefix: 'session-hook',
        logLabel: 'generateHookSettings'
    });
    // The interactive TUI gets a separate settings file that also forwards
    // UserPromptSubmit/PreToolUse (their payloads carry permission_mode), so a
    // mode picked via shift+tab is inherited on local→remote switch. The
    // remote SDK process keeps the SessionStart-only file: these extra hooks
    // block Claude per prompt/tool call, and remote mode state is owned by the
    // hub/RPC path.
    const localHookSettingsPath = generateHookSettingsFile(hookServer.port, hookServer.token, {
        filenamePrefix: 'session-hook-local',
        logLabel: 'generateHookSettings',
        trackPermissionMode: true
    });
    logger.debug(`[START] Generated hook settings files: ${hookSettingsPath}, ${localHookSettingsPath}`);

    // Print log file path
    const logPath = logger.logFilePath;
    logger.infoDeveloper(`Session: ${sessionInfo.id}`);
    logger.infoDeveloper(`Logs: ${logPath}`);

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'claude',
        stopKeepAlive: () => currentSessionRef.current?.stopKeepAlive(),
        onAfterClose: () => {
            happyServer.stop();
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath, 'generateHookSettings');
            cleanupHookSettingsFile(localHookSettingsPath, 'generateHookSettings');
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    const conversationHistory = toConversationHistoryCapabilities(CLAUDE_CONVERSATION_HISTORY)
    session.updateMetadata((metadata) => ({
        ...metadata,
        path: metadata?.path ?? workingDirectory,
        host: metadata?.host ?? 'unknown',
        capabilities: {
            ...metadata?.capabilities,
            ...(conversationHistory ? { conversationHistory } : {})
        }
    }))

    session.rpcHandlerManager.registerHandler(RPC_METHODS.ForkConversation, async (payload: unknown) => {
        if (payload && typeof payload === 'object' && 'messageLocalId' in payload && (payload as { messageLocalId?: unknown }).messageLocalId) {
            throw new Error('Historical fork is not supported for Claude')
        }
        const nativeSessionId = currentSessionRef.current?.sessionId
            ?? session.getMetadata()?.claudeSessionId
            ?? sessionInfo.metadata?.claudeSessionId
            ?? null
        if (!nativeSessionId) {
            throw new Error('Claude session id is not ready')
        }
        return { nativeSessionId, forkSession: true as const }
    })
    session.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async () => {
        throw new Error('Rewind is not supported for Claude')
    })

    // Set initial agent state
    const startingMode = options.startingMode ?? (startedBy === 'runner' ? 'remote' : 'local');
    setControlledByUser(session, startingMode);

    // Import MessageQueue2 and create message queue
    // 'plan' and 'auto' are enforced inside Claude itself (not emulated via
    // canCallTool like acceptEdits/bypassPermissions), so switching to/from
    // them must start a new process with the matching --permission-mode flag.
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        agentEnforcedMode: mode.permissionMode === 'plan' || mode.permissionMode === 'auto' ? mode.permissionMode : null,
        model: mode.model,
        effort: mode.effort,
        fallbackModel: mode.fallbackModel,
        customSystemPrompt: mode.customSystemPrompt,
        appendSystemPrompt: mode.appendSystemPrompt,
        allowedTools: mode.allowedTools,
        disallowedTools: mode.disallowedTools
    }));

    // Forward messages to the queue
    let currentPermissionMode: PermissionMode = options.permissionMode ?? 'default';
    let currentModel: SessionModel = initialModel;
    let currentEffort: SessionEffort = initialEffort;
    let currentFallbackModel: string | undefined = undefined; // Track current fallback model
    let currentCustomSystemPrompt: string | undefined = undefined; // Track current custom system prompt
    let currentAppendSystemPrompt: string | undefined = undefined; // Track current append system prompt
    let currentAllowedTools: string[] | undefined = undefined; // Track current allowed tools
    let currentDisallowedTools: string[] | undefined = undefined; // Track current disallowed tools

    const syncSessionModes = () => {
        const sessionInstance = currentSessionRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(currentModel);
        sessionInstance.setEffort(currentEffort);
        logger.debug(`[loop] Synced session config for keepalive: permissionMode=${currentPermissionMode}, model=${currentModel ?? 'auto'}, effort=${currentEffort ?? 'auto'}`);
    };
    type UserMessageHandler = Parameters<typeof session.onUserMessage>[0];
    type UserMessageArgs = Parameters<UserMessageHandler>;
    const deferredMessages: UserMessageArgs[] = [];
    let messagePipelineReady = false;
    const handleUserMessage: UserMessageHandler = (message, localId) => {
        const sessionPermissionMode = currentSessionRef.current?.getPermissionMode();
        if (sessionPermissionMode && isPermissionModeAllowedForFlavor(sessionPermissionMode, 'claude')) {
            currentPermissionMode = sessionPermissionMode as PermissionMode;
        }
        const sessionModel = currentSessionRef.current?.getModel();
        if (sessionModel !== undefined) {
            currentModel = sessionModel;
        }
        const sessionEffort = currentSessionRef.current?.getEffort();
        if (sessionEffort !== undefined) {
            currentEffort = sessionEffort;
        }
        const messagePermissionMode = currentPermissionMode;
        const messageModel = currentModel ?? undefined;
        const messageEffort = currentEffort ?? undefined;
        logger.debug(`[loop] User message received with permission mode: ${currentPermissionMode}, model: ${currentModel ?? 'auto'}, effort: ${currentEffort ?? 'auto'}`);

        // Resolve custom system prompt - use message.meta.customSystemPrompt if provided, otherwise use current
        let messageCustomSystemPrompt = currentCustomSystemPrompt;
        if (message.meta?.hasOwnProperty('customSystemPrompt')) {
            messageCustomSystemPrompt = message.meta.customSystemPrompt || undefined; // null becomes undefined
            currentCustomSystemPrompt = messageCustomSystemPrompt;
            logger.debug(`[loop] Custom system prompt updated from user message: ${messageCustomSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no custom system prompt override, using current: ${currentCustomSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve fallback model - use message.meta.fallbackModel if provided, otherwise use current fallback model
        let messageFallbackModel = currentFallbackModel;
        if (message.meta?.hasOwnProperty('fallbackModel')) {
            messageFallbackModel = message.meta.fallbackModel || undefined; // null becomes undefined
            currentFallbackModel = messageFallbackModel;
            logger.debug(`[loop] Fallback model updated from user message: ${messageFallbackModel || 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no fallback model override, using current: ${currentFallbackModel || 'none'}`);
        }

        // Resolve append system prompt - use message.meta.appendSystemPrompt if provided, otherwise use current
        let messageAppendSystemPrompt = currentAppendSystemPrompt;
        if (message.meta?.hasOwnProperty('appendSystemPrompt')) {
            messageAppendSystemPrompt = message.meta.appendSystemPrompt || undefined; // null becomes undefined
            currentAppendSystemPrompt = messageAppendSystemPrompt;
            logger.debug(`[loop] Append system prompt updated from user message: ${messageAppendSystemPrompt ? 'set' : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no append system prompt override, using current: ${currentAppendSystemPrompt ? 'set' : 'none'}`);
        }

        // Resolve allowed tools - use message.meta.allowedTools if provided, otherwise use current
        let messageAllowedTools = currentAllowedTools;
        if (message.meta?.hasOwnProperty('allowedTools')) {
            messageAllowedTools = message.meta.allowedTools || undefined; // null becomes undefined
            currentAllowedTools = messageAllowedTools;
            logger.debug(`[loop] Allowed tools updated from user message: ${messageAllowedTools ? messageAllowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no allowed tools override, using current: ${currentAllowedTools ? currentAllowedTools.join(', ') : 'none'}`);
        }

        // Resolve disallowed tools - use message.meta.disallowedTools if provided, otherwise use current
        let messageDisallowedTools = currentDisallowedTools;
        if (message.meta?.hasOwnProperty('disallowedTools')) {
            messageDisallowedTools = message.meta.disallowedTools || undefined; // null becomes undefined
            currentDisallowedTools = messageDisallowedTools;
            logger.debug(`[loop] Disallowed tools updated from user message: ${messageDisallowedTools ? messageDisallowedTools.join(', ') : 'reset to none'}`);
        } else {
            logger.debug(`[loop] User message received with no disallowed tools override, using current: ${currentDisallowedTools ? currentDisallowedTools.join(', ') : 'none'}`);
        }

        // Check for special commands before processing
        const specialCommand = parseSpecialCommand(message.content.text);

        // Native slash skills must stay at the start of the prompt. Regular
        // messages keep the existing attachment-first format.
        const attachmentText = formatAttachmentsForClaude(message.content.attachments);
        const expandedText = currentSessionRef.current?.expandSkillReference(message.content.text, attachmentText)
            ?? message.content.text;
        const formattedText = expandedText !== message.content.text
            ? expandedText
            : formatMessageWithAttachments(message.content.text, message.content.attachments);

        if (specialCommand.type === 'compact') {
            logger.debug('[start] Detected /compact command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode ?? 'default',
                model: messageModel,
                effort: messageEffort,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            // Use raw text only, ignore attachments for special commands
            const commandText = specialCommand.originalMessage || message.content.text;
            messageQueue.pushIsolateAndClear(commandText, enhancedMode, localId);
            logger.debugLargeJson('[start] /compact command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'clear') {
            logger.debug('[start] Detected /clear command');
            const enhancedMode: EnhancedMode = {
                permissionMode: messagePermissionMode ?? 'default',
                model: messageModel,
                effort: messageEffort,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };
            // Use raw text only, ignore attachments for special commands
            const commandText = specialCommand.originalMessage || message.content.text;
            messageQueue.pushIsolateAndClear(commandText, enhancedMode, localId);
            logger.debugLargeJson('[start] /clear command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'plan') {
            logger.debug('[start] Detected /plan command');
            currentPermissionMode = specialCommand.mode ?? 'plan';
            currentSessionRef.current?.setPermissionMode(currentPermissionMode);
            currentSessionRef.current?.pushKeepAlive();
            session.sendSessionEvent({
                type: 'permission-mode-changed',
                mode: currentPermissionMode
            });

            const enhancedMode: EnhancedMode = {
                permissionMode: currentPermissionMode,
                model: messageModel,
                effort: messageEffort,
                fallbackModel: messageFallbackModel,
                customSystemPrompt: messageCustomSystemPrompt,
                appendSystemPrompt: messageAppendSystemPrompt,
                allowedTools: messageAllowedTools,
                disallowedTools: messageDisallowedTools
            };

            if (!specialCommand.prompt) {
                if (localId) {
                    session.emitMessagesConsumed([localId]);
                }
                logger.debugLargeJson('[start] /plan command applied without prompt:', message);
                return;
            }

            const planPrompt = formatMessageWithAttachments(specialCommand.prompt, message.content.attachments);
            messageQueue.push(planPrompt, enhancedMode, localId);
            logger.debugLargeJson('[start] /plan command prompt pushed to queue:', message);
            return;
        }

        // Push with resolved permission mode, model, system prompts, and tools
        const enhancedMode: EnhancedMode = {
            permissionMode: messagePermissionMode ?? 'default',
            model: messageModel,
            effort: messageEffort,
            fallbackModel: messageFallbackModel,
            customSystemPrompt: messageCustomSystemPrompt,
            appendSystemPrompt: messageAppendSystemPrompt,
            allowedTools: messageAllowedTools,
            disallowedTools: messageDisallowedTools
        };
        messageQueue.push(formattedText, enhancedMode, localId);
        logger.debugLargeJson('User message pushed to queue:', message)
    };
    session.onUserMessage((...args) => {
        if (!messagePipelineReady) {
            deferredMessages.push(args);
            return;
        }
        handleUserMessage(...args);
    });
    void Promise.allSettled([sessionReady, getCatalog()]).then(() => {
        messagePipelineReady = true;
        for (const args of deferredMessages.splice(0)) {
            handleUserMessage(...args);
        }
    });

    session.onCancelQueuedMessage((localId) => {
        const deferredIndex = deferredMessages.findIndex(([, id]) => id === localId);
        if (deferredIndex >= 0) {
            deferredMessages.splice(deferredIndex, 1);
            return true;
        }
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[claude] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, 'claude')) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as PermissionMode;
    };

    const resolveModel = (value: unknown): SessionModel => {
        if (value === null) {
            return null;
        }

        if (typeof value !== 'string') {
            throw new Error('Invalid model');
        }

        return normalizeClaudeSessionModel(value);
    };

    const resolveEffort = (value: unknown): SessionEffort => {
        if (value === null) {
            return null;
        }

        if (typeof value !== 'string') {
            throw new Error('Invalid effort');
        }

        return normalizeClaudeSessionEffort(value);
    };

    session.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown; effort?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.model !== undefined) {
            currentModel = resolveModel(config.model);
        }

        if (config.effort !== undefined) {
            currentEffort = resolveEffort(config.effort);
        }

        syncSessionModes();
        return { applied: { permissionMode: currentPermissionMode, model: currentModel, effort: currentEffort } };
    });

    let loopError: unknown = null;
    let loopFailed = false;
    try {
        await loop({
            path: workingDirectory,
            model: currentModel,
            effort: currentEffort,
            permissionMode: options.permissionMode,
            startingMode,
            messageQueue,
            api,
            allowedTools: toClaudeAllowedHapiMcpTools(happyServer.toolNames),
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (sessionInstance) => {
                currentSessionRef.current = sessionInstance;
                resolveSessionReady(sessionInstance);
                if (nativeSkills) {
                    sessionInstance.setNativeSkillNames(nativeSkills.map((skill) => skill.name));
                }
                syncSessionModes();
            },
            mcpServers: {
                'hapi': {
                    type: 'http' as const,
                    url: happyServer.url,
                }
            },
            session,
            claudeEnvVars: options.claudeEnvVars,
            claudeArgs: options.claudeArgs,
            startedBy,
            resumeSessionId: options.resumeSessionId,
            hookSettingsPath,
            localHookSettingsPath
        });
    } catch (error) {
        loopError = error;
        loopFailed = true;
        lifecycle.markCrash(error);
    }

    const localFailure = currentSessionRef.current?.localLaunchFailure;
    if (localFailure?.exitReason === 'exit') {
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(`Local launch failed: ${formatFailureReason(localFailure.message)}`);
        lifecycle.setSessionEndReason('error');
    }

    if (loopFailed) {
        await lifecycle.cleanup();
        throw loopError;
    }

    if (!localFailure) {
        lifecycle.setSessionEndReason('completed');
    }

    await lifecycle.cleanupAndExit();
}
