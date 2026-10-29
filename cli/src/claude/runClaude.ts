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
import { forwardClaudeAutoCompactionStart } from './utils/autoCompactionHook';
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
import { hasDurableRewindBranch, hashRewindInput, readNativeTurns, readTranscriptUuids, resolveRewindPlan, supportsNativeRewind } from './conversationHistory';
import { listSkills, type SkillSummary } from '@/modules/common/skills';
import { configuration } from '@/configuration';
import { RewindIntentStore, type RewindIntent } from './rewindIntent';

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
    /**
     * Fresh-spawn reserved hub id from `--hapi-session-id` (create/getOrCreate).
     * Distinct from `existingSessionId` / `--existing-session-id` (reopen).
     */
    reservedSessionId?: string
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
            effort: initialEffort ?? undefined,
            reservedSessionId: options.reservedSessionId
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
        onPermissionRequest: (data, signal) => currentSessionRef.current?.localPermissionBridge.request(data, signal) ?? Promise.resolve(null),
        onSessionHook: (sessionId, data) => {
            if (data.agent_id !== undefined) return;
            logger.debug(`[START] Session hook received: ${sessionId}`, data);

            const currentSession = currentSessionRef.current;
            forwardClaudeAutoCompactionStart(currentSession, sessionId, data);
            currentSession?.localPermissionBridge.onHook(data);
            if (currentSession && (data.hook_event_name === 'SessionStart' || data.hook_event_name === undefined)) {
                const previousSessionId = currentSession.sessionId;
                if (previousSessionId !== sessionId) {
                    logger.debug(`[START] Claude session ID changed: ${previousSessionId} -> ${sessionId}`);
                    currentSession.onSessionFound(sessionId);
                }
            }

            // Follow /model switches inside the TUI ("[1m]" kept) for the local
            // context window; only the local settings file registers this hook.
            if (currentSession && data.hook_event_name === 'PostModelSwitch' && typeof data.to_model === 'string') {
                currentSession.localContextModel = data.to_model;
            }

            // Local mode has no SDK stream; derive thinking from turn hooks.
            // PreToolUse also covers a turn HAPI attached to mid-flight.
            if (currentSession?.mode === 'local' && sessionId === currentSession.sessionId) {
                const event = data.hook_event_name;
                if (event === 'UserPromptSubmit') {
                    currentSession.localTurnStartedAt = Date.now();
                }
                const thinking = event === 'UserPromptSubmit' || event === 'PreToolUse' ? true
                    : event === 'Stop' || event === 'StopFailure' || event === 'SessionEnd' ? false
                    : currentSession.thinking;
                if (thinking !== currentSession.thinking) {
                    currentSession.onThinkingChange(thinking);
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
                && sessionId === currentSession.sessionId
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
    // remote SDK process keeps only the session/compaction observers: these extra hooks
    // block Claude per prompt/tool call, and remote mode state is owned by the
    // hub/RPC path.
    const localHookSettingsPath = generateHookSettingsFile(hookServer.port, hookServer.token, {
        filenamePrefix: 'session-hook-local',
        logLabel: 'generateHookSettings',
        trackPermissionMode: true,
        includeLocalPermissions: true
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
            currentSessionRef.current?.localPermissionBridge.stop();
            hookServer.stop();
            cleanupHookSettingsFile(hookSettingsPath, 'generateHookSettings');
            cleanupHookSettingsFile(localHookSettingsPath, 'generateHookSettings');
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle, session);
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
    const rewindStore = new RewindIntentStore(configuration.happyHomeDir, configuration.apiUrl, sessionInfo.id)
    let pendingRewind = rewindStore.read()
    if (pendingRewind && pendingRewind.workingDirectory !== workingDirectory) {
        throw new Error('Pending rewind working directory mismatch')
    }
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
    const branchIsDurable = (intent: RewindIntent) => Boolean(intent.stagedInput) && hasDurableRewindBranch(
        workingDirectory, intent.nativeSessionId, intent.keepBoundary,
        new Set(intent.baselineUuids), intent.droppedPrompts, intent.stagedInput?.textHash
    )
    const reportRewind = async (intent: RewindIntent, phase: 'applied' | 'rejected' | 'unknown') => {
        session.updateMetadata(metadata => ({
            ...metadata,
            claudeRewind: {
                operationId: intent.operationId, phase,
                requestedLocalId: intent.requestedLocalId, cutoffSeq: intent.cutoffSeq,
                nativeSessionId: intent.nativeSessionId, keepBoundary: intent.keepBoundary,
                truncateFromLocalId: intent.dropFromLocalId
            }
        }))
        if (!await session.flushMetadata()) throw new Error('Rewind metadata acknowledgment unavailable')
        const acknowledgment = session.getMetadata()?.claudeRewind
        const expectedPhase = phase === 'applied' ? 'committed' : phase
        if (acknowledgment?.operationId !== intent.operationId || acknowledgment.phase !== expectedPhase) {
            throw new Error('Rewind hub commit acknowledgment mismatch')
        }
    }
    let rewindCommit: Promise<void> | null = null
    const commitPendingRewind = async () => {
        if (rewindCommit) return rewindCommit
        if (!pendingRewind) return
        const intent = pendingRewind
        if (!branchIsDurable(intent)) throw new Error('Native rewind branch is not durable')
        rewindCommit = (async () => {
            pendingRewind = { ...intent, phase: 'applied' }
            rewindStore.write(pendingRewind)
            await reportRewind(pendingRewind, 'applied')
            // The hub transaction deleted only the reserved old suffix. Its
            // committed ACK is required before retiring the recovery journal.
            rewindStore.write(null)
            pendingRewind = null
            const current = currentSessionRef.current
            if (current) {
                current.rewindProof = null
                current.claudeArgs = stripRewindFlags(current.claudeArgs)
            }
            for (const [localId, uuid] of promptUuidByLocalId) {
                if (intent.droppedPrompts.includes(uuid)) promptUuidByLocalId.delete(localId)
            }
        })()
        try { await rewindCommit } finally { rewindCommit = null }
    }
    session.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async (payload: unknown) => {
        const rejected = (error: string) => ({ success: false as const, outcome: 'rejected' as const, error })
        if (pendingRewind) return rejected('A rewind branch is pending durable reconciliation')
        if (!payload || typeof payload !== 'object' || typeof (payload as { messageLocalId?: unknown }).messageLocalId !== 'string') {
            return rejected('messageLocalId is required')
        }
        const messageLocalId = (payload as { messageLocalId: string }).messageLocalId
        const { operationId, cutoffSeq } = payload as { operationId?: unknown; cutoffSeq?: unknown }
        if (typeof operationId !== 'string' || !operationId || !Number.isInteger(cutoffSeq) || (cutoffSeq as number) < 0) {
            return rejected('A durable hub rewind operation is required')
        }
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

        // Keep the resume boundary armed until a real native input selects
        // the branch and the hub commits the corresponding suffix deletion.
        const flags = ['--resume', nativeSessionId]
        if (plan.resumeSessionAt) flags.push('--resume-session-at', plan.resumeSessionAt)
        const transcriptUuidBaseline = readTranscriptUuids(workingDirectory, nativeSessionId)
        const intent: RewindIntent = {
            operationId, requestedLocalId: messageLocalId, cutoffSeq: cutoffSeq as number, phase: 'pending',
            hubSessionId: sessionInfo.id, nativeSessionId, workingDirectory,
            keepBoundary: plan.resumeSessionAt!, dropFromLocalId: truncateFromLocalId,
            droppedPrompts: turns.slice(turns.findIndex(t => t.promptUuid === promptUuid)).map(t => t.promptUuid),
            baselineUuids: [...transcriptUuidBaseline]
        }
        // Persist before mutating arguments or aborting the running attempt.
        rewindStore.write(intent)
        pendingRewind = intent
        claudeSession.claudeArgs = [...(claudeSession.claudeArgs ?? []), ...flags]

        claudeSession.rewindProof = boundary => boundary === intent.keepBoundary
            && claudeSession.sessionId === nativeSessionId
            && Boolean(pendingRewind && branchIsDurable(pendingRewind))
        await claudeSession.requestRemoteRestart()
        // Durable intent is pending, not applied. The hub retains its old
        // suffix until a real input selects the native branch and its applied
        // report is transactionally committed and ACKed by the hub.
        return { success: false as const, outcome: 'pending' as const,
            operationId, nativeSessionId, keepBoundary: intent.keepBoundary, truncateFromLocalId }
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

        // The remote launcher reverts the session mode when Claude refuses one.
        const sessionPermissionMode = currentSessionRef.current?.getPermissionMode();
        if (sessionPermissionMode && isPermissionModeAllowedForFlavor(sessionPermissionMode, 'claude')) {
            currentPermissionMode = sessionPermissionMode as PermissionMode;
        }

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
    let recoveredUnstagedNativeId: string | undefined;
    try {
        const recoveryMetadata = session.getMetadata() ?? sessionInfo.metadata
        const abandoned = recoveryMetadata?.claudeRewind
        if (!pendingRewind && abandoned && ['requested', 'unknown'].includes(abandoned.phase)
            && !abandoned.nativeSessionId) {
            // Reservation may survive a crash before RPC receipt/journal write.
            // Only reject it as unchanged when the current native tail is still
            // one of the hub's completed, persisted prompts. A new/unmapped tail
            // is indeterminate and must not be launched on the old branch.
            const nativeSessionId = recoveryMetadata?.claudeSessionId
            const turns = nativeSessionId ? readNativeTurns(workingDirectory, nativeSessionId) : []
            const knownPrompts = new Set(Object.values(recoveryMetadata?.conversationHistoryEntryIds ?? {}))
            const promptUuid = recoveryMetadata?.conversationHistoryEntryIds?.[abandoned.requestedLocalId]
            if (!nativeSessionId || !promptUuid || !turns.at(-1) || !knownPrompts.has(turns.at(-1)!.promptUuid)) {
                throw new Error('Unstaged rewind reservation cannot be reconciled with the native tail')
            }
            const plan = resolveRewindPlan(turns, promptUuid)
            await reportRewind({
                operationId: abandoned.operationId, requestedLocalId: abandoned.requestedLocalId,
                cutoffSeq: abandoned.cutoffSeq, phase: 'pending', hubSessionId: sessionInfo.id,
                nativeSessionId, workingDirectory, keepBoundary: plan.resumeSessionAt!,
                dropFromLocalId: abandoned.requestedLocalId, droppedPrompts: [], baselineUuids: []
            }, 'rejected')
            recoveredUnstagedNativeId = nativeSessionId
            session.sendSessionEvent({ type: 'message', message: 'Rewind was interrupted before durable staging; the original conversation is unchanged. Retry the rewind request.' })
        }
        await loop({
            path: workingDirectory,
            model: currentModel,
            effort: currentEffort,
            permissionMode: options.permissionMode,
            startingMode: pendingRewind ? 'remote' : startingMode,
            messageQueue,
            api,
            allowedTools: toClaudeAllowedHapiMcpTools(happyServer.toolNames),
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (sessionInstance) => {
                currentSessionRef.current = sessionInstance;
                if (pendingRewind) {
                    if (sessionInstance.sessionId && sessionInstance.sessionId !== pendingRewind.nativeSessionId) {
                        throw new Error('Pending rewind native session mismatch')
                    }
                    sessionInstance.sessionId = pendingRewind.nativeSessionId
                    sessionInstance.claudeArgs = [
                        ...(stripRewindFlags(sessionInstance.claudeArgs) ?? []),
                        '--resume-session-at', pendingRewind.keepBoundary
                    ]
                    const recovered = pendingRewind
                    sessionInstance.rewindProof = boundary => boundary === recovered.keepBoundary
                        && sessionInstance.sessionId === recovered.nativeSessionId
                        && Boolean(pendingRewind && pendingRewind.operationId === recovered.operationId && branchIsDurable(pendingRewind))
                }
                sessionInstance.onRewindBranchApplied = commitPendingRewind
                sessionInstance.stageRewindInput = (localIds, text) => {
                    if (!pendingRewind) return
                    pendingRewind = { ...pendingRewind, stagedInput: { localIds: [...localIds], textHash: hashRewindInput(text) } }
                    rewindStore.write(pendingRewind)
                }
                sessionInstance.isRewindInputAccepted = (localIds, text) => Boolean(pendingRewind
                    && JSON.stringify(pendingRewind.stagedInput?.localIds) === JSON.stringify(localIds)
                    && pendingRewind.stagedInput?.textHash === hashRewindInput(text)
                    && branchIsDurable(pendingRewind))
                sessionInstance.prepareHistoryAttempt = async () => {
                    if (!pendingRewind) return
                    if (sessionInstance.sessionId !== pendingRewind.nativeSessionId) {
                        throw new Error('Pending rewind native session mismatch')
                    }
                    if (pendingRewind.phase === 'applied' || branchIsDurable(pendingRewind)) {
                        await commitPendingRewind()
                    }
                }
                sessionInstance.onRewindFailure = async (error, unchanged) => {
                    if (!pendingRewind) return
                    const intent = pendingRewind
                    const safelyUnchanged = unchanged && !branchIsDurable(intent)
                    await reportRewind(intent, safelyUnchanged ? 'rejected' : 'unknown')
                    if (safelyUnchanged) {
                        rewindStore.write(null)
                        pendingRewind = null
                        sessionInstance.rewindProof = null
                        sessionInstance.claudeArgs = stripRewindFlags(sessionInstance.claudeArgs)
                    }
                    sessionInstance.client.sendSessionEvent({ type: 'message', message: `Rewind could not complete: ${error}` })
                }
                resolveSessionReady(sessionInstance);
                sessionInstance.onUserTurnCompleted = async (localIds) => {
                    if (localIds.length === 0 || !sessionInstance.sessionId) return
                    if (pendingRewind) {
                        if (sessionInstance.sessionId !== pendingRewind.nativeSessionId || !branchIsDurable(pendingRewind)) {
                            throw new Error('Pending rewind branch has not been proven durable')
                        }
                        await commitPendingRewind()
                    }
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
                if (!pendingRewind) sessionInstance.rewindProof = null;
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
            resumeSessionId: pendingRewind?.nativeSessionId ?? recoveredUnstagedNativeId ?? options.resumeSessionId,
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
