import React from 'react';
import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import type { CursorSession } from './session';
import type { PermissionMode } from './loop';
import {
    createCursorAcpBackend,
    CURSOR_ACP_REQUIRED_MESSAGE,
    resolveCursorNativeWorktreePath
} from './utils/cursorAcpBackend';
import { setCursorAcpModelsSnapshot } from './utils/cursorAcpModelsBridge';
import { buildCursorModelsSnapshotFromAcp } from './utils/cursorAcpModelsSnapshot';
import { CursorExtensionAdapter } from './utils/cursorExtensionAdapter';
import {
    applyCursorAcpMode,
    applyCursorAcpModel,
    isCursorAutoReviewMode,
    resolveCursorModeAfterPlanApproval,
    wireIdForCursorSessionState
} from './utils/cursorModeConfig';
import { CURSOR_PLAN_CONTINUE } from './utils/cursorPlanContinue';
import { cursorPassThroughStatusMessage, parseCursorSpecialCommand } from './cursorSpecialCommands';
import { buildCursorModelsSeedPayload, seedCursorModelsCache } from '@/modules/common/cursorModels';
import { readSharedCursorModelsCache } from '@/modules/common/cursorModelsSharedCache';
import type { AcpSdkBackend } from '@/agent/backends/acp';
import type { AcpStderrError } from '@/agent/backends/acp/AcpStdioTransport';
import { isAcpIndeterminateError } from '@/agent/backends/acp/AcpStdioTransport';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import {
    cursorHapiMcpServerId,
    installCursorMcpOverlay,
    type CursorMcpOverlayHandle,
} from './utils/cursorMcpOverlay';
import {
    resolveCursorSpawnModel,
    tryRemapCursorSpawnModelFromConnectError
} from './utils/cursorStaleModelRemap';
import {
    CURSOR_AUTO_RETRY_LIMIT,
    isRetryableCursorError,
    stripRetryableCursorError
} from './cursorAutoRetry';

const CURSOR_ABORT_DRAIN_TIMEOUT_MS = 5_000;

class CursorAcpRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CursorSession;
    private backend: ReturnType<typeof createCursorAcpBackend> | null = null;
    private acpSessionId: string | null = null;
    private permissionAdapter: PermissionAdapter | null = null;
    private extensionAdapter: CursorExtensionAdapter | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    private displayPermissionMode: PermissionMode | null = null;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private unregisterModelApplyHandler: (() => void) | null = null;
    private modelApplySeq = 0;
    private activePromptModeHash: string | null = null;
    /** True while a backend.prompt turn is in flight. */
    private promptInFlight = false;
    /** Concurrent soft-steer session/prompt RPCs still running after kickoff. */
    private softSteerWaiters: Promise<void>[] = [];
    /** True when ACP process was spawned with `--auto-review`. */
    private spawnedWithAutoReview = false;
    /** Avoid re-queueing `/auto-review` on every mid-session mode sync. */
    private autoReviewSlashQueued = false;
    private cursorMcpOverlay: CursorMcpOverlayHandle | null = null;
    private pendingRetryableError: string | null = null;
    private pendingRetryableFromStderr = false;
    private pendingInlineRetryableError = false;
    private attemptProducedToolActivity = false;
    private userAbortRequested = false;

    constructor(session: CursorSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(OpencodeDisplay, context);
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        session.client.updateAgentState?.((state) => ({ ...state, steeringActive: false }));

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'cursor' }
        });
        this.happyServer = happyServer;

        const hapiBridge = mcpServers.hapi;
        if (hapiBridge) {
            try {
                this.cursorMcpOverlay = installCursorMcpOverlay(session.path, {
                    command: hapiBridge.command,
                    args: hapiBridge.args,
                }, {
                    serverId: cursorHapiMcpServerId(session.client.sessionId),
                });
            } catch (error) {
                logger.warn(
                    '[cursor-acp] failed to install HAPI MCP overlay; continuing without inline media',
                    error,
                );
                this.cursorMcpOverlay = { cleanup: () => {} };
            }
        }

        const autoReview = isCursorAutoReviewMode(session.getPermissionMode() as PermissionMode);
        this.spawnedWithAutoReview = autoReview;

        // Desired hub/UI model (may be a bracket wire). Spawn may use a remap for
        // `agent --model`, but applyLiveModel must reapply this original so variants
        // like composer-2.5[fast=true] are not silently coerced to fast=false (#1430).
        const desiredModel = session.model;
        const requestedSpawnModel = desiredModel;
        let spawnModel = resolveCursorSpawnModel(requestedSpawnModel);
        let backend: AcpSdkBackend | null = null;
        let recentStderrHint: string | null = null;

        for (let connectAttempt = 0; connectAttempt < 2; connectAttempt += 1) {
            if (spawnModel && spawnModel !== desiredModel) {
                // Status only — do not session.setModel(spawnModel) or keepalive will
                // overwrite the desired variant before ACP apply.
                this.messageBuffer.addMessage(`[MODEL:${spawnModel}]`, 'system');
            }

            backend = createCursorAcpBackend({
                cwd: session.path,
                model: spawnModel,
                autoReview,
                worktree: session.cursorWorktree,
                addDirs: session.cursorAddDirs
            });
            this.backend = backend;
            registerAcpSessionTitleSync(backend, session.client);
            this.recordCursorNativeWorktreeMetadata();

            backend.setUsageUpdateListener((message) => this.handleAgentMessage(message));
            // Harness resume (notify_on_output / mid-idle ACP activity) may not
            // go through HAPI's prompt() window — bump thinking so the hub list
            // matches reality (#1470).
            this.wireAgentActivityThinking(backend, session);

            recentStderrHint = null;
            this.wireStderrErrorListener(backend, (hint) => {
                recentStderrHint = hint;
            });

            try {
                await backend.initialize();
                break;
            } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                const remapped = tryRemapCursorSpawnModelFromConnectError(
                    spawnModel,
                    requestedSpawnModel,
                    errMsg,
                    recentStderrHint
                );
                await backend.disconnect();
                this.backend = null;

                if (remapped && connectAttempt === 0) {
                    logger.info(`[cursor-acp] Remapping stale spawn model ${spawnModel} → ${remapped}`);
                    spawnModel = remapped;
                    continue;
                }

                const modelRejection = extractCannotUseThisModelMessage(errMsg)
                    ?? extractCannotUseThisModelMessage(recentStderrHint);
                if (modelRejection) {
                    const fullMsg = classifyCursorAcpLoadError(error, {
                        recentStderr: recentStderrHint,
                        action: 'start'
                    });
                    const converted = convertAgentMessage({ type: 'error', message: fullMsg });
                    if (converted) {
                        session.sendAgentMessage(converted);
                    }
                    messageBuffer.addMessage(fullMsg, 'status');
                    throw new Error(fullMsg);
                }
                const fullMsg = `${CURSOR_ACP_REQUIRED_MESSAGE} (${errMsg})`;
                const converted = convertAgentMessage({ type: 'error', message: fullMsg });
                if (converted) {
                    session.sendAgentMessage(converted);
                }
                messageBuffer.addMessage(fullMsg, 'status');
                throw new Error(fullMsg);
            }
        }

        if (!backend) {
            throw new Error(CURSOR_ACP_REQUIRED_MESSAGE);
        }

        await backend.authenticateIfAvailable('cursor_login');

        const extensionAdapter = new CursorExtensionAdapter(
            session.client,
            backend,
            (message) => this.handleAgentMessage(message),
            () => this.handleCreatePlanAccepted()
        );
        this.extensionAdapter = extensionAdapter;

        this.permissionAdapter = new PermissionAdapter(
            session.client,
            backend,
            () => session.getPermissionMode(),
            (response) => this.handlePermissionResponse(extensionAdapter, response)
        );

        const resumeSessionId = session.sessionId;
        // Cursor ACP ignores session/new|load mcpServers; native ~/.cursor/mcp.json is wired above.
        const mcpServerList: McpServerStdio[] = [];
        let acpSessionId: string | undefined;

        for (let loadAttempt = 0; loadAttempt < 2; loadAttempt += 1) {
            if (resumeSessionId && backend.supportsLoadSession()) {
                session.onSessionFoundWithProtocol(resumeSessionId, 'acp');
                try {
                    acpSessionId = await backend.loadSession({
                        sessionId: resumeSessionId,
                        cwd: session.path,
                        mcpServers: mcpServerList
                    });
                    break;
                } catch (error) {
                    const errMsg = error instanceof Error ? error.message : String(error);
                    const remapped = tryRemapCursorSpawnModelFromConnectError(
                        spawnModel,
                        requestedSpawnModel,
                        errMsg,
                        recentStderrHint
                    );
                    if (remapped && loadAttempt === 0) {
                        logger.info(`[cursor-acp] Remapping stale resume model ${spawnModel} → ${remapped}`);
                        spawnModel = remapped;
                        // Keep session.model as desiredModel; only the process --model remaps.
                        this.messageBuffer.addMessage(`[MODEL:${remapped}]`, 'system');
                        await backend.disconnect();
                        backend = createCursorAcpBackend({
                            cwd: session.path,
                            model: spawnModel,
                            autoReview,
                            worktree: session.cursorWorktree,
                            addDirs: session.cursorAddDirs
                        });
                        this.backend = backend;
                        registerAcpSessionTitleSync(backend, session.client);
                        backend.setUsageUpdateListener((message) => this.handleAgentMessage(message));
                        this.wireAgentActivityThinking(backend, session);
                        recentStderrHint = null;
                        this.wireStderrErrorListener(backend, (hint) => {
                            recentStderrHint = hint;
                        });
                        await backend.initialize();
                        await backend.authenticateIfAvailable('cursor_login');
                        this.extensionAdapter = new CursorExtensionAdapter(
                            session.client,
                            backend,
                            (message) => this.handleAgentMessage(message),
                            () => this.handleCreatePlanAccepted()
                        );
                        this.permissionAdapter = new PermissionAdapter(
                            session.client,
                            backend,
                            () => session.getPermissionMode(),
                            (response) => this.handlePermissionResponse(this.extensionAdapter!, response)
                        );
                        continue;
                    }

                    logger.warn('[cursor-acp] session/load failed', formatAcpLoadError(error));
                    throw new Error(classifyCursorAcpLoadError(error, { recentStderr: recentStderrHint }));
                }
            } else if (resumeSessionId) {
                throw new Error(
                    'Cursor ACP session/load is not supported by this agent build. Start a new Cursor session.'
                );
            } else {
                try {
                    acpSessionId = await backend.newSession({
                        cwd: session.path,
                        mcpServers: mcpServerList,
                    });
                    break;
                } catch (error) {
                    // Cursor often accepts initialize then rejects at session/new when
                    // --model is a stale bracket wire and the shared cache was empty.
                    const errMsg = error instanceof Error ? error.message : String(error);
                    const remapped = tryRemapCursorSpawnModelFromConnectError(
                        spawnModel,
                        requestedSpawnModel,
                        errMsg,
                        recentStderrHint
                    );
                    if (remapped && loadAttempt === 0) {
                        logger.info(`[cursor-acp] Remapping stale spawn model ${spawnModel} → ${remapped}`);
                        spawnModel = remapped;
                        this.messageBuffer.addMessage(`[MODEL:${remapped}]`, 'system');
                        await backend.disconnect();
                        backend = createCursorAcpBackend({
                            cwd: session.path,
                            model: spawnModel,
                            autoReview,
                            worktree: session.cursorWorktree,
                            addDirs: session.cursorAddDirs
                        });
                        this.backend = backend;
                        registerAcpSessionTitleSync(backend, session.client);
                        backend.setUsageUpdateListener((message) => this.handleAgentMessage(message));
                        this.wireAgentActivityThinking(backend, session);
                        recentStderrHint = null;
                        this.wireStderrErrorListener(backend, (hint) => {
                            recentStderrHint = hint;
                        });
                        await backend.initialize();
                        await backend.authenticateIfAvailable('cursor_login');
                        this.extensionAdapter = new CursorExtensionAdapter(
                            session.client,
                            backend,
                            (message) => this.handleAgentMessage(message),
                            () => this.handleCreatePlanAccepted()
                        );
                        this.permissionAdapter = new PermissionAdapter(
                            session.client,
                            backend,
                            () => session.getPermissionMode(),
                            (response) => this.handlePermissionResponse(this.extensionAdapter!, response)
                        );
                        continue;
                    }

                    logger.warn('[cursor-acp] session/new failed', formatAcpLoadError(error));
                    throw new Error(classifyCursorAcpLoadError(error, {
                        recentStderr: recentStderrHint,
                        action: 'start'
                    }));
                }
            }
        }
        if (!acpSessionId) {
            throw new Error('Failed to establish Cursor ACP session');
        }
        this.acpSessionId = acpSessionId;

        if (acpSessionId !== resumeSessionId) {
            session.onSessionFoundWithProtocol(acpSessionId, 'acp');
            // tiann/hapi#913: block until the metadata write that pins
            // `cursorSessionId` reaches the hub DB before we drop into
            // `runMainLoop`. If SIGTERM (hub-restart cascade) lands during
            // the first turn without this gate, the only durable handle
            // linking the session to its on-disk ACP store is lost and the
            // session strands. The resume path at lines 98-100 already
            // relies on the latency of `backend.loadSession()` to flush the
            // same write; the fresh-session path has no such cover.
            const flushed = await session.client.flushMetadata();
            if (!flushed) {
                logger.warn(`[cursor-acp] cursorSessionId metadata write did not ACK within 5s; session may be unrecoverable if killed before the lock drains (acpSessionId=${acpSessionId})`);
            }
        }

        session.client.emitSessionReady();

        syncCursorModelsFromAcp(backend, acpSessionId);

        const initialMetadata = backend.getSessionModelsMetadata(acpSessionId);
        this.currentBackendModel = initialMetadata?.currentModelId ?? session.model ?? null;
        this.defaultBackendModel = this.currentBackendModel;

        const previousSetModel = session.setModel.bind(session);

        await applyCursorAcpMode(backend, acpSessionId, session.getPermissionMode() as PermissionMode);
        const modelToApply = desiredModel ?? session.model;
        if (modelToApply) {
            // If we remapped --model for spawn, restoring the original variant is
            // mandatory — continuing on whatever ACP defaulted to silently changes
            // capabilities/cost (#1430).
            const mustRestoreDesiredModel = Boolean(
                desiredModel
                && spawnModel
                && spawnModel !== desiredModel
            );
            await this.applyLiveModel(backend, acpSessionId, modelToApply, previousSetModel, {
                optimistic: false,
                throwOnFailure: mustRestoreDesiredModel
            });
        } else if (this.currentBackendModel && !isSpawnDefaultModel(this.currentBackendModel)) {
            this.pushModelStatusLine(this.currentBackendModel);
        }

        this.installLiveSessionConfigSync(backend, acpSessionId, previousSetModel);

        this.applyDisplayMode(session.getPermissionMode() as PermissionMode);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        // Soft steer = Cursor GUI "Send" (next-opportune / soft inject): fire a
        // concurrent session/prompt without canceling the in-flight turn. Abort
        // remains the hard stop path (GUI "Stop & send").
        session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.SteerQueuedMessage,
            async (payload: unknown) => {
                const localId = typeof (payload as { localId?: unknown } | null)?.localId === 'string'
                    ? (payload as { localId: string }).localId
                    : '';
                if (!localId) {
                    return { steered: false, error: 'Missing localId' };
                }
                const backend = this.backend;
                const acpSessionId = this.acpSessionId;
                if (!this.promptInFlight || !acpSessionId || !backend) {
                    return { steered: false, error: 'No active steerable turn' };
                }
                const targetPromptGeneration = backend.getPromptGeneration();
                const taken = session.queue.takeByLocalId(localId);
                if (!taken) {
                    return { steered: false, error: 'Message not in queue' };
                }
                const isControlCommand = Boolean(taken.item.isolate)
                    || parseCursorSpecialCommand(taken.item.message).type !== null;
                if (isControlCommand) {
                    session.queue.restoreReservation(taken);
                    return { steered: false, error: 'Control commands cannot be steered' };
                }
                if (this.activePromptModeHash !== taken.item.modeHash) {
                    session.queue.restoreReservation(taken);
                    return { steered: false, error: 'Queued message mode differs from the active turn' };
                }

                // Ack the hub once the soft-steer request is kicked off — not when
                // the concurrent session/prompt finishes. ACP treats that response as
                // turn completion, which can exceed the hub's 30s Socket.IO RPC timeout
                // and report a false failure after the inject already started.
                // Keep the launcher busy until that background prompt settles so we
                // do not emit ready / start the next backend.prompt() while it runs.
                if (!session.queue.beginReservationDispatch(taken)) {
                    return { steered: false, error: 'Steer cancelled' };
                }
                const dispatchStatePersisted = await session.client.setSteerDeliveryState([localId], 'dispatching');
                if (!dispatchStatePersisted) {
                    session.queue.markReservationIndeterminate(taken);
                    session.client.emitSteerIndeterminate([localId]);
                    return { steered: false, error: 'Steer state is indeterminate' };
                }
                const restoreQueuedReservation = async (): Promise<boolean> => {
                    if (!taken.originIndeterminate) {
                        const persisted = await session.client.setSteerDeliveryState([localId], 'queued');
                        if (!persisted) {
                            session.queue.markReservationIndeterminate(taken);
                            session.client.emitSteerIndeterminate([localId]);
                            return false;
                        }
                    }
                    if (taken.state !== 'dispatching' || !session.queue.restoreReservation(taken)) {
                        session.client.emitSteerIndeterminate([localId]);
                        return false;
                    }
                    return true;
                };
                if (taken.state !== 'dispatching') {
                    session.client.emitSteerIndeterminate([localId]);
                    return { steered: false, error: 'Steer cancelled' };
                }
                if (!this.promptInFlight
                    || this.backend !== backend
                    || this.acpSessionId !== acpSessionId
                    || backend.getPromptGeneration() !== targetPromptGeneration) {
                    await restoreQueuedReservation();
                    return { steered: false, error: 'Active turn changed' };
                }
                let steer: { dispatched: Promise<void>; completed: Promise<void> };
                try {
                    steer = backend.beginSoftSteerPrompt(acpSessionId, [{
                        type: 'text',
                        text: taken.item.message
                    }]);
                } catch (error) {
                    if (isAcpIndeterminateError(error)) {
                        if (session.queue.markReservationIndeterminate(taken)) {
                            session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[cursor-acp] soft-steer dispatch outcome unknown', error);
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    logger.debug('[cursor-acp] soft-steer failed to start', error);
                    await restoreQueuedReservation();
                    return { steered: false, error: 'Failed to soft-steer into active turn' };
                }
                // Completion still gates the next prompt (handler swap safety);
                // register the waiter before awaiting dispatch so the main loop's
                // finally cannot slip a prompt in between.
                const steerDone = Promise.all([steer.dispatched, steer.completed]).then(() => {}, (error) => {
                    logger.debug('[cursor-acp] soft-steer completion failed after dispatch', error);
                });
                this.softSteerWaiters.push(steerDone);
                const removeWaiter = () => {
                    this.softSteerWaiters = this.softSteerWaiters.filter((p) => p !== steerDone);
                };
                void steerDone.then(removeWaiter);
                try {
                    await steer.dispatched;
                } catch (error) {
                    if (isAcpIndeterminateError(error)) {
                        if (session.queue.markReservationIndeterminate(taken)) {
                            session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[cursor-acp] soft-steer dispatch outcome unknown', error);
                        return { steered: false, error: 'Steer outcome is being reconciled' };
                    }
                    await restoreQueuedReservation();
                    logger.debug('[cursor-acp] soft-steer failed to start', error);
                    return { steered: false, error: 'Failed to soft-steer into active turn' };
                }
                // The RPC acks once stdin accepted the inject. The queue row is
                // committed only when the concurrent prompt settles: an explicit
                // JSON-RPC rejection means ACP never accepted the instruction
                // (restore it for the next prompt), while a transport failure
                // (abort/disconnect) keeps the row reserved — never re-delivered.
                void steer.completed.then(() => {
                    // Completion means ACP accepted the inject: the ACK must
                    // reach the hub even when an abort reset the queue and
                    // cancelled the reservation in between.
                    session.queue.commitReservation(taken);
                    messageBuffer.addMessage(taken.item.message, 'user');
                    session.client.emitMessagesConsumed([localId], { steered: true });
                }, (error) => {
                    if (isAcpIndeterminateError(error)) {
                        // Do not leave the reservation dispatching forever. Hold
                        // it outside automatic replay and persist the ambiguous
                        // outcome; a later explicit Steer retries this same row.
                        if (session.queue.markReservationIndeterminate(taken)) {
                            session.client.emitSteerIndeterminate([localId]);
                        }
                        logger.debug('[cursor-acp] soft-steer outcome unknown after dispatch; row held for explicit resolution', error);
                        return;
                    }
                    void restoreQueuedReservation().then((restored) => {
                        if (restored) {
                            logger.debug('[cursor-acp] soft-steer rejected by ACP; row restored', error);
                        }
                    });
                });
                return { steered: true };
            }
        );

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        try {
        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);

            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;

            const modelChanged = Boolean(
                requestedModel && requestedModel !== this.currentBackendModel
            );
            if (modelChanged) {
                const appliedModel = await this.applyLiveModel(
                    backend,
                    acpSessionId,
                    requestedModel,
                    previousSetModel,
                    { optimistic: false, throwOnFailure: false }
                );
                batch.mode.model = appliedModel ?? this.currentBackendModel ?? undefined;
            }

            await applyCursorAcpMode(backend, acpSessionId, batch.mode.permissionMode as PermissionMode);
            this.applyDisplayMode(batch.mode.permissionMode as PermissionMode);

            const specialCommand = parseCursorSpecialCommand(batch.message);
            if (specialCommand.type === 'pass-through') {
                messageBuffer.addMessage(cursorPassThroughStatusMessage(specialCommand.command), 'status');
            }
            messageBuffer.addMessage(batch.message, 'user');

            // skill_lookup discovery lives on the MCP tool description — do not
            // prepend instructions onto user turns (prompt-injection false positive).
            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            session.onThinkingChange(true);
            this.promptInFlight = true;
            session.client.updateAgentState?.((state) => ({ ...state, steeringActive: true }));
            this.activePromptModeHash = batch.hash;

            try {
                this.promptInFlight = true;
                this.userAbortRequested = false;
                for (let retryAttempt = 0; retryAttempt <= CURSOR_AUTO_RETRY_LIMIT; retryAttempt += 1) {
                    this.pendingRetryableError = null;
                    this.pendingRetryableFromStderr = false;
                    this.pendingInlineRetryableError = false;
                    this.attemptProducedToolActivity = false;
                    let turnCompleted = false;
                    try {
                        await backend.prompt(acpSessionId, promptContent, (message) => {
                            if (message.type === 'turn_complete') turnCompleted = true;
                            this.handleAgentMessage(message);
                        });
                        if (this.userAbortRequested) break;
                        if (turnCompleted && this.pendingRetryableFromStderr && !this.pendingInlineRetryableError) {
                            this.pendingRetryableError = null;
                        }
                        if (!this.pendingRetryableError) {
                            void backend.refreshSessionInfo(acpSessionId, session.path);
                            break;
                        }
                    } catch (error) {
                        logger.warn('[cursor-acp] prompt failed', error);
                        if (this.userAbortRequested) break;
                        if (!isRetryableCursorError(error)) {
                            this.surfacePromptFailure(error instanceof Error ? error.message : String(error));
                            break;
                        }
                        this.pendingRetryableError = error instanceof Error ? error.message : String(error);
                    }

                    if (this.attemptProducedToolActivity) {
                        this.surfacePromptFailure('Cursor connection interrupted after tool activity; the prompt was not retried.');
                        break;
                    }
                    if (retryAttempt < CURSOR_AUTO_RETRY_LIMIT) {
                        this.surfaceRetry(retryAttempt + 1);
                        continue;
                    }
                    this.surfacePromptFailure(`Cursor Agent failed after ${CURSOR_AUTO_RETRY_LIMIT} retries.`);
                }
            } finally {
                this.promptInFlight = false;
                session.client.updateAgentState?.((state) => ({ ...state, steeringActive: false }));
                // Soft-steers share the ACP session; wait for them before ready /
                // the next prompt so message handlers are not swapped mid-inject.
                // An Abort (which clears the waiters) must release this wait too:
                // race the settle against the abort signal so the launcher never
                // blocks on a soft steer whose completion is unbounded.
                if (this.softSteerWaiters.length > 0 && !this.shouldExit) {
                    const waitSignal = this.abortController.signal;
                    let releaseWait!: () => void;
                    const abortListener = () => releaseWait();
                    if (!waitSignal.aborted) {
                        waitSignal.addEventListener('abort', abortListener, { once: true });
                    }
                    try {
                        await Promise.race([
                            Promise.allSettled([...this.softSteerWaiters]),
                            new Promise<void>((resolve) => { releaseWait = resolve; })
                        ]);
                    } finally {
                        // Repeated waits must not accumulate abort listeners.
                        waitSignal.removeEventListener('abort', abortListener);
                    }
                    this.softSteerWaiters = [];
                }
                this.activePromptModeHash = null;
                this.pendingRetryableError = null;
                this.pendingRetryableFromStderr = false;
                this.pendingInlineRetryableError = false;
                this.attemptProducedToolActivity = false;
                session.onThinkingChange(false);
                await this.permissionAdapter?.cancelAll('Prompt finished');
                await this.extensionAdapter?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
        } finally {
            // No wait here: Exit/Switch must reach cleanup() promptly; it
            // disconnects the ACP transport, rejecting pending soft-steer
            // requests and settling any waiters.
        }
    }

    protected async cleanup(): Promise<void> {
        // Capture overlay before awaited teardown so a reject from
        // cancelAll/disconnect cannot leave a dead hapi-* entry in ~/.cursor/mcp.json.
        const overlay = this.cursorMcpOverlay;
        this.cursorMcpOverlay = null;

        try {
            this.clearAbortHandlers(this.session.client.rpcHandlerManager);
            this.session.client.rpcHandlerManager.registerHandler(RPC_METHODS.SteerQueuedMessage, async () => ({
                steered: false,
                error: 'Session ending'
            }));
            this.promptInFlight = false;
            this.session.client.updateAgentState?.((state) => ({ ...state, steeringActive: false }));
            this.softSteerWaiters = [];
            this.unregisterModelApplyHandler?.();
            this.unregisterModelApplyHandler = null;

            if (this.permissionAdapter) {
                await this.permissionAdapter.cancelAll('Session ended');
                this.permissionAdapter = null;
            }

            if (this.extensionAdapter) {
                await this.extensionAdapter.cancelAll('Session ended');
                this.extensionAdapter = null;
            }

            if (this.backend) {
                await this.backend.disconnect();
                this.backend = null;
            }

            if (this.happyServer) {
                this.happyServer.stop();
                this.happyServer = null;
            }
        } finally {
            overlay?.cleanup();
            setCursorAcpModelsSnapshot(null);
        }
    }

    private wireStderrErrorListener(
        backend: AcpSdkBackend,
        onHint: (hint: string | null) => void
    ): void {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        backend.onStderrError((error: AcpStderrError) => {
            logger.debug('[cursor-acp] stderr error', error);
            const hint = error.raw || error.message;
            onHint(hint);
            if (this.promptInFlight && isRetryableCursorError(hint)) {
                if (!this.userAbortRequested) {
                    this.pendingRetryableError = hint;
                    this.pendingRetryableFromStderr = true;
                }
                return;
            }
            if (error.type === 'model_not_found' && extractCannotUseThisModelMessage(hint)) {
                return;
            }
            const converted = convertAgentMessage({ type: 'error', message: error.message });
            if (converted) {
                session.sendAgentMessage(converted);
            }
            messageBuffer.addMessage(error.message, 'status');
        });
    }

    private handleCreatePlanAccepted(): void {
        const backend = this.backend;
        const acpSessionId = this.acpSessionId;
        if (!backend || !acpSessionId) {
            logger.warn('[cursor-acp] CreatePlan accepted but ACP session is not ready; skip continue handoff');
            return;
        }

        const session = this.session;
        const executeMode = resolveCursorModeAfterPlanApproval(
            session.getPermissionMode() as PermissionMode
        ) as PermissionMode;

        // Leave plan/ask for an executable mode, then queue a continue prompt so
        // Yes means "keep going on the user task" (Claude ExitPlanMode parallel).
        session.setPermissionMode(executeMode);
        void applyCursorAcpMode(backend, acpSessionId, executeMode).then(() => {
            this.applyDisplayMode(executeMode);
        });

        session.queue.unshiftIsolated(CURSOR_PLAN_CONTINUE, {
            permissionMode: executeMode,
            model: session.model
        });
        logger.debug('[cursor-acp] CreatePlan accepted — queued continue prompt', {
            executeMode
        });
    }

    private handlePermissionResponse(
        extensionAdapter: CursorExtensionAdapter,
        response: { id: string; approved: boolean; decision?: 'approved' | 'approved_for_session' | 'denied' | 'abort' }
    ): Promise<boolean> {
        if (response.decision === 'abort') this.userAbortRequested = true;
        return extensionAdapter.handlePermissionResponse(response);
    }

    /**
     * #1470 / #1502: ACP foreground state → hub thinking via keepalive.
     * Background tool/content updates are ignored; running is debounced in the backend.
     */
    private wireAgentActivityThinking(backend: AcpSdkBackend, session: CursorSession): void {
        backend.setAgentActivityListener((thinking) => {
            if (session.thinking !== thinking) {
                session.onThinkingChange(thinking);
            }
        });
    }

    private handleAgentMessage(message: AgentMessage): void {
        if (this.promptInFlight && (
            message.type === 'tool_call'
            || message.type === 'tool_result'
            || message.type === 'generated_image'
        )) {
            this.attemptProducedToolActivity = true;
        }
        if (message.type === 'text') {
            const visibleText = stripRetryableCursorError(message.text);
            if (visibleText !== null) {
                if (this.userAbortRequested) return;
                this.pendingRetryableError = message.text;
                this.pendingInlineRetryableError = true;
                if (!visibleText) return;
                message = { ...message, text: visibleText };
            }
        }
        const converted = convertAgentMessage(message, this.currentBackendModel);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                break;
            case 'usage':
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result', 'result');
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'generated_image':
                this.messageBuffer.addMessage(`Generated image: ${message.fileName}`, 'assistant');
                break;
            case 'turn_complete':
                break;
            default:
                break;
        }
    }

    private surfaceRetry(retryAttempt: number): void {
        this.session.client.sendClaudeSessionMessage({
            type: 'system',
            uuid: randomUUID(),
            subtype: 'api_error',
            retryAttempt,
            maxRetries: CURSOR_AUTO_RETRY_LIMIT + 1,
            error: { message: 'Cursor connection interrupted.' }
        });
    }

    private surfacePromptFailure(message: string): void {
        const converted = convertAgentMessage({ type: 'error', message });
        if (converted) this.session.sendAgentMessage(converted);
        this.messageBuffer.addMessage(message, 'status');
    }

    private installLiveSessionConfigSync(
        backend: AcpSdkBackend,
        acpSessionId: string,
        previousSetModel: CursorSession['setModel']
    ): void {
        const session = this.session;
        const previousSetPermissionMode = session.setPermissionMode.bind(session);
        session.setPermissionMode = (mode: PermissionMode) => {
            previousSetPermissionMode(mode);
            void applyCursorAcpMode(backend, acpSessionId, mode).then(() => {
                this.applyDisplayMode(mode);
            });
            this.maybeQueueAutoReviewSlash(mode);
        };

        this.unregisterModelApplyHandler = session.registerModelApplyHandler(async (model) => (
            await this.applyLiveModel(backend, acpSessionId, model, previousSetModel, {
                optimistic: false,
                throwOnFailure: true
            })
        ));

        session.setModel = (model: string | null | undefined) => {
            void this.applyLiveModel(backend, acpSessionId, model, previousSetModel, {
                optimistic: true,
                throwOnFailure: false
            }).catch((error) => {
                logger.warn('[cursor-acp] Failed to apply model from session sync', error);
            });
        };
    }

    private async applyLiveModel(
        backend: AcpSdkBackend,
        acpSessionId: string,
        model: string | null | undefined,
        previousSetModel: CursorSession['setModel'],
        options: { optimistic: boolean; throwOnFailure: boolean }
    ): Promise<string | null> {
        const requested = model?.trim();
        const previousModel = this.currentBackendModel ?? this.session.model ?? null;
        const applySeq = ++this.modelApplySeq;

        if (!requested || isSpawnDefaultModel(requested)) {
            const modelOption = backend.getConfigOptionByCategory?.(acpSessionId, 'model');
            const defaultWire = modelOption?.options?.find(
                (option) => isSpawnDefaultModel(option.value)
            )?.value;
            if (modelOption && defaultWire && backend.setConfigOption) {
                try {
                    await backend.setConfigOption(acpSessionId, modelOption.id, defaultWire);
                    backend.pinSessionModelWireId(acpSessionId, defaultWire);
                } catch (error) {
                    logger.debug('[cursor-acp] Failed to set default model via ACP', error);
                    if (options.throwOnFailure) {
                        throw new Error('Cursor default model is not available via ACP');
                    }
                }
            } else if (options.throwOnFailure) {
                throw new Error('Cursor default model is not available via ACP');
            }
            this.currentBackendModel = null;
            previousSetModel(undefined);
            this.session.pushKeepAlive();
            syncCursorModelsFromAcp(backend, acpSessionId);
            return null;
        }

        if (options.optimistic) {
            const optimisticWire = wireIdForCursorSessionState(requested, requested);
            this.currentBackendModel = optimisticWire;
            previousSetModel(optimisticWire);
            this.session.pushKeepAlive();
        }

        const result = await applyCursorAcpModel(backend, acpSessionId, requested);
        if (!result.applied || !result.resolvedWireId) {
            const message = `Cursor model is not available via ACP: ${requested}`;
            logger.warn(`[cursor-acp] ${message}`);

            if (options.optimistic && applySeq === this.modelApplySeq) {
                this.currentBackendModel = previousModel;
                previousSetModel(previousModel ?? undefined);
                this.session.pushKeepAlive();
            } else if (!options.throwOnFailure && previousModel && !isSpawnDefaultModel(previousModel)) {
                this.currentBackendModel = previousModel;
                previousSetModel(previousModel);
                this.session.pushKeepAlive();
            }
            syncCursorModelsFromAcp(backend, acpSessionId);

            if (options.throwOnFailure) {
                throw new Error(message);
            }
            return previousModel;
        }

        const sessionWire = wireIdForCursorSessionState(
            result.requestedWireId ?? requested,
            result.resolvedWireId
        );

        if (applySeq !== this.modelApplySeq) {
            return this.currentBackendModel;
        }

        const changed = sessionWire !== this.currentBackendModel || this.session.model !== sessionWire;
        this.currentBackendModel = sessionWire;
        previousSetModel(sessionWire);
        if (changed) {
            this.pushModelStatusLine(sessionWire);
        }
        this.session.pushKeepAlive();
        syncCursorModelsFromAcp(backend, acpSessionId);
        return sessionWire;
    }

    private pushModelStatusLine(model: string | null | undefined): void {
        const trimmed = model?.trim();
        if (!trimmed || isSpawnDefaultModel(trimmed)) {
            this.messageBuffer.addMessage('[MODEL:auto]', 'system');
            return;
        }
        this.messageBuffer.addMessage(`[MODEL:${trimmed}]`, 'system');
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
    }

    /**
     * Mid-session Auto-review: ACP has no config option, so when the process was
     * not spawned with `--auto-review`, queue an isolated `/auto-review` slash once.
     */
    private maybeQueueAutoReviewSlash(mode: PermissionMode): void {
        if (!isCursorAutoReviewMode(mode)) {
            return;
        }
        if (this.spawnedWithAutoReview || this.autoReviewSlashQueued) {
            return;
        }
        this.autoReviewSlashQueued = true;
        this.session.queue.pushIsolated(
            '/auto-review',
            {
                permissionMode: mode,
                model: this.session.model
            }
        );
        this.messageBuffer.addMessage(cursorPassThroughStatusMessage('auto-review'), 'status');
    }

    private recordCursorNativeWorktreeMetadata(): void {
        const worktree = this.session.cursorWorktree;
        if (worktree === undefined || worktree === false) {
            return;
        }
        const name = typeof worktree === 'string' ? worktree.trim() : '';
        if (!name) {
            this.messageBuffer.addMessage('Cursor native worktree enabled', 'status');
            return;
        }
        const worktreePath = resolveCursorNativeWorktreePath(this.session.path, name);
        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            worktree: {
                basePath: this.session.path,
                branch: name,
                name,
                worktreePath,
                createdAt: Date.now()
            }
        }));
        this.messageBuffer.addMessage(`Cursor worktree: ${worktreePath}`, 'status');
    }

    private async handleAbort(): Promise<void> {
        this.userAbortRequested = true;
        const backend = this.backend;
        const sessionId = this.acpSessionId ?? this.session.sessionId;
        if (backend && sessionId) {
            const pendingSoftSteers = [...this.softSteerWaiters];
            await backend.cancelPrompt(sessionId);
            // Drop soft-steer bookkeeping first; retain the foreground prompt
            // count and wait for both boundaries before a new handler is used.
            backend.abortSoftSteers();
            if (!this.shouldExit) {
                let timeout: ReturnType<typeof setTimeout> | null = null;
                const drained = await Promise.race([
                    Promise.all([
                        backend.waitForResponseComplete(),
                        Promise.allSettled(pendingSoftSteers)
                    ]).then(() => true),
                    new Promise<boolean>((resolve) => {
                        timeout = setTimeout(() => resolve(false), CURSOR_ABORT_DRAIN_TIMEOUT_MS);
                        timeout.unref?.();
                    })
                ]);
                if (timeout) clearTimeout(timeout);
                if (!drained) {
                    // An ACP request that ignores cancel cannot safely share a
                    // handler with the next prompt. End the launcher instead
                    // of allowing late updates to cross the turn boundary.
                    logger.warn('[cursor-acp] abort drain timed out; ending session to isolate late ACP updates');
                    this.shouldExit = true;
                }
            }
        }
        await this.permissionAdapter?.cancelAll('User aborted');
        await this.extensionAdapter?.cancelAll('User aborted');
        // A soft steer may settle after Abort; preserve its reservation until
        // the completion callback records accepted or indeterminate.
        this.session.queue.reset({ preserveDispatchingReservations: true });
        this.promptInFlight = false;
        // Abort is the hard-stop path: drop soft-steer waiters so the prompt
        // finally cannot block the next prompt on a soft steer whose completion
        // is unbounded and may never settle. Soft counters were already reset
        // above; only the foreground prompt was drained before continuing.
        this.softSteerWaiters = [];
        this.session.client.updateAgentState?.((state) => ({ ...state, steeringActive: false }));
        this.session.onThinkingChange(false);
        this.abortController.abort();
        this.abortController = new AbortController();
        this.messageBuffer.addMessage('Turn aborted', 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort());
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort());
    }
}

const CANNOT_USE_THIS_MODEL_RE = /Cannot use this model:\s*.+/i;

/**
 * Operator-facing ACP failure text. Prefer Cursor's model-rejection stderr;
 * never invent a legacy stream-json diagnosis for unrelated failures.
 */
export function classifyCursorAcpLoadError(
    error: unknown,
    options?: { recentStderr?: string | null; action?: 'resume' | 'start' }
): string {
    const action = options?.action ?? 'resume';
    const prefix = action === 'start'
        ? 'Failed to start Cursor ACP session'
        : 'Failed to resume Cursor ACP session';

    const detailSources = [
        // Prefer the close Error (accumulated stderr) over live onStderrError hints,
        // which may have seen only the first fragment of a split rejection line.
        error instanceof Error ? error.message : null,
        error instanceof Error ? String((error as Error & { stderr?: unknown }).stderr ?? '') : null,
        error instanceof Error && error.cause instanceof Error ? error.cause.message : null,
        options?.recentStderr,
        typeof error === 'string' ? error : null
    ].filter((value): value is string => Boolean(value && value.trim()));

    for (const source of detailSources) {
        const modelRejection = extractCannotUseThisModelMessage(source);
        if (modelRejection) {
            return `${prefix}: ${modelRejection}`;
        }
    }

    const detail = error instanceof Error
        ? error.message
        : typeof error === 'string'
            ? error
            : String(error);
    const trimmed = detail.trim() || 'unknown error';
    if (new RegExp(`^${prefix}:`, 'i').test(trimmed)) {
        return trimmed;
    }
    return `${prefix}: ${trimmed}`;
}

function extractCannotUseThisModelMessage(text: string | null | undefined): string | null {
    if (!text) {
        return null;
    }
    const match = text.match(CANNOT_USE_THIS_MODEL_RE);
    if (!match) {
        return null;
    }
    // Keep Cursor's Available models hint when present; do not invent a catalog.
    return match[0].trim().replace(/\s+/g, ' ');
}

function formatAcpLoadError(error: unknown): Record<string, unknown> {
    if (error instanceof Error) {
        const record: Record<string, unknown> = {
            name: error.name,
            message: error.message
        };
        const code = (error as Error & { code?: unknown }).code;
        if (code !== undefined) {
            record.code = code;
        }
        const data = (error as Error & { data?: unknown }).data;
        if (data !== undefined) {
            record.data = data;
        }
        const stderr = (error as Error & { stderr?: unknown }).stderr;
        if (stderr !== undefined) {
            record.stderr = stderr;
        }
        const cause = error.cause;
        if (cause !== undefined) {
            record.cause = cause instanceof Error
                ? { name: cause.name, message: cause.message }
                : cause;
        }
        return record;
    }
    if (typeof error === 'object' && error !== null) {
        return { ...(error as Record<string, unknown>) };
    }
    return { message: String(error) };
}

function isSpawnDefaultModel(modelId: string): boolean {
    const normalized = modelId.trim().toLowerCase();
    return normalized === 'auto' || normalized === 'default' || normalized === 'default[]';
}

function syncCursorModelsFromAcp(backend: AcpSdkBackend, acpSessionId: string): void {
    const snapshot = buildCursorModelsSnapshotFromAcp(backend, acpSessionId);
    if (!snapshot) {
        return;
    }

    const payload = buildCursorModelsSeedPayload(snapshot, readSharedCursorModelsCache());
    setCursorAcpModelsSnapshot(snapshot);
    seedCursorModelsCache(payload);
}

export async function cursorAcpRemoteLauncher(session: CursorSession): Promise<'switch' | 'exit'> {
    const launcher = new CursorAcpRemoteLauncher(session);
    return launcher.launch();
}
