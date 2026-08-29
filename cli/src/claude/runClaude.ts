import { logger } from '@/ui/logger';
import { execFileSync } from 'node:child_process';
import { getDefaultClaudeCodePath } from './sdk/utils';
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
import { readNativeTurns, resolveRewindPlan, supportsNativeRewind } from './conversationHistory';
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

    // Rewind needs native --resume-session-at (Claude Code v2.1.223+); fork
    // current works on any version. Detect the actual binary version once at
    // startup so the web UI only shows the Rewind affordance when it can work.
    let claudeVersionOutput: string | null = null
    try {
        claudeVersionOutput = execFileSync(getDefaultClaudeCodePath(), ['--version'], {
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim()
    } catch (error) {
        logger.debug(`[claude] --version probe failed: ${error instanceof Error ? error.message : String(error)}`)
    }
    const conversationHistory = toConversationHistoryCapabilities({
        ...CLAUDE_CONVERSATION_HISTORY,
        rewindToMessage: supportsNativeRewind(claudeVersionOutput) ? 'supported' : 'unsupported'
    })
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
    // Rewind bookkeeping. Each completed user-turn batch (one batch = one
    // joined native prompt) is mapped to its native prompt uuid when the turn
    // completes; the map is mirrored into session metadata
    // (`conversationHistoryEntryIds`) so it survives CLI restarts, and the hub
    // scrubs truncated entries automatically via `conversationHistoryPoints`.
    const promptUuidByLocalId = new Map<string, string>()
    const localIdsByPromptUuid = new Map<string, string[]>()
    const REWIND_ACK_TIMEOUT_MS = 60_000
    const stripRewindFlags = (args: string[] | undefined): string[] | undefined => {
        if (!args) return undefined
        const filtered: string[] = []
        for (let i = 0; i < args.length; i++) {
            if ((args[i] === '--resume-session-at' || args[i] === '--resume-drops-turn') && i + 1 < args.length) {
                i++
                continue
            }
            filtered.push(args[i]!)
        }
        return filtered.length > 0 ? filtered : undefined
    }
    session.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async (payload: unknown) => {
        const rejected = (error: string) => ({ success: false as const, outcome: 'rejected' as const, error })
        if (!payload || typeof payload !== 'object' || typeof (payload as { messageLocalId?: unknown }).messageLocalId !== 'string') {
            return rejected('messageLocalId is required')
        }
        const messageLocalId = (payload as { messageLocalId: string }).messageLocalId
        // Known pre-mutation rejections must use success:false — throwing would make
        // the hub treat the outcome as unknown and diverge the session history.
        const claudeSession = currentSessionRef.current
        if (!claudeSession?.requestRemoteRestart) {
            return rejected('Rewind requires a running remote Claude session')
        }
        if (claudeSession.queue.size() > 0) {
            return rejected('Session is busy')
        }
        const nativeSessionId = claudeSession.sessionId
        if (!nativeSessionId) {
            // No metadata fallback: a stale id would truncate an unrelated native session.
            return rejected('Claude session id is not ready')
        }

        // Map the requested message to its native prompt uuid. In-memory first;
        // metadata covers turns completed before a CLI restart.
        const promptUuid = promptUuidByLocalId.get(messageLocalId)
            ?? session.getMetadata()?.conversationHistoryEntryIds?.[messageLocalId]
            ?? sessionInfo.metadata?.conversationHistoryEntryIds?.[messageLocalId]
            ?? null
        if (!promptUuid) {
            return rejected(`No native history point for message ${messageLocalId}`)
        }
        const turns = readNativeTurns(workingDirectory, nativeSessionId)
        let plan
        try {
            plan = resolveRewindPlan(turns, promptUuid)
        } catch (error) {
            return rejected(error instanceof Error ? error.message : String(error))
        }
        // A joined batch is dropped as one native turn: the truncation boundary
        // for the hub must be the batch's FIRST local id, never a later one.
        const batchLocalIds = localIdsByPromptUuid.get(promptUuid)
        const truncateFromLocalId = batchLocalIds?.[0] ?? messageLocalId

        // One-shot flags consumed by the respawned process; Session.consumeOneTimeFlags
        // strips them after onSessionFound so they never leak into later launches.
        const flags = ['--resume', nativeSessionId]
        if (plan.resumeSessionAt) flags.push('--resume-session-at', plan.resumeSessionAt)
        for (const dropTurn of plan.dropsTurns) flags.push('--resume-drops-turn', dropTurn)
        claudeSession.claudeArgs = [...(claudeSession.claudeArgs ?? []), ...flags]

        // The respawn starts Claude immediately with the resume flags. Claude
        // emits no init until the first prompt, but a rejected resume exits
        // within moments of spawn — so the launcher confirms application once
        // the new attempt survives a short stability window, and reports
        // failure immediately on a deterministic resume rejection. Until then
        // the hub must not truncate its transcript.
        let confirmed = false
        // Arm the ack BEFORE requesting the restart: the launcher respawns
        // synchronously during the abort and needs the armed callback then.
        const ackPromise = new Promise<{ applied: boolean; error?: string }>((resolve) => {
            claudeSession.rewindAck = (applied, error) => resolve({ applied, error })
        })
        try {
            await claudeSession.requestRemoteRestart()
            const result = await Promise.race([
                ackPromise,
                new Promise<{ applied: boolean; error?: string }>((resolve) => {
                    setTimeout(() => resolve({ applied: false, error: 'unconfirmed' }), REWIND_ACK_TIMEOUT_MS)
                })
            ])
            if (!result.applied) {
                // Disarm and strip any unconsumed flags so state stays "not rewound".
                claudeSession.rewindAck = null
                claudeSession.claudeArgs = stripRewindFlags(claudeSession.claudeArgs)
                if (result.error === 'unconfirmed') {
                    // Cannot prove either way — native may or may not have been
                    // truncated. Throw outside the rejection conversion below so
                    // the hub marks history diverged instead of allowing more
                    // history actions against an unknown state.
                    throw new Error('Rewind could not be confirmed; session history requires reconciliation')
                }
                return rejected(result.error ?? 'Rewind could not be applied')
            }
            confirmed = true
        } finally {
            claudeSession.rewindAck = null
            if (!confirmed) {
                claudeSession.claudeArgs = stripRewindFlags(claudeSession.claudeArgs)
            }
        }
        // Truncation confirmed: forget the dropped turns' mappings (the hub scrubs
        // the persisted copies together with its truncated rows).
        const dropIndex = turns.findIndex((turn) => turn.promptUuid === promptUuid)
        for (const [localId, uuid] of [...promptUuidByLocalId]) {
            const keptIndex = turns.findIndex((turn) => turn.promptUuid === uuid)
            if (keptIndex < 0 || keptIndex >= dropIndex) {
                promptUuidByLocalId.delete(localId)
            }
        }
        return { success: true as const, truncateFromLocalId }
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
            session.discardPendingHubPromptEcho(localId);
            return true;
        }
        const removed = messageQueue.cancelByLocalId(localId);
        if (removed) {
            session.discardPendingHubPromptEcho(localId);
        }
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
                sessionInstance.onUserTurnCompleted = (localIds) => {
                    if (localIds.length === 0 || !sessionInstance.sessionId) return
                    // The just-completed turn is the tail of the active chain.
                    const turn = readNativeTurns(workingDirectory, sessionInstance.sessionId).at(-1)
                    if (!turn) return
                    // A joined batch is dropped natively as one turn: only its
                    // FIRST local id is a rewind point. Advertising later ones
                    // would let the hub truncate mid-batch while Claude drops
                    // the whole batch, and the boundary must survive restarts.
                    const boundaryLocalId = localIds[0]!
                    promptUuidByLocalId.set(boundaryLocalId, turn.promptUuid)
                    localIdsByPromptUuid.set(turn.promptUuid, [boundaryLocalId])
                    // Web renders the Rewind affordance from this per-message flag
                    // (same contract as codex/pi/grok); the hub scrubs truncated
                    // points and entry ids together with its message rows.
                    sessionInstance.client.updateMetadata((metadata) => ({
                        ...metadata,
                        conversationHistoryPoints: {
                            ...metadata?.conversationHistoryPoints,
                            [boundaryLocalId]: true as const
                        },
                        conversationHistoryEntryIds: {
                            ...metadata?.conversationHistoryEntryIds,
                            [boundaryLocalId]: turn.promptUuid
                        }
                    }))
                };
                sessionInstance.onNativeSessionReset = () => {
                    // /clear drops the native session; turn tracking is no longer valid.
                    promptUuidByLocalId.clear()
                    localIdsByPromptUuid.clear()
                    sessionInstance.client.updateMetadata((metadata) => ({
                        ...metadata,
                        conversationHistoryPoints: {},
                        conversationHistoryEntryIds: {}
                    }))
                };
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
