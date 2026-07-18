import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, SessionEffort, SessionModel } from '@/api/types';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/modules/common/hooks/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import type { Session } from './session';
import { bootstrapSession } from '@/agent/sessionFactory';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import {
    DEFAULT_CLAUDE_DEEPSEEK_MODEL,
    isCcApiEffortAllowedForModel,
    isClaudeDeepSeekEffortAllowedForModel,
    isClaudeDeepSeekModelPreset,
    isKnownCcApiModel,
    isPermissionModeAllowedForFlavor
} from '@hapi/protocol';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { normalizeClaudeSessionModel } from './model';
import { normalizeClaudeSessionEffort } from './effort';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { applyHapiSessionEnvironment } from '@/agent/sessionEnvironment';

export interface StartOptions {
    model?: string
    effort?: string
    permissionMode?: PermissionMode
    startingMode?: 'local' | 'remote'
    shouldStartRunner?: boolean
    claudeEnvVars?: Record<string, string>
    claudeArgs?: string[]
    startedBy?: 'runner' | 'terminal'
    agentFlavor?: 'claude' | 'claude-deepseek' | 'claude-ark' | 'cc-api'
}

function hasResumeArgument(args: string[] | undefined): boolean {
    return args?.some((arg) => arg === '--resume' || arg.startsWith('--resume=')) === true;
}

function readLastClaudeOption(
    args: string[] | undefined,
    option: string
): { found: boolean; value: string | undefined } {
    const values = args ?? [];
    let found = false;
    let value: string | undefined;

    for (let i = 0; i < values.length; i += 1) {
        const arg = values[i];
        if (arg === option) {
            found = true;
            value = values[i + 1];
            i += 1;
        } else if (arg.startsWith(`${option}=`)) {
            found = true;
            value = arg.slice(option.length + 1);
        }
    }

    return { found, value };
}

function removeInvalidEffortArgs(
    args: string[] | undefined,
    isAllowed: (effort: string | null) => boolean
): string[] | undefined {
    if (!args) {
        return undefined;
    }

    let changed = false;
    const sanitized: string[] = [];

    for (let i = 0; i < args.length; i++) {
        const arg = args[i];

        if (arg === '--effort') {
            const value = args[i + 1];
            if (value !== undefined && !isAllowed(normalizeClaudeSessionEffort(value))) {
                changed = true;
                i += 1;
                continue;
            }
        } else if (arg.startsWith('--effort=')) {
            const value = arg.slice('--effort='.length);
            if (!isAllowed(normalizeClaudeSessionEffort(value))) {
                changed = true;
                continue;
            }
        }

        sanitized.push(arg);
    }

    return changed ? sanitized : args;
}

export async function runClaude(options: StartOptions = {}): Promise<void> {
    const workingDirectory = getInvokedCwd();
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

    const agentFlavor = options.agentFlavor ?? 'claude';
    const resumedFromPersistedSession = hasResumeArgument(options.claudeArgs);
    const initialState: AgentState = {};
    const rawModelOption = readLastClaudeOption(options.claudeArgs, '--model');
    let initialModel = normalizeClaudeSessionModel(rawModelOption.found ? rawModelOption.value : options.model);
    if (rawModelOption.found && initialModel === null) {
        throw new Error('Missing --model value');
    }
    let initialEffort = normalizeClaudeSessionEffort(options.effort);
    if (agentFlavor === 'claude-deepseek') {
        if (initialModel === null) {
            initialModel = DEFAULT_CLAUDE_DEEPSEEK_MODEL;
        } else if (!isClaudeDeepSeekModelPreset(initialModel)) {
            throw new Error(`Unknown CC-deepseek model: ${initialModel}`);
        }
        if (!isClaudeDeepSeekEffortAllowedForModel(initialModel, initialEffort)) {
            initialEffort = null;
        }
    }
    const unlistedCcApiResumeModel = agentFlavor === 'cc-api'
        && initialModel !== null
        && !isKnownCcApiModel(initialModel);
    if (unlistedCcApiResumeModel && !resumedFromPersistedSession) {
        throw new Error(`Unknown CC-api model: ${initialModel}`);
    }
    const persistedResumeEffortPassThrough = agentFlavor === 'cc-api'
        && resumedFromPersistedSession
        && unlistedCcApiResumeModel
        && !isCcApiEffortAllowedForModel(initialModel, initialEffort)
        && isCcApiEffortAllowedForModel(initialModel, initialEffort, { allowUnlistedModel: true });
    if (agentFlavor === 'cc-api' && !isCcApiEffortAllowedForModel(
        initialModel,
        initialEffort,
        { allowUnlistedModel: resumedFromPersistedSession }
    )) {
        initialEffort = null;
    }
    const claudeArgs = agentFlavor === 'cc-api'
        ? removeInvalidEffortArgs(options.claudeArgs, (effort) => isCcApiEffortAllowedForModel(
            initialModel,
            effort,
            { allowUnlistedModel: resumedFromPersistedSession }
        ))
        : agentFlavor === 'claude-deepseek'
            ? removeInvalidEffortArgs(options.claudeArgs, (effort) => isClaudeDeepSeekEffortAllowedForModel(initialModel, effort))
            : options.claudeArgs;
    const { api, session, sessionInfo, reportStartedToRunner } = await bootstrapSession({
        flavor: agentFlavor,
        startedBy,
        workingDirectory,
        agentState: initialState,
        model: initialModel ?? undefined,
        effort: initialEffort ?? undefined
    });
    logger.debug(`Session created: ${sessionInfo.id}`);
    applyHapiSessionEnvironment(sessionInfo.id);

    // Start HAPI MCP server
    const happyServer = await startHappyServer(session);
    logger.debug(`[START] HAPI MCP server started at ${happyServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    const currentSessionRef: { current: Session | null } = { current: null };

    const formatFailureReason = (message: string): string => {
        const maxLength = 200;
        if (message.length <= maxLength) {
            return message;
        }
        return `${message.slice(0, maxLength)}...`;
    };

    // Start Hook server for receiving Claude session notifications
    const hookServer = await startHookServer({
        onSessionHook: async (sessionId, data) => {
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            const currentSession = currentSessionRef.current;
            if (currentSession) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    await currentSession.onSessionFound(sessionId);
                }
            }
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    const hookSettingsPath = generateHookSettingsFile(hookServer.port, hookServer.token, {
        filenamePrefix: 'session-hook',
        logLabel: 'generateHookSettings'
    });
    logger.debug(`[START] Generated hook settings file: ${hookSettingsPath}`);

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
        }
    });

    lifecycle.registerProcessHandlers();
    await reportStartedToRunner();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    // Set initial agent state
    const startingMode = options.startingMode ?? (startedBy === 'runner' ? 'remote' : 'local');
    setControlledByUser(session, startingMode);

    // Import MessageQueue2 and create message queue
    const messageQueue = new MessageQueue2<EnhancedMode>(mode => hashObject({
        isPlan: mode.permissionMode === 'plan',
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
    session.onUserMessage((message) => {
        const sessionPermissionMode = currentSessionRef.current?.getPermissionMode();
        if (sessionPermissionMode && isPermissionModeAllowedForFlavor(sessionPermissionMode, agentFlavor)) {
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

        // Format message text with attachments for Claude
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);

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
            messageQueue.pushIsolateAndClear(commandText, enhancedMode);
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
            messageQueue.pushIsolateAndClear(commandText, enhancedMode);
            logger.debugLargeJson('[start] /clear command pushed to queue:', message);
            return;
        }

        if (specialCommand.type === 'goal') {
            logger.debug('[start] Detected /goal command');
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
            const commandText = (specialCommand.originalMessage || message.content.text).trim();
            messageQueue.pushIsolateAndClear(commandText, enhancedMode);
            logger.debugLargeJson('[start] /goal command pushed to queue:', message);
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
        messageQueue.push(formattedText, enhancedMode);
        logger.debugLargeJson('User message pushed to queue:', message)
    });

    const resolvePermissionMode = (value: unknown): PermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, agentFlavor)) {
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

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown; effort?: unknown };
        let nextPermissionMode = currentPermissionMode;
        let nextModel = currentModel;
        let nextEffort = currentEffort;

        if (config.permissionMode !== undefined) {
            nextPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.model !== undefined) {
            nextModel = resolveModel(config.model);
        }

        if (config.effort !== undefined) {
            nextEffort = resolveEffort(config.effort);
        }

        if (
            agentFlavor === 'cc-api'
            && config.model !== undefined
            && nextModel !== null
            && !isKnownCcApiModel(nextModel)
        ) {
            throw new Error(`Unknown CC-api model: ${nextModel}`);
        }

        const preservesPersistedResumeEffort = persistedResumeEffortPassThrough
            && nextModel === currentModel
            && nextEffort === currentEffort;
        if (agentFlavor === 'claude-deepseek') {
            if (!isClaudeDeepSeekModelPreset(nextModel)) {
                throw new Error('Unknown CC-deepseek model');
            }
            if (!isClaudeDeepSeekEffortAllowedForModel(nextModel, nextEffort)) {
                if (config.effort !== undefined) {
                    throw new Error('Effort selection is not supported for the current CC-deepseek model');
                }
                nextEffort = null;
            }
        }
        if (
            agentFlavor === 'cc-api'
            && !isCcApiEffortAllowedForModel(nextModel, nextEffort)
            && !preservesPersistedResumeEffort
        ) {
            if (config.effort !== undefined) {
                throw new Error('Effort selection is not supported for the current CC-api model');
            }
            nextEffort = null;
        }

        currentPermissionMode = nextPermissionMode;
        currentModel = nextModel;
        currentEffort = nextEffort;
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
            allowedTools: happyServer.toolNames.map(toolName => `mcp__hapi__${toolName}`),
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (sessionInstance) => {
                currentSessionRef.current = sessionInstance;
                syncSessionModes();
                let metadataStarted = false;
                sessionInstance.addSessionFoundCallback(() => {
                    if (metadataStarted) return;
                    metadataStarted = true;
                    extractSDKMetadataAsync(async (sdkMetadata) => {
                        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
                        try {
                            session.updateMetadata((currentMetadata) => ({
                                ...currentMetadata,
                                tools: sdkMetadata.tools,
                                slashCommands: sdkMetadata.slashCommands
                            }));
                        } catch (error) {
                            logger.debug('[start] Failed to update session metadata:', error);
                        }
                    });
                });
            },
            mcpServers: {
                'hapi': {
                    type: 'http' as const,
                    url: happyServer.url,
                }
            },
            session,
            claudeEnvVars: options.claudeEnvVars,
            claudeArgs,
            startedBy,
            hookSettingsPath
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
    }

    if (loopFailed) {
        await lifecycle.cleanup();
        throw loopError;
    }

    await lifecycle.cleanupAndExit();
}
