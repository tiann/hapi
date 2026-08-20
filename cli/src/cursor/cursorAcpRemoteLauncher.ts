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
import type { EnhancedMode, PermissionMode } from './loop';
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
import {
    classifyAcpRpcRejection,
    classifyCursorAgentMessage,
    isCompletionClaim,
    mapAcpStderrToFailure,
    rawSnippetForFailure,
    type CursorAgentStreamFailure
} from './cursorAgentMessageClassifier';
import {
    buildModelErrorBridgePrompt,
    canBridgeModelError,
    mergeBridgeGateFields,
    MAX_LAST_USER_MESSAGE_CHARS
} from './cursorModelErrorBridge';
import { getAutoBridgeTransientModelErrors } from './cursorModelErrorBridgePrefs';

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
    private lastAssistantText: string | null = null;
    private turnHasModelError = false;
    /**
     * Text-classifier hit retained until `backend.prompt` settles. Callbacks
     * run before the promise rejects, so recording text immediately would
     * beat the structural RPC classification (e.g. unknown_t_prefix vs
     * transport_closed for WritableIterable). Flush on success; prefer RPC
     * in catch.
     */
    private pendingTextFailure: CursorAgentStreamFailure | null = null;
    /**
     * Typed stderr failure deferred while prompt is in flight so RPC rejection
     * keeps precedence (RPC → stderr → text). Flushed on settle like text.
     */
    private pendingStderrFailure: CursorAgentStreamFailure | null = null;
    /** True while backend.prompt() is in flight — lets stderr model_not_found
     *  surface as modelError during a turn without breaking setup/load remap. */
    private promptInFlight = false;
    /**
     * Set in handleAbort before session/cancel. Cursor often rejects the
     * in-flight prompt as `Error: T: [canceled] Operation aborted`, which the
     * classifier maps to kind=canceled (real model cancel). Intent tracking
     * keeps deliberate Abort/Exit/Switch out of the emergency model-error path.
     */
    private userAbortRequested = false;
    private lastUserMessage: string | null = null;
    private lastTurnMode: EnhancedMode | null = null;
    /** Set only while the bridge prompt itself is the active turn. */
    private bridgingForEventId: string | null = null;
    private bridgingSource: 'auto' | 'manual' | null = null;
    /** Enqueued but not yet started — must not attribute the current in-flight turn. */
    private pendingBridgeEventId: string | null = null;
    private pendingBridgeSource: 'auto' | 'manual' | null = null;
    private lastRecordedModelError: {
        eventId: string;
        atTs: number;
        kind: string;
        rawSnippet: string;
        priorAssistantClaimsDone: boolean;
        lastUserMessage: string;
        transient: boolean;
        bridgedForEventId?: string;
        retriedAndFailed?: boolean;
        supersededByUserTurn?: boolean;
        bridgeable?: boolean;
    } | null = null;

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

        session.client.rpcHandlerManager.registerHandler(
            RPC_METHODS.BridgeModelError,
            async (payload: unknown) => this.handleBridgeModelErrorRpc(payload)
        );

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

        // Restart / resume: hub metadata may still hold an unresolved error from
        // the previous process. Hydrate before the queue loop so the first newer
        // normal turn can durably set supersededByUserTurn.
        this.hydrateLastRecordedModelErrorFromMetadata();

        const sendReady = () => {
            if (this.turnHasModelError) {
                // Don't clear the error state with a 'ready' — banner stays visible.
                return;
            }
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

            // Activate bridge attribution only from queue-owned provenance —
            // never from caller-controlled localId (which can forge `bridge:`).
            const bridgeItem = batch.items.find(
                (item) => item.internal?.kind === 'model-error-bridge'
            );
            if (bridgeItem?.internal?.kind === 'model-error-bridge') {
                const eventId = bridgeItem.internal.eventId;
                // Enqueue-time queue check can go stale: a normal turn may arrive
                // after Bridge is already at the head. Drop Bridge and let the
                // newer user intent run next (isolated batch already dequeued).
                if (this.session.queue.hasPendingNonBridgeTurn()) {
                    if (this.pendingBridgeEventId === eventId) {
                        this.pendingBridgeEventId = null;
                        this.pendingBridgeSource = null;
                    }
                    this.markModelErrorSupersededByUserTurn();
                    continue;
                }
                this.bridgingForEventId = eventId;
                this.bridgingSource = this.pendingBridgeSource ?? 'manual';
                if (this.pendingBridgeEventId === eventId) {
                    this.pendingBridgeEventId = null;
                    this.pendingBridgeSource = null;
                }
            } else if (this.lastRecordedModelError && !this.lastRecordedModelError.supersededByUserTurn) {
                // A newer normal turn owns the conversation — stale Bridge must not replay the failed prompt.
                this.markModelErrorSupersededByUserTurn();
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

            this.lastUserMessage = batch.message;
            this.lastTurnMode = batch.mode;

            // applyLiveModel / applyCursorAcpMode can take time after dequeue.
            if (this.bridgingForEventId !== null && this.session.queue.hasPendingNonBridgeTurn()) {
                this.bridgingForEventId = null;
                this.bridgingSource = null;
                this.markModelErrorSupersededByUserTurn();
                continue;
            }

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
            this.turnHasModelError = false;
            this.userAbortRequested = false;
            this.lastAssistantText = null;
            this.pendingTextFailure = null;
            this.pendingStderrFailure = null;
            this.promptInFlight = true;
            session.client.updateAgentState?.((state) => ({ ...state, steeringActive: true }));
            this.activePromptModeHash = batch.hash;
            try {
                const settleFailure = (error: unknown) => {
                    const rpcFailure = classifyAcpRpcRejection(error);
                    const genericRpcFailure = rpcFailure !== null && (
                        rpcFailure.kind === 'transport_closed'
                        || rpcFailure.kind === 'agent_crashed'
                        || rpcFailure.kind === 'prompt_failed'
                    );
                    return genericRpcFailure
                        ? this.pendingStderrFailure ?? rpcFailure ?? this.pendingTextFailure
                        : rpcFailure ?? this.pendingStderrFailure ?? this.pendingTextFailure;
                };
                for (let retryAttempt = 0; retryAttempt <= CURSOR_AUTO_RETRY_LIMIT; retryAttempt += 1) {
                    this.pendingRetryableError = null;
                    this.pendingRetryableFromStderr = false;
                    this.pendingInlineRetryableError = false;
                    this.attemptProducedToolActivity = false;
                    let turnCompleted = false;
                    try {
                        const sent = await backend.prompt(acpSessionId, promptContent, (message) => {
                            if (message.type === 'turn_complete') turnCompleted = true;
                            this.handleAgentMessage(message);
                        }, {
                            shouldSend: () => !(this.bridgingForEventId !== null
                                && this.session.queue.hasPendingNonBridgeTurn())
                        });
                        if (sent === false) {
                            this.bridgingForEventId = null;
                            this.bridgingSource = null;
                            this.markModelErrorSupersededByUserTurn();
                            break;
                        }
                        if (this.userAbortRequested) break;
                        if (turnCompleted && this.pendingRetryableFromStderr && !this.pendingInlineRetryableError) {
                            this.pendingRetryableError = null;
                        }
                        if (!this.pendingRetryableError) {
                            const settled = this.pendingStderrFailure ?? this.pendingTextFailure;
                            if (settled && !this.turnHasModelError) {
                                this.recordModelError(settled);
                            }
                            this.pendingStderrFailure = null;
                            this.pendingTextFailure = null;
                            void backend.refreshSessionInfo(acpSessionId, session.path);
                            break;
                        }
                    } catch (error) {
                        logger.warn('[cursor-acp] prompt failed', error);
                        if (this.userAbortRequested) break;
                        if (!isRetryableCursorError(error)) {
                            this.surfacePromptFailure(error instanceof Error ? error.message : String(error));
                            const failure = settleFailure(error);
                            this.pendingStderrFailure = null;
                            this.pendingTextFailure = null;
                            if (failure) this.recordModelError(failure);
                            break;
                        }
                        this.pendingRetryableError = error instanceof Error ? error.message : String(error);
                    }

                    if (this.attemptProducedToolActivity) {
                        this.surfacePromptFailure('Cursor connection interrupted after tool activity; the prompt was not retried.');
                        const failure = settleFailure(
                            this.pendingRetryableError ?? 'Cursor connection interrupted after tool activity'
                        );
                        this.pendingStderrFailure = null;
                        this.pendingTextFailure = null;
                        if (failure) this.recordModelError(failure);
                        break;
                    }
                    if (retryAttempt < CURSOR_AUTO_RETRY_LIMIT) {
                        this.surfaceRetry(retryAttempt + 1);
                        continue;
                    }
                    this.surfacePromptFailure(`Cursor Agent failed after ${CURSOR_AUTO_RETRY_LIMIT} retries.`);
                    const exhaustedFailure = settleFailure(
                        this.pendingRetryableError ?? 'Cursor Agent failed after retries'
                    );
                    this.pendingStderrFailure = null;
                    this.pendingTextFailure = null;
                    if (exhaustedFailure) this.recordModelError(exhaustedFailure);
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
                this.pendingStderrFailure = null;
                this.pendingTextFailure = null;
                session.onThinkingChange(false);
                await this.permissionAdapter?.cancelAll('Prompt finished');
                await this.extensionAdapter?.cancelAll('Prompt finished');
                if (
                    !this.userAbortRequested
                    && !this.turnHasModelError
                    && this.bridgingForEventId !== null
                ) {
                    const eventId = this.bridgingForEventId;
                    const source = this.bridgingSource ?? 'manual';
                    this.markModelErrorBridgeSucceeded(eventId, source);
                    this.bridgingForEventId = null;
                    this.bridgingSource = null;
                }
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
            this.session.client.rpcHandlerManager.registerHandler(
                RPC_METHODS.BridgeModelError,
                async () => ({ ok: false, reason: 'session_ended' })
            );
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
            // Setup/load remap consumes "Cannot use this model" stderr without
            // promoting to modelError. During an active prompt, the same
            // signature must become model_not_found (mapper would otherwise
            // be unreachable behind this early return).
            const failure = mapAcpStderrToFailure(error);
            if (error.type === 'model_not_found' && extractCannotUseThisModelMessage(hint)) {
                // Setup/load remap may reject a stale spawn model then succeed
                // after remap — never promote that to a turn alert. Only defer
                // during an active prompt so RPC precedence still wins.
                if (this.promptInFlight && failure) {
                    this.pendingStderrFailure ??= failure;
                }
                return;
            }
            const converted = convertAgentMessage({ type: 'error', message: error.message });
            if (converted) {
                session.sendAgentMessage(converted);
            }
            messageBuffer.addMessage(error.message, 'status');
            // STRUCTURAL signal: route typed stderr into the modelError pipeline
            // (rate_limited / quota_exhausted / auth_failed / model_not_found)
            // without text matching. Generic `unknown` stderr stays status-only —
            // ACP treats stderr as logging, and the transport labels any
            // "error"/"failed"/"exception" line as unknown.
            // While prompt is in flight, defer so RPC rejection keeps precedence.
            // Idle stderr can still surface a banner/notify, but must not be
            // Bridgeable — stdout/stderr are independent, so a strong rate-limit
            // line can arrive after a turn already succeeded.
            if (failure) {
                if (this.promptInFlight) {
                    this.pendingStderrFailure ??= failure;
                } else {
                    this.recordModelError(failure, { bridgeable: false });
                }
            }
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
                this.handleTextMessageClassification(message.text);
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

    private handleTextMessageClassification(text: string): void {
        // FALLBACK PATH ONLY — deferred until prompt settles so structural
        // RPC / stderr can win. If a structural signal already classified
        // this turn, keep lastAssistantText for priorAssistantClaimsDone.
        if (this.turnHasModelError) {
            this.lastAssistantText = text;
            return;
        }
        const failure = classifyCursorAgentMessage(text);
        if (failure) {
            this.pendingTextFailure ??= failure;
        } else {
            this.lastAssistantText = text;
        }
    }

    /**
     * Single source of truth for emitting modelError. Structural paths
     * (RPC catch / stderr) record immediately; text fallback is deferred
     * via pendingTextFailure until prompt settles, then flushed here.
     * First recorded signal wins for the turn.
     */
    private recordModelError(
        failure: CursorAgentStreamFailure,
        opts?: { bridgeable?: boolean }
    ): void {
        if (this.turnHasModelError) {
            logger.debug(
                `[cursor-acp] modelError already recorded for this turn, dropping ${failure.source}/${failure.kind}`
            );
            return;
        }
        // Abort/Exit/Switch can settle as canceled *or* transport/process-close
        // shapes (ACP process exited, WritableIterable closed, …). Never promote
        // those into lastModelError / notify / auto-bridge after a deliberate stop.
        if (this.userAbortRequested) {
            logger.debug(
                `[cursor-acp] dropping modelError after user abort kind=${failure.kind}`
            );
            this.pendingTextFailure = null;
            this.pendingStderrFailure = null;
            return;
        }
        this.turnHasModelError = true;
        this.pendingTextFailure = null;
        this.pendingStderrFailure = null;

        const bridgedFailure = this.bridgingForEventId !== null;
        if (bridgedFailure) {
            this.bridgingForEventId = null;
            this.bridgingSource = null;
        }

        // A newer displayed error invalidates any not-yet-started bridge.
        this.cancelPendingBridge();

        // Same-message case: Cursor often appends `Error: T: ...` onto the
        // assistant block that already claimed "Done." — lastAssistantText is
        // still null because we classify before storing. Check failure.raw too.
        const priorAssistantClaimsDone = (this.lastAssistantText !== null
            && isCompletionClaim(this.lastAssistantText))
            || (failure.source === 'text' && isCompletionClaim(failure.raw));
        const rawSnippet = rawSnippetForFailure(failure);
        const eventId = randomUUID();
        const atTs = Date.now();
        // Fail closed on silently truncated prompts — Bridge must replay exact text.
        const fullMessage = this.lastUserMessage ?? '';
        const fitsBridgeLimit = fullMessage.length <= MAX_LAST_USER_MESSAGE_CHARS;
        const isPassThroughCommand = parseCursorSpecialCommand(fullMessage).type === 'pass-through';
        const bridgeable = opts?.bridgeable !== false && fitsBridgeLimit && !isPassThroughCommand;
        const lastUserMessage = bridgeable ? fullMessage : '';

        logger.debug(
            `[cursor-acp] modelError recorded source=${failure.source} kind=${failure.kind} transient=${failure.transient}${bridgedFailure ? ' (bridge failed)' : ''}${!bridgeable ? ' (not bridgeable)' : ''}`
        );

        this.lastRecordedModelError = {
            eventId,
            atTs,
            kind: failure.kind,
            transient: failure.transient,
            rawSnippet,
            priorAssistantClaimsDone,
            lastUserMessage,
            ...(bridgeable ? {} : { bridgeable: false }),
            ...(bridgedFailure ? { retriedAndFailed: true } : {})
        };

        this.session.client.updateMetadata((metadata) => ({
            ...metadata,
            lastModelError: this.lastRecordedModelError!
        }));

        this.session.sendSessionEvent({
            type: 'modelError',
            kind: failure.kind,
            transient: failure.transient,
            rawSnippet,
            priorAssistantClaimsDone
        });

        if (
            !bridgedFailure
            && bridgeable
            && failure.transient
            && getAutoBridgeTransientModelErrors()
        ) {
            this.tryEnqueueModelErrorBridge('auto');
        }
    }

    private async handleBridgeModelErrorRpc(payload: unknown): Promise<{ ok: boolean; reason?: string }> {
        if (!payload || typeof payload !== 'object') {
            return this.tryEnqueueModelErrorBridge('manual');
        }

        const record = payload as Record<string, unknown>;
        const snapshot = {
            eventId: typeof record.eventId === 'string' ? record.eventId : undefined,
            atTs: typeof record.atTs === 'number' ? record.atTs : undefined,
            kind: typeof record.kind === 'string' ? record.kind : undefined,
            rawSnippet: typeof record.rawSnippet === 'string' ? record.rawSnippet : undefined,
            lastUserMessage: typeof record.lastUserMessage === 'string' ? record.lastUserMessage : undefined,
            priorAssistantClaimsDone: record.priorAssistantClaimsDone === true,
            transient: typeof record.transient === 'boolean'
                ? record.transient
                : (this.lastRecordedModelError?.transient ?? false),
            bridgedForEventId: typeof record.bridgedForEventId === 'string'
                ? record.bridgedForEventId
                : undefined,
            retriedAndFailed: record.retriedAndFailed === true,
            supersededByUserTurn: record.supersededByUserTurn === true,
            bridgeable: record.bridgeable === false ? false : undefined
        };

        if (snapshot.eventId !== undefined) {
            // Bind to the displayed error — refuse if a newer local error won.
            if (
                this.lastRecordedModelError
                && this.lastRecordedModelError.eventId !== snapshot.eventId
            ) {
                return { ok: false, reason: 'model_error_changed' };
            }
            // Merge hub snapshot into local gate state — never clobber
            // bridgedForEventId / retriedAndFailed / supersededByUserTurn /
            // bridgeable=false with undefined/false from a stale hub payload.
            const gates = mergeBridgeGateFields(this.lastRecordedModelError, {
                bridgedForEventId: snapshot.bridgedForEventId,
                retriedAndFailed: snapshot.retriedAndFailed,
                supersededByUserTurn: snapshot.supersededByUserTurn,
                bridgeable: snapshot.bridgeable
            });
            this.lastRecordedModelError = {
                eventId: snapshot.eventId,
                atTs: snapshot.atTs ?? this.lastRecordedModelError?.atTs ?? Date.now(),
                kind: snapshot.kind ?? this.lastRecordedModelError?.kind ?? 'unknown',
                rawSnippet: snapshot.rawSnippet ?? this.lastRecordedModelError?.rawSnippet ?? '',
                priorAssistantClaimsDone: snapshot.priorAssistantClaimsDone,
                lastUserMessage: snapshot.lastUserMessage
                    ?? this.lastRecordedModelError?.lastUserMessage
                    ?? this.lastUserMessage
                    ?? '',
                transient: snapshot.transient,
                bridgedForEventId: gates.bridgedForEventId,
                retriedAndFailed: gates.retriedAndFailed,
                supersededByUserTurn: gates.supersededByUserTurn,
                bridgeable: gates.bridgeable
            };
        }

        return this.tryEnqueueModelErrorBridge('manual');
    }

    private tryEnqueueModelErrorBridge(source: 'auto' | 'manual'): { ok: boolean; reason?: string } {
        const metadataError = this.lastRecordedModelError;

        if (!metadataError) {
            return { ok: false, reason: 'no_model_error' };
        }

        // Manual Bridge during a newer in-flight turn would front-queue a stale
        // retry that still runs if that turn succeeds (no superseding modelError).
        // Auto-bridge may still fire while settling the failed turn itself.
        if (source === 'manual' && this.promptInFlight) {
            return { ok: false, reason: 'prompt_in_flight' };
        }

        if (metadataError.supersededByUserTurn) {
            return { ok: false, reason: 'superseded_by_newer_turn' };
        }

        // Fail closed while a bridge for this eventId is pending or active.
        if (
            this.bridgingForEventId === metadataError.eventId
            || this.pendingBridgeEventId === metadataError.eventId
        ) {
            return { ok: false, reason: 'not_bridgeable' };
        }

        const bridgeInput = {
            kind: metadataError.kind,
            rawSnippet: metadataError.rawSnippet,
            priorAssistantClaimsDone: metadataError.priorAssistantClaimsDone,
            lastUserMessage: metadataError.lastUserMessage ?? this.lastUserMessage ?? ''
        };

        if (!bridgeInput.lastUserMessage.trim()) {
            return { ok: false, reason: 'missing_last_user_message' };
        }

        if (!canBridgeModelError({
            transient: metadataError.transient,
            eventId: metadataError.eventId,
            bridgedForEventId: metadataError.bridgedForEventId,
            retriedAndFailed: metadataError.retriedAndFailed,
            supersededByUserTurn: metadataError.supersededByUserTurn,
            bridgeable: metadataError.bridgeable
        })) {
            return { ok: false, reason: 'not_bridgeable' };
        }

        const prompt = buildModelErrorBridgePrompt({
            kind: bridgeInput.kind,
            rawSnippet: bridgeInput.rawSnippet,
            lastUserMessage: bridgeInput.lastUserMessage,
            priorAssistantClaimsDone: bridgeInput.priorAssistantClaimsDone
        });

        const bridgedEventId = metadataError.eventId;

        // Never overtake newer user intent already waiting in the queue.
        // supersededByUserTurn is only stamped when a normal batch starts; if we
        // unshift Bridge ahead of that batch we replay the old prompt first.
        if (this.session.queue.hasPendingNonBridgeTurn()) {
            this.markModelErrorSupersededByUserTurn();
            return { ok: false, reason: 'superseded_by_newer_turn' };
        }

        // Drop any stale pending bridge for a different event before enqueue.
        if (this.pendingBridgeEventId && this.pendingBridgeEventId !== bridgedEventId) {
            this.cancelPendingBridge();
        }

        // Attribution arms when the bridge batch starts, not at enqueue.
        this.pendingBridgeEventId = bridgedEventId;
        this.pendingBridgeSource = source;

        const mode = this.lastTurnMode ?? {
            permissionMode: this.session.getPermissionMode() as PermissionMode,
            model: this.currentBackendModel ?? this.session.model ?? undefined
        };

        // Front of queue only when no newer user turn is waiting.
        // Provenance is queue-owned (`internal`). Omit synthetic localId so
        // dequeue cannot ACK a client prompt that reused `bridge:${eventId}`.
        this.session.queue.unshiftIsolated(
            prompt,
            mode,
            undefined,
            { kind: 'model-error-bridge', eventId: bridgedEventId }
        );
        logger.debug(`[cursor-acp] modelError bridge enqueued for eventId=${bridgedEventId} source=${source}`);

        return { ok: true };
    }

    /** Drop not-yet-started bridge queue entries and clear the retry gate. */
    private cancelPendingBridge(): void {
        const eventId = this.pendingBridgeEventId;
        if (eventId) {
            this.session.queue.cancelModelErrorBridge(eventId);
        } else {
            // Gate/queue desync: scrub any pending queue-owned bridge rows.
            for (const item of this.session.queue.queue) {
                if (item.internal?.kind === 'model-error-bridge') {
                    this.session.queue.cancelModelErrorBridge(item.internal.eventId);
                }
            }
        }
        this.pendingBridgeEventId = null;
        this.pendingBridgeSource = null;
    }

    private markModelErrorBridgeSucceeded(eventId: string, source: 'auto' | 'manual'): void {
        const current = this.lastRecordedModelError;
        if (!current || current.eventId !== eventId) {
            return;
        }
        this.lastRecordedModelError = {
            ...current,
            bridgedForEventId: eventId
        };
        this.session.client.updateMetadata((metadata) => {
            const err = metadata.lastModelError;
            if (!err || err.eventId !== eventId) {
                return metadata;
            }
            return {
                ...metadata,
                lastModelError: {
                    ...err,
                    bridgedForEventId: eventId
                }
            };
        });
        // Chat-visible recovery marker only. Not an AGENT_NOTIFY_SUMMARY.
        this.session.sendSessionEvent({
            type: 'modelErrorBridged',
            kind: current.kind,
            auto: source === 'auto',
            eventId
        });
    }

    /** Durable invalidation after a newer normal (non-bridge) turn starts. */
    private markModelErrorSupersededByUserTurn(): void {
        const current = this.lastRecordedModelError;
        if (!current || current.supersededByUserTurn) {
            return;
        }
        this.lastRecordedModelError = {
            ...current,
            supersededByUserTurn: true
        };
        this.session.client.updateMetadata((metadata) => {
            const err = metadata.lastModelError;
            if (!err || err.eventId !== current.eventId) {
                return metadata;
            }
            return {
                ...metadata,
                lastModelError: {
                    ...err,
                    supersededByUserTurn: true
                }
            };
        });
    }

    /** Load durable lastModelError from hub metadata after CLI restart/resume. */
    private hydrateLastRecordedModelErrorFromMetadata(): void {
        if (this.lastRecordedModelError) {
            return;
        }
        const getMetadata = this.session.client.getMetadata;
        if (typeof getMetadata !== 'function') {
            return;
        }
        const persistedError = getMetadata.call(this.session.client)?.lastModelError;
        if (!persistedError || typeof persistedError.eventId !== 'string') {
            return;
        }
        this.lastRecordedModelError = {
            ...persistedError,
            lastUserMessage: persistedError.lastUserMessage ?? ''
        };
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
        // Mark + clear bridge gates BEFORE any await. Otherwise a settling
        // bridge prompt can race markModelErrorBridgeSucceeded and falsely
        // persist bridgedForEventId / modelErrorBridged after the operator canceled.
        this.userAbortRequested = true;
        this.cancelPendingBridge();
        this.bridgingForEventId = null;
        this.bridgingSource = null;
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
