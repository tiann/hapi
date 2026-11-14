import { logger } from '@/ui/logger';
import { loop } from '@/claude/loop';
import { AgentState, SessionEffort, SessionModel } from '@/api/types';
import { claudeBatchModeHash, EnhancedMode, PermissionMode } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
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
import { execFileSync } from 'node:child_process';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { getDefaultClaudeCodePath } from './sdk/utils';
import { claudeConversationHistoryCapabilities, nativeRewindApplied, planPendingRewindRestart, readNativeTurns, resolveForkAtMessagePlan, resolveRewindPlan, resumeSessionIdFromClaudeArgs, type ClaudeRewindIntent } from './conversationHistory';
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

    // Start HAPI MCP server (pass session cwd so spawn_peer "." anchors here)
    const happyServer = await startHappyServer(session, { workingDirectory });
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
                    // A 'clear' rotation is the local twin of the remote
                    // onSessionReset: the TUI discarded the conversation, so a
                    // pending rewind pointing into it can never be proven and
                    // would be re-armed onto the fresh, empty session at the
                    // next reconcile. Non-clear rotations (startup attach,
                    // genuine resume - including the rewind re-arm's own
                    // respawn) must keep the intent. The cancellation commits
                    // BEFORE the rotated id: if the process dies between the
                    // two metadata writes, the hub must not hold
                    // {claudeSessionId: <cleared session>, claudeRewind:
                    // intent}, which reconcile would re-arm.
                    if (data.source === 'clear') {
                        currentSession.onConversationReset?.();
                        // The rotation discards the resume anchor with the
                        // conversation (the remote twin consumes in
                        // onSessionReset): without this, the next local spawn
                        // would resume the cleared session through the stale
                        // --resume flag on claudeArgs.
                        currentSession.consumeOneTimeFlags();
                    }
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
                    // A local turn re-parents onto the kept boundary exactly
                    // like a remote one: it is the proof that a pending
                    // rewind's native branch applied. The remote launcher's
                    // onInputSubmitted never fires in local mode (only its
                    // settings file forwards UserPromptSubmit), so settle the
                    // durable intent and consume the boundary flags from here.
                    handleNativeInputSubmitted();
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

    // Rewind and fork-at-message need native resume-time truncation
    // (Claude Code v2.1.223+); fork-current works on any version. Detect the
    // actual binary version once at startup so the web UI only shows the
    // affordances when they can work; a failed probe conservatively keeps
    // fork-current only.
    let claudeVersionOutput: string | null = null;
    try {
        claudeVersionOutput = execFileSync(getDefaultClaudeCodePath(), ['--version'], {
            encoding: 'utf8',
            timeout: 10_000,
            stdio: ['pipe', 'pipe', 'pipe']
        }).trim();
    } catch (error) {
        logger.debug(`[claude] --version probe failed: ${error instanceof Error ? error.message : String(error)}`);
    }
    const conversationHistory = claudeConversationHistoryCapabilities(claudeVersionOutput);
    session.updateMetadata((metadata) => ({
        ...metadata,
        path: metadata?.path ?? workingDirectory,
        host: metadata?.host ?? 'unknown',
        capabilities: {
            ...metadata?.capabilities,
            ...(conversationHistory ? { conversationHistory } : {})
        }
    }))

    // Crash consistency for rewinds (two systems: native branch, hub
    // truncation): the session-metadata intent is the durable key. On start,
    // dropped turns still on the native chain mean the branch never applied:
    // re-arm the boundary flags for this launch and keep the intent. Dropped
    // turns gone mean the branch applied: clear the intent - the hub
    // truncated at rewind-RPC success, or at RPC failure with the committed
    // intent visible, so no hub re-request exists or is needed.
    let rearmPendingIntent: ClaudeRewindIntent | null = null;
    const reconcilePendingRewind = () => {
        const intent = session.getMetadata()?.claudeRewind
        const nativeSessionId = session.getMetadata()?.claudeSessionId
            ?? sessionInfo.metadata?.claudeSessionId
            ?? null
        if (!intent || !nativeSessionId) return
        const turns = readNativeTurns(workingDirectory, nativeSessionId)
        const plan = planPendingRewindRestart(intent, turns)
        if (plan.action === 'rearm' && turns.length > 0) {
            // Durable re-arm: the hub truncated at rewind-RPC success, but the
            // native branch never applied. The boundary is derived from the
            // durable intent at spawn time and stays until the dropped turns
            // leave the native chain.
            logger.debug(`[claude] rewind ${intent.truncateFromLocalId}: native branch pending; re-arming boundary ${intent.keepBoundary} on launch`)
            rearmPendingIntent = intent;
        } else {
            logger.debug(`[claude] rewind ${intent.truncateFromLocalId}: native branch applied; clearing intent`)
            session.updateMetadata((metadata) => {
                const { claudeRewind: _cleared, ...rest } = metadata;
                return rest;
            });
            // Pure housekeeping, but the deletion must reach the hub: a stale
            // intent stranded there would issue a bogus native rewind on the
            // next start.
            void session.flushMetadata();
        }
    };
    reconcilePendingRewind();

    let pendingRewind: ClaudeRewindIntent | null = null;

    // The rewind's native branch materializes when the respawned process
    // writes its first real input re-parented onto the kept boundary. The
    // submitted prompt's uuid is that input; once the dropped turns leave the
    // active chain, commit the hub side through the keyed metadata intent.
    // The uuid itself is unused - the transcript poll is the evidence - so
    // the local UserPromptSubmit hook can trigger the same proof without one.
    const handleNativeInputSubmitted = (nativePromptUuid?: string) => {
        const intent = pendingRewind;
        if (!intent) return;
        const nativeSessionId = currentSessionRef.current?.sessionId
            ?? session.getMetadata()?.claudeSessionId
            ?? null;
        if (!nativeSessionId) return;
        const deadline = Date.now() + 5_000;
        const poll = () => {
            if (pendingRewind !== intent) return;
            if (nativeRewindApplied(workingDirectory, nativeSessionId, intent.droppedPrompts)) {
                pendingRewind = null;
                // The boundary flag needs no cleanup here: spawns derive it
                // from the durable intent (deriveSpawnArgs), which this
                // metadata deletion removes.
                session.updateMetadata((metadata) => {
                    const { claudeRewind: _cleared, ...rest } = metadata;
                    return rest;
                });
                void session.flushMetadata();
                logger.debug(`[claude] rewind ${intent.truncateFromLocalId}: native branch proven; intent cleared`);
                return;
            }
            if (Date.now() < deadline) {
                setTimeout(poll, 200);
            } else {
                logger.debug(`[claude] rewind ${intent.truncateFromLocalId}: no branch proof for the submitted input; intent stays armed`);
            }
        };
        poll();
    };

    // /clear wipes the conversation a pending rewind points into: an intent
    // whose evidence can never materialize would keep fork/rewind blocked
    // until the wrapper restarts. Cancel the durable key together with the
    // live pending state when the launcher reports the reset - the next
    // spawn's boundary derivation then sees no intent. The boundary flag
    // itself is never stored on claudeArgs, so there is nothing to strip.
    const cancelPendingRewind = () => {
        // Clear even without a live pending rewind: an intent can sit in
        // metadata without one (e.g. left inside a rejected rewind's flush
        // window), and a reset must not leave it blocking history actions
        // until a restart.
        if (!pendingRewind && !session.getMetadata()?.claudeRewind) return;
        pendingRewind = null;
        session.updateMetadata((metadata) => {
            const { claudeRewind: _cleared, ...rest } = metadata;
            return rest;
        });
        void session.flushMetadata();
        logger.debug('[claude] rewind: cancelled by session reset');
    };

    session.rpcHandlerManager.registerHandler(RPC_METHODS.ForkConversation, async (payload: unknown) => {
        const messageLocalId = payload && typeof payload === 'object' && typeof (payload as { messageLocalId?: unknown }).messageLocalId === 'string'
            ? (payload as { messageLocalId: string }).messageLocalId
            : undefined
        const liveSession = currentSessionRef.current;
        const liveNativeId = liveSession?.sessionId ?? null;
        const resumeArgId = liveSession ? resumeSessionIdFromClaudeArgs(liveSession.claudeArgs) : null;
        const nativeSessionId = liveNativeId
            ?? resumeArgId
            ?? session.getMetadata()?.claudeSessionId
            ?? sessionInfo.metadata?.claudeSessionId
            ?? null
        if (!nativeSessionId) {
            throw new Error('Claude session id is not ready')
        }
        // Mirror RewindConversation's live-session guard: a live session with
        // neither a bound id nor a resume anchor - right after /clear consumed
        // both - has no native conversation to fork; falling back to the stale
        // metadata id would fork the discarded pre-/clear conversation.
        if (liveSession && !liveNativeId && !resumeArgId) {
            throw new Error('No active native session to fork; send a message to start a new conversation first')
        }
        if (!messageLocalId) {
            return { nativeSessionId, forkSession: true as const }
        }
        // Fork at a message: the child resumes the source truncated to the turn
        // before the selected one, so its history ends at the chosen point.
        if (session.getMetadata()?.capabilities?.conversationHistory?.forkAtMessage !== true) {
            throw new Error('Historical fork is not supported for Claude')
        }
        const promptUuid = session.getMetadata()?.conversationHistoryEntryIds?.[messageLocalId]
        if (!promptUuid) {
            throw new Error(`No native history point for message ${messageLocalId}`)
        }
        const plan = resolveForkAtMessagePlan(readNativeTurns(workingDirectory, nativeSessionId), promptUuid)
        logger.debug(`[claude] fork at message ${messageLocalId}: boundary ${plan.resumeSessionAt}`)
        return {
            nativeSessionId,
            forkSession: true as const,
            ...(plan.resumeSessionAt ? { resumeSessionAt: plan.resumeSessionAt } : {})
        }
    })
    session.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async (payload: unknown) => {
        const rejected = (error: string) => ({ success: false as const, outcome: 'rejected' as const, error })
        const messageLocalId = payload && typeof payload === 'object' && typeof (payload as { messageLocalId?: unknown }).messageLocalId === 'string'
            ? (payload as { messageLocalId: string }).messageLocalId
            : undefined
        if (!messageLocalId) {
            return pendingRewind ? rejected('Pending rewind retry has invalid correlation') : rejected('messageLocalId is required')
        }
        if (session.getMetadata()?.capabilities?.conversationHistory?.rewindToMessage !== true) {
            return rejected('Rewind is not supported for Claude')
        }
        if (pendingRewind) {
            return rejected('A rewind is already pending; send a message to settle it first')
        }
        // Resolve the native session the way the respawn will actually resume
        // it: the live session's id, else the --resume anchor claudeRemote
        // parses from claudeArgs (startFrom), else the hub metadata. A live
        // session with neither a session id nor a resume anchor - right after
        // /clear consumed both, before any new prompt - has no native
        // conversation to rewind into: falling back to the stale metadata id
        // would persist a fresh intent and truncate the hub while the respawn
        // throws 'Pending resume-at request has no native session to resume'
        // on every attempt, looping forever.
        const liveSession = currentSessionRef.current;
        const liveNativeId = liveSession?.sessionId ?? null;
        const resumeArgId = liveSession ? resumeSessionIdFromClaudeArgs(liveSession.claudeArgs) : null;
        const nativeSessionId = liveNativeId
            ?? resumeArgId
            ?? session.getMetadata()?.claudeSessionId
            ?? sessionInfo.metadata?.claudeSessionId
            ?? null
        if (!nativeSessionId) {
            return rejected('Claude session id is not ready')
        }
        if (liveSession && !liveNativeId && !resumeArgId) {
            return rejected('No active native session to rewind; send a message to start a new conversation first')
        }
        const promptUuid = session.getMetadata()?.conversationHistoryEntryIds?.[messageLocalId]
        if (!promptUuid) {
            return rejected(`No native history point for message ${messageLocalId}`)
        }
        const turns = readNativeTurns(workingDirectory, nativeSessionId)
        let keepBoundary: string
        let droppedPrompts: string[]
        try {
            const plan = resolveRewindPlan(turns, promptUuid)
            keepBoundary = plan.resumeSessionAt!
            const index = turns.findIndex((turn) => turn.promptUuid === promptUuid)
            droppedPrompts = turns.slice(index).map((turn) => turn.promptUuid)
        } catch (error) {
            return rejected(error instanceof Error ? error.message : String(error))
        }
        const intent: ClaudeRewindIntent = {
            targetLocalId: messageLocalId,
            truncateFromLocalId: messageLocalId,
            keepBoundary,
            droppedPrompts
        }
        // Bail before any persistence: a session that cannot restart would
        // otherwise persist the intent and roll it back in metadata only.
        const claudeSession = currentSessionRef.current;
        if (!claudeSession?.requestRemoteRestart) {
            return rejected('Claude session is not ready for a rewind restart')
        }
        // Persist the durable key BEFORE respawning: a crash after the native
        // branch applies is recovered by the next start's reconciliation. The
        // queued write's handler is re-invoked on every backoff retry, so it
        // is gated on keepIntent: after a flush failure the still-retrying
        // write must converge to metadata WITHOUT the intent (the hub never
        // truncated for a rejected rewind).
        let keepIntent = true;
        session.updateMetadata((metadata) => (keepIntent ? { ...metadata, claudeRewind: intent } : metadata));
        // The persist wait must outlive transient socket congestion: a 5s
        // drain timeout rejects the rewind while the intent write may still
        // land moments later, and the hub's lost-RPC fallback then sees the
        // very intent this rejection rolls back - hub truncated, native not.
        // The hub RPC allows 120s; waiting here keeps the common congestion
        // case on the committed path (and any residual ambiguity is resolved
        // by the hub's fail-closed diverged marker, not by a silent split).
        if (!await session.flushMetadata(60_000)) {
            // Cover the window where the stuck write acked just before the
            // flip, and drop the intent from the local snapshot. Queued
            // fire-and-forget: the rejection must not wait another drain
            // timeout behind the retrying write.
            keepIntent = false;
            session.updateMetadata((metadata) => {
                const { claudeRewind: _cleared, ...rest } = metadata;
                return rest;
            });
            return rejected('Rewind intent could not be persisted')
        }
        // The proof handler must be live for THIS respawn too: the previous
        // rewind in this wrapper lifetime already consumed one proof, and
        // settle must never detach the notification the next one depends on.
        claudeSession.onNativeInputSubmitted = handleNativeInputSubmitted
        pendingRewind = intent
        logger.debug(`[claude] rewind ${messageLocalId}: boundary ${keepBoundary}, ${droppedPrompts.length} dropped turn(s); restarting Claude`)
        await claudeSession.requestRemoteRestart()
        return { success: true, truncateFromLocalId: messageLocalId }
    })

    // Set initial agent state
    const startingMode = options.startingMode ?? (startedBy === 'runner' ? 'remote' : 'local');
    setControlledByUser(session, startingMode);

    // Batches split on any mode change that needs a new Claude process, and
    // on effort so each batch runs at its own effort. claudeBatchModeHash is
    // shared with the launcher's resume-at spawn gate so spawned-config and
    // batch hashes compare directly.
    const messageQueue = new MessageQueue2<EnhancedMode>(claudeBatchModeHash);

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
                if (rearmPendingIntent && !pendingRewind) {
                    // Proof wiring only: the boundary flag is derived at
                    // spawn time from the durable intent (deriveSpawnArgs),
                    // so there is nothing to arm on claudeArgs.
                    pendingRewind = rearmPendingIntent;
                    rearmPendingIntent = null;
                }
                sessionInstance.onNativeInputSubmitted = handleNativeInputSubmitted;
                sessionInstance.onConversationReset = cancelPendingRewind;
                // Turn-completion proof re-check (Minor: the post-submit poll
                // gives up after 5s; a transcript write landing later left the
                // intent armed until another turn or a restart). The launcher
                // reads session.onThinkingChange per spawn, so wrapping it here
                // reaches every respawn: a completed turn (thinking false)
                // re-runs the proof, which early-returns when no intent is
                // pending.
                const baseOnThinkingChange = sessionInstance.onThinkingChange.bind(sessionInstance);
                sessionInstance.onThinkingChange = (thinking: boolean) => {
                    baseOnThinkingChange(thinking);
                    if (!thinking) handleNativeInputSubmitted();
                };
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
