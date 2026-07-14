import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import type { SessionMode } from '@/agent/loopBase';
import { AgentState, SessionEffort, SessionModel } from '@/api/types';
import { EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { extractSDKMetadataAsync } from '@/claude/sdk/metadataExtractor';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { getEnvironmentInfo } from '@/ui/doctor';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { startHookServer } from '@/claude/utils/startHookServer';
import { PtyPermissionHandler } from '@/claude/utils/ptyPermissionHandler';
import { generateHookSettingsFile, cleanupHookSettingsFile } from '@/modules/common/hooks/generateHookSettings';
import { registerKillSessionHandler } from './registerKillSessionHandler';
import type { Session } from './session';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { normalizeClaudeSessionModel } from './model';
import { normalizeClaudeSessionEffort } from './effort';
import { computeBackSyncedPermissionMode } from './utils/backSyncPermissionMode';
import { getInvokedCwd } from '@/utils/invokedCwd';

export interface StartOptions {
    model?: string
    effort?: string
    permissionMode?: PermissionMode
    // Control mode (who drives the session). pty is NOT a value here — it's the
    // separate `interactive` launch axis below.
    startingMode?: 'local' | 'remote'
    // Launch the agent as an interactive PTY terminal. Mapped to the runtime
    // SessionMode 'pty' at the loop boundary; persistence/web still see 'pty'.
    interactive?: boolean
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
    // Launch axis: when set, claude runs in an interactive PTY (runtime mode
    // 'pty'); otherwise the control axis (local/remote) applies.
    const interactive = options.interactive ?? false;

    // Log environment info at startup
    logger.debugLargeJson('[START] HAPI process started', getEnvironmentInfo());
    logger.debug(`[START] Options: startedBy=${startedBy}, startingMode=${options.startingMode}, interactive=${interactive}`);

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
            tag: interactive ? `__hapi_pty__claude-${randomUUID()}` : undefined,
            agentState: initialState,
            model: initialModel ?? undefined,
            effort: initialEffort ?? undefined
        });
    const { api, session, sessionInfo } = bootstrap;
    logger.debug(`Session created: ${sessionInfo.id}`);

    // Extract SDK metadata in background and update session when ready
    extractSDKMetadataAsync(async (sdkMetadata) => {
        logger.debug('[start] SDK metadata extracted, updating session:', sdkMetadata);
        try {
            // Update session metadata with tools and slash commands
            session.updateMetadata((currentMetadata) => ({
                ...currentMetadata,
                tools: sdkMetadata.tools,
                slashCommands: sdkMetadata.slashCommands
            }));
            logger.debug('[start] Session metadata updated with SDK capabilities');
        } catch (error) {
            logger.debug('[start] Failed to update session metadata:', error);
        }
    });

    // Start HAPI MCP server
    const happyServer = await startHappyServer(session);
    logger.debug(`[START] HAPI MCP server started at ${happyServer.url}`);

    // Variable to track current session instance (updated via onSessionReady callback)
    const currentSessionRef: { current: Session | null } = { current: null };

    // PTY mode has no SDK canUseTool callback, so tool approvals are bridged from
    // a PreToolUse hook to the web via this handler (assigned below once the
    // permission-mode state exists). Null in SDK/local/remote modes.
    const isPtyMode = interactive;
    let ptyPermissionHandler: PtyPermissionHandler | null = null;

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
        },
        // PTY-mode tool-approval bridge. Resolves once the user answers in the
        // web modal (may take minutes). Allows by default if the handler isn't
        // up yet (should not happen in PTY mode).
        onPreToolUse: async (data) => {
            if (!ptyPermissionHandler) {
                return { permissionDecision: 'allow' };
            }
            // Reverse-sync: if the user changed claude's mode in the terminal
            // (Shift+Tab cycles auto → acceptEdits → plan), claude reports it in
            // the hook payload. Adopt it so the Chat UI / handler stay consistent.
            // yolo (bypassPermissions) is hapi-only and is never overwritten here.
            const syncedMode = computeBackSyncedPermissionMode(currentPermissionMode, data.permission_mode);
            if (syncedMode) {
                logger.debug(`[pty] adopting claude TUI permission mode: ${currentPermissionMode} → ${syncedMode}`);
                currentPermissionMode = syncedMode;
                // Bookkeeping only — claude is already running in syncedMode, so
                // do NOT notify the launcher (would trigger a pointless respawn
                // re-entering the very change this is reporting on).
                syncSessionModes({ notifyPermissionModeChange: false });
            }
            const toolUseId = data.tool_use_id || `${data.tool_name ?? 'tool'}-${data.session_id ?? ''}`;
            return ptyPermissionHandler.requestDecision(toolUseId, data.tool_name ?? '', data.tool_input);
        }
    });
    logger.debug(`[START] Hook server started on port ${hookServer.port}`);

    const hookSettingsPath = generateHookSettingsFile(hookServer.port, hookServer.token, {
        filenamePrefix: 'session-hook',
        logLabel: 'generateHookSettings',
        // PTY sessions rely on the PreToolUse hook for approvals; the SDK path
        // must NOT register it (it uses canUseTool instead).
        includePreToolUse: isPtyMode
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
        // Tear down the PTY before process.exit. For PTY mode
        // the launcher registers a kill handler that aborts the controller →
        // runAgentPty's manager.kill() runs synchronously. No-op in local/remote
        // mode where no handler is registered.
        onBeforeClose: () => { currentSessionRef.current?.kill(); },
        onAfterClose: () => {
            ptyPermissionHandler?.cancelAll('Session ended');
            happyServer.stop();
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath, 'generateHookSettings');
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    // Set initial agent state. Collapse the launch axis into the runtime
    // SessionMode here: interactive → 'pty'; otherwise the control axis. From
    // this point on the runtime/persistence layers keep using 'pty' (the agent
    // terminal toggle and resume both key on the persisted startingMode).
    const startingMode: SessionMode = interactive
        ? 'pty'
        : (options.startingMode ?? (startedBy === 'runner' ? 'remote' : 'local'));
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

    // notifyPermissionModeChange controls whether a real permissionMode change
    // notifies the PTY launcher's configChangeHandler (which respawns claude
    // with the new --permission-mode). Every caller wants the default (true —
    // this is an intentional HAPI-driven change) EXCEPT the back-sync path
    // (claude self-reporting its own live mode via the PreToolUse hook): that
    // mode is already what claude is running, so notifying would re-enter the
    // respawn path for a change claude already made on its own. See
    // Session.setPermissionMode for the corresponding { notify } contract.
    const syncSessionModes = (opts?: { notifyPermissionModeChange?: boolean }) => {
        const sessionInstance = currentSessionRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode, { notify: opts?.notifyPermissionModeChange ?? true });
        sessionInstance.setModel(currentModel);
        sessionInstance.setEffort(currentEffort);
        logger.debug(`[loop] Synced session config for keepalive: permissionMode=${currentPermissionMode}, model=${currentModel ?? 'auto'}, effort=${currentEffort ?? 'auto'}`);
    };

    // Bring up the PTY tool-approval bridge now that the permission-mode state
    // exists. It reads the live mode (web dropdown can change it mid-session) and
    // routes any "approve & switch mode" choice back into that same state.
    if (isPtyMode) {
        ptyPermissionHandler = new PtyPermissionHandler(session, {
            getPermissionMode: () => currentPermissionMode,
            onModeChange: (mode) => {
                if (!isPermissionModeAllowedForFlavor(mode, 'claude')) {
                    return;
                }
                currentPermissionMode = mode as PermissionMode;
                currentSessionRef.current?.setPermissionMode(mode as PermissionMode);
                syncSessionModes();
            }
        });
    }
    session.onUserMessage((message, localId) => {
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

        // If in local mode with a live stdin pipe, forward the message
        // directly to the running Claude process instead of pushing to
        // the queue (which would trigger doSwitch and kill the process).
        const sessionInstance = currentSessionRef.current;
        if (sessionInstance?.writeStdin && sessionInstance.mode === 'local') {
            logger.debug('[start] forwarding message to local process stdin');
            sessionInstance.stdinMessageTexts.add(formattedText);
            sessionInstance.writeStdin(formattedText + '\n');
            if (localId) {
                session.emitMessagesConsumed([localId]);
            }
            logger.debugLargeJson('User message forwarded to local stdin:', message)
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
    });

    session.onCancelQueuedMessage((localId) => {
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
            allowedTools: happyServer.toolNames.map(toolName => `mcp__hapi__${toolName}`),
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (sessionInstance) => {
                currentSessionRef.current = sessionInstance;
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
