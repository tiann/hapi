import { randomUUID } from 'node:crypto'
import { logger } from '@/ui/logger'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile'
import { MAX_UPLOAD_BYTES } from '@/modules/common/attachmentLimits'
import { isAuthorizedUploadFile, isPathWithinUploadDir } from '@/modules/common/handlers/uploads'
import type { PromptContentPart } from '@deepseek-ai/dsh-host-apiproxy/api'
import type { ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle'
import type { DshProjectedMessage } from '@/agent/types'
import type { DshStateSnapshot } from '@hapi/protocol'
import { RPC_METHODS } from '@hapi/protocol/rpcMethods'
import { getInvokedCwd } from '@/utils/invokedCwd'
import { startDshHost } from './DshRuntime'
import { DshClient } from './DshClient'
import { DshProjector } from './DshProjector'
import { DshEventBridge } from './DshEventBridge'
import { registerDshRpcHandlers } from './DshRpcBridge'
import { DSH_RUNTIME_VERSION, type DshHostHandle } from './types'
import type { AgentState } from '@/api/types'

const CURSOR_FLUSH_MS = 1_000

/**
 * Build the official prompt content from the standard HAPI message: text
 * plus image attachments as base64 image parts (non-image attachments are
 * referenced by path like the other agents do).
 */
async function prepareDshPromptContent(
    text: string,
    sessionId: string,
    attachments: Array<{ id: string; filename: string; mimeType: string; size: number; path: string; previewUrl?: string }> | undefined
): Promise<PromptContentPart[]> {
    const parts: PromptContentPart[] = []
    let body = text
    let remainingBytes = MAX_UPLOAD_BYTES
    for (const attachment of attachments ?? []) {
        if (attachment.mimeType.toLowerCase().startsWith('image/')) {
            try {
                // Only session-uploaded paths may be opened; enforce the
                // aggregate image budget across every attachment.
                if (!isPathWithinUploadDir(attachment.path, sessionId)) {
                    throw new Error('invalid upload path')
                }
                const buffer = await readBoundedAttachmentFile(
                    attachment.path,
                    remainingBytes,
                    (identity) => isAuthorizedUploadFile(attachment.path, sessionId, identity)
                )
                remainingBytes -= buffer.length
                parts.push({
                    type: 'image',
                    mediaType: attachment.mimeType as ImageMediaType,
                    data: buffer.toString('base64'),
                    ...(attachment.filename ? { name: attachment.filename } : {})
                })
            } catch (error) {
                body += `\n[Failed to read image attachment: ${attachment.filename}]`
                logger.debug(`[dsh] image attachment read failed: ${error instanceof Error ? error.message : String(error)}`)
            }
        } else {
            body += `\n[Attached file: ${attachment.path}]`
        }
    }
    return [{ type: 'text', text: body }, ...parts]
}

export async function runDsh(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote' | 'pty';
    model?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
    agentPreset?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode: 'local' | 'remote' | 'pty' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'remote');

    logger.debug(`[dsh] Starting DeepSeek Harness session: cwd=${workingDirectory} startedBy=${startedBy}`);

    const initialState: AgentState = {
        controlledByUser: false,
        startingMode
    };

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'dsh',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'dsh',
            startedBy,
            workingDirectory,
            tag: `__hapi_dsh__${randomUUID()}`,
            agentState: initialState,
            model: opts.model ?? undefined
        });
    const { session } = bootstrap;
    const hapiSessionId = bootstrap.sessionInfo.id;

    setControlledByUser(session, startingMode);

    // Throttled cursor persistence; flushCursor() is exposed for teardown
    // so a shutdown inside the throttle window still persists the latest
    // forwarded seq. Declared before the lifecycle so onBeforeClose can
    // reference it.
    let pendingCursorFlush: ReturnType<typeof setTimeout> | null = null;
    let latestCursorSeq = 0;
    const flushCursor = () => {
        if (pendingCursorFlush) {
            clearTimeout(pendingCursorFlush);
            pendingCursorFlush = null;
        }
        if (latestCursorSeq <= 0) return;
        session.updateMetadata((metadata) => ({
            ...metadata,
            dshEventCursor: latestCursorSeq
        }));
    };

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'dsh',
        onBeforeClose: async () => {
            stopKeepAlive();
            // Persist the latest forwarded cursor even when shutdown lands
            // inside the throttle window (unref'd timer would never run).
            flushCursor();
            if (pendingHistoryMetadataFlush) {
                clearTimeout(pendingHistoryMetadataFlush);
                flushHistoryMetadata();
            }
            // Mark BEFORE stopping so the host-exit listener never mistakes
            // our graceful shutdown for an unexpected crash; await the stop so
            // the SIGKILL fallback is not cut short by process.exit.
            stoppingHost.value = true;
            bridgeAbort.abort();
            await hostRef.current?.stop({ timeoutMs: 5_000 }).catch((error) => {
                logger.debug('[dsh] host stop error during cleanup:', error);
            });
        }
    });
    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);

    const hostRef: { current: DshHostHandle | null } = { current: null };
    const stoppingHost = { value: false };
    const bridgeAbort = new AbortController();
    // Fork-at-message anchors: HAPI user-message localIds are matched to
    // their native user/message event seqs (FIFO — the DSH host claims queued
    // prompts in order). Persisted via conversationHistoryPoints/Indexes so
    // the web shows fork/rewind affordances and the handlers can address the
    // native log after reconnect too.
    const userLocalIdToSeq = new Map<string, number>();
    const historyMetadataDirty = { points: false, indexes: false };
    let pendingHistoryMetadataFlush: ReturnType<typeof setTimeout> | null = null;
    const flushHistoryMetadata = () => {
        pendingHistoryMetadataFlush = null;
        if (!historyMetadataDirty.points && !historyMetadataDirty.indexes) return;
        historyMetadataDirty.points = false;
        historyMetadataDirty.indexes = false;
        session.updateMetadata((metadata) => {
            const points = { ...(metadata.conversationHistoryPoints ?? {}) };
            const indexes = { ...(metadata.conversationHistoryIndexes ?? {}) };
            for (const [localId, seq] of userLocalIdToSeq) {
                points[localId] = true;
                indexes[localId] = seq;
            }
            return { ...metadata, conversationHistoryPoints: points, conversationHistoryIndexes: indexes };
        });
    };
    // Hub keepalive: without session-alive heartbeats the hub marks the
    // session inactive and drops the RPC target. The thinking flag follows
    // the DSH host running status so the web spinner matches reality.
    let dshThinking = false;
    const syncKeepAlive = () => {
        session.keepAlive(dshThinking, 'remote', {});
    };
    syncKeepAlive();
    const keepAliveInterval = setInterval(syncKeepAlive, 2_000);
    const stopKeepAlive = () => {
        clearInterval(keepAliveInterval);
    };

    // Approval state mirrored into HAPI agentState (web permission cards read
    // agentState.requests; the response RPC resolves through DshAction).
    const updateApprovalState = (approvalId: string, entry: { tool: string; arguments: unknown; createdAt: number } | null) => {
        session.updateAgentState((currentState) => {
            const requests = { ...(currentState.requests ?? {}) };
            if (entry) {
                requests[approvalId] = entry;
            } else {
                delete requests[approvalId];
            }
            return { ...currentState, requests };
        });
    };

    let crashed = false;

    try {
        // Spawn the host-only DSH runtime and connect over loopback.
        const host = await startDshHost({
            cwd: workingDirectory,
            logTag: 'dsh'
        });
        hostRef.current = host;
        // Unexpected host death (crash, OOM kill, manual kill) must end the
        // session instead of leaving an active zombie behind the reconnect
        // loop. Our own graceful stop sets stoppingHost first.
        host.process.once('exit', (code) => {
            if (stoppingHost.value) return;
            logger.debug(`[dsh] host exited unexpectedly (code=${code}); ending session`);
            bridgeAbort.abort();
            lifecycle.markCrash(new Error(`DSH host exited unexpectedly (code=${code})`));
            void lifecycle.cleanupAndExit(1);
        });

        const client = DshClient.connect(host.baseUrl);

        // Durable mapping: HAPI session id = DSH session id (official
        // create-as-resume idempotency per id+cwd). A resumed session reuses
        // the recorded id; a fresh one preallocates the HAPI id.
        const dshSessionId = bootstrap.sessionInfo.metadata?.dshSessionId ?? hapiSessionId;
        const created = await client.createSession({
            cwd: workingDirectory,
            sessionId: dshSessionId,
            ...(opts.agentPreset ? { agentPreset: opts.agentPreset } : {})
        });

        session.updateMetadata((metadata) => ({
            ...metadata,
            flavor: 'dsh',
            dshSessionId: created.sessionId,
            dshRuntimeVersion: host.runtimeVersion || DSH_RUNTIME_VERSION,
            capabilities: {
                ...metadata.capabilities,
                conversationHistory: {
                    forkCurrent: true,
                    forkAtMessage: true,
                    rewindToMessage: true
                }
            }
        }));

        // Launch-time model selection: apply it to the runtime BEFORE the
        // first prompt so `hapi dsh --model X` actually runs X instead of
        // merely reporting it in metadata.
        if (opts.model) {
            const catalog = await client.sessionModels(created.sessionId);
            const matches = catalog.groups.flatMap((group) =>
                group.models
                    .filter((model) => model.id === opts.model)
                    .map((model) => ({ provider: group.id, modelId: model.id }))
            );
            if (matches.length !== 1) {
                throw new Error(`Unknown or ambiguous DSH model: ${opts.model}`);
            }
            await client.selectModel({
                sessionId: created.sessionId,
                provider: matches[0].provider,
                model: matches[0].modelId
            });
            session.updateMetadata((metadata) => ({
                ...metadata,
                dshSelectedModel: matches[0]
            }));
        }
        const projector = new DshProjector(created.sessionId);
        const pendingUserLocalIds: string[] = [];
        const noteUserMessageSeq = (seq: number) => {
            const localId = pendingUserLocalIds.shift();
            if (!localId) return;
            userLocalIdToSeq.set(localId, seq);
            historyMetadataDirty.points = true;
            historyMetadataDirty.indexes = true;
            if (!pendingHistoryMetadataFlush) {
                pendingHistoryMetadataFlush = setTimeout(flushHistoryMetadata, 1_000);
                pendingHistoryMetadataFlush.unref?.();
            }
        };

        // Fork children wait for session-ready before reporting success, so
        // the hub can verify the child actually resumed the forked native id.
        // session-ready (and user-message dispatch) is gated on the bridge's
        // first-generation readiness: a prompt committed before the root mux
        // subscription would be replayed as backfill, which must not consume
        // its pending localId (that would corrupt fork/rewind anchors).
        let bridgeReadyResolve: (() => void) | undefined
        const bridgeReady = new Promise<void>((resolve) => { bridgeReadyResolve = resolve })
        const bridge = new DshEventBridge({
            client,
            dshSessionId: created.sessionId,
            projector,
            onReady: () => bridgeReadyResolve?.(),
            ...(typeof session.getMetadata()?.dshEventCursor === 'number'
                ? { initialCursor: session.getMetadata()!.dshEventCursor }
                : {}),
            onMessage: (message: DshProjectedMessage, source: 'live' | 'backfill') => {
                // Only LIVE root-session user messages anchor fork/rewind
                // boundaries. Backfill replays historical events (their HAPI
                // messages already exist) and must not consume the pending
                // localId FIFO; child projectors' user/message forwarding must
                // not either.
                if (source === 'live'
                    && message.type === 'dsh_native'
                    && message.event.type === 'user/message'
                    && message.event.dshSessionId === created.sessionId) {
                    noteUserMessageSeq(message.event.seq);
                }
                session.sendAgentMessage(message);
            },
            onStateSnapshot: (snapshot: DshStateSnapshot) => {
                session.sendAgentMessage({ type: 'dsh_state', state: snapshot });
            },
            onApprovalPending: (approval) => {
                updateApprovalState(approval.approvalId, {
                    tool: approval.toolName,
                    arguments: {
                        ...(approval.callId ? { callId: approval.callId } : {}),
                        ...(approval.reason ? { reason: approval.reason } : {})
                    },
                    createdAt: Date.now()
                });
            },
            onApprovalResolved: (approvalId) => {
                updateApprovalState(approvalId, null);
            },
            onHostStatus: (running) => {
                dshThinking = running;
                syncKeepAlive();
            },
            onAgentError: (message) => {
                session.sendAgentMessage({ type: 'error', message });
            },
            onCursor: (seq) => {
                // Keep the LATEST seq: the throttle timer must read the
                // current value at flush time, not the event that armed it.
                latestCursorSeq = seq;
                if (pendingCursorFlush) return;
                pendingCursorFlush = setTimeout(() => {
                    pendingCursorFlush = null;
                    session.updateMetadata((metadata) => ({
                        ...metadata,
                        dshEventCursor: latestCursorSeq
                    }));
                }, CURSOR_FLUSH_MS);
                pendingCursorFlush.unref?.();
            },
            logTag: 'dsh'
        });

        // Legacy permission RPC (hub permission approve/deny buttons) maps to
        // the DSH approval response with the official two-outcome vocabulary.
        session.rpcHandlerManager.registerHandler(RPC_METHODS.Permission, async (payload: unknown) => {
            const request = payload as { id?: unknown; approved?: unknown };
            const approvalId = typeof request.id === 'string' ? request.id : null;
            if (!approvalId) {
                throw new Error('permission request id is required');
            }
            const rpcId = projector.approvalRpcId(approvalId);
            if (!rpcId) {
                throw new Error(`approval ${approvalId} is not pending`);
            }
            await client.respond(rpcId, {
                sessionId: created.sessionId,
                approvalId,
                outcome: request.approved === true ? 'allowed-once' : 'rejected'
            });
            return { approved: request.approved === true };
        });

        // Fork: official session.fork anchored at the native seq of the
        // message the user picked (forkCurrent has no localId → last turn).
        session.rpcHandlerManager.registerHandler(RPC_METHODS.ForkConversation, async (payload: unknown) => {
            const localId = payload && typeof payload === 'object'
                && typeof (payload as { messageLocalId?: unknown }).messageLocalId === 'string'
                ? (payload as { messageLocalId: string }).messageLocalId
                : undefined;
            let atSeq: number | undefined;
            if (localId) {
                const recorded = userLocalIdToSeq.get(localId)
                    ?? session.getMetadata()?.conversationHistoryIndexes?.[localId];
                if (typeof recorded !== 'number') {
                    throw new Error('Fork point not found for message');
                }
                atSeq = recorded;
            }
            const result = await client.forkSession({
                sessionId: created.sessionId,
                ...(atSeq !== undefined ? { atSeq } : {})
            });
            // The hub already copied the transcript prefix into the child row;
            // seed the child's event cursor at the fork tail so its bridge
            // never replays the full native history on the first reconnect.
            let nativeCursor = -1;
            try {
                const tail = await client.sessionHistory({ sessionId: result.sessionId, maxMessages: 1 });
                nativeCursor = tail.events.reduce(
                    (max, entry) => Math.max(max, entry.event.seq),
                    -1
                );
            } catch (error) {
                logger.debug(`[dsh] fork cursor probe failed: ${error instanceof Error ? error.message : String(error)}`);
            }
            return { nativeSessionId: result.sessionId, forkSession: false as const, nativeCursor };
        });

        // Rewind: no native DSH rewind exists — the hub archives this session
        // and forks a child at the anchor (official fork semantics).
        session.rpcHandlerManager.registerHandler(RPC_METHODS.RewindConversation, async (payload: unknown) => {
            const localId = payload && typeof payload === 'object'
                && typeof (payload as { messageLocalId?: unknown }).messageLocalId === 'string'
                ? (payload as { messageLocalId: string }).messageLocalId
                : undefined;
            if (!localId) {
                throw new Error('Rewind requires a message anchor');
            }
            return { success: true as const, truncateFromLocalId: localId, messages: [] as never[] };
        });

        // Standard session-config RPC (web model pickers / hub model endpoint):
        // DSH models are runtime-discovered, so a bare model id is resolved
        // against the live catalog to find its provider route. Permission
        // modes and effort are rejected — DSH presets are runtime-discovered
        // and reasoning effort rides the model selection.
        // Runtime-discovered model selection state (web model endpoint /
        // reasoning-effort endpoint). A bare model id is resolved against the
        // live catalog for its provider; a reasoning-effort change re-selects
        // the current model with the new effort.
        let currentModel: { provider: string; modelId: string } | null = null;
        const resolveModelProvider = async (modelId: string): Promise<string | null> => {
            const catalog = await client.sessionModels(created.sessionId);
            const match = catalog.groups
                .flatMap((group) => group.models.map((m) => ({ ...m, provider: group.id })))
                .find((m) => m.id === modelId);
            return match?.provider ?? null;
        };
        // Raw SetSessionConfig handler: resolves the ORIGINAL payload so
        // provider-qualified {provider, modelId} selections keep their
        // provider identity (the shared registerSessionConfigRpc helper
        // collapses objects to a bare modelId).
        const applyModelSelection = async (provider: string, modelId: string, reasoningEffort?: string | null) => {
            await client.selectModel({
                sessionId: created.sessionId,
                provider,
                model: modelId,
                ...(reasoningEffort !== undefined && reasoningEffort !== null ? { reasoningEffort } : {})
            });
            currentModel = { provider, modelId };
            // Persist the provider-qualified selection (analogous to
            // piSelectedModel) so the hub/web can disambiguate duplicate
            // model ids across providers across reloads.
            session.updateMetadata((metadata) => ({
                ...metadata,
                dshSelectedModel: { provider, modelId }
            }));
        };
        session.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
            const config = payload && typeof payload === 'object'
                ? payload as { model?: unknown; modelReasoningEffort?: unknown }
                : {}
            const applied: Record<string, unknown> = {}
            if (config.model !== undefined && config.model !== null) {
                let provider: string | null = null
                let modelId = ''
                if (typeof config.model === 'object') {
                    const selection = config.model as { provider?: unknown; modelId?: unknown }
                    if (typeof selection.provider === 'string' && typeof selection.modelId === 'string') {
                        provider = selection.provider
                        modelId = selection.modelId
                    }
                } else if (typeof config.model === 'string') {
                    modelId = config.model
                    provider = await resolveModelProvider(modelId)
                }
                if (!provider || modelId.length === 0) {
                    throw new Error(`Unknown DSH model: ${JSON.stringify(config.model)}`)
                }
                const catalog = await client.sessionModels(created.sessionId)
                const match = catalog.groups
                    .flatMap((group) => group.models.map((m) => ({ ...m, provider: group.id })))
                    .find((m) => m.provider === provider && m.id === modelId)
                if (!match) {
                    throw new Error(`Unknown DSH model: ${provider}::${modelId}`)
                }
                const defaultEffort = match.reasoning?.defaultEffort ?? null
                await applyModelSelection(provider, modelId, defaultEffort)
                applied.model = { provider, modelId }
                applied.modelReasoningEffort = defaultEffort
            }
            if (config.modelReasoningEffort !== undefined) {
                // Effort-only change re-selects the CURRENT model, keeping
                // its provider identity (never re-resolve a bare id).
                let target = currentModel
                if (!target) {
                    const catalogCurrent = (await client.sessionModels(created.sessionId)).current
                    target = { provider: catalogCurrent.provider, modelId: catalogCurrent.model }
                }
                if (!target.provider || target.modelId.length === 0) {
                    throw new Error(`Unknown DSH model: ${JSON.stringify(target)}`)
                }
                await applyModelSelection(
                    target.provider,
                    target.modelId,
                    typeof config.modelReasoningEffort === 'string' ? config.modelReasoningEffort : null
                )
                applied.modelReasoningEffort = config.modelReasoningEffort
            }
            return { applied }
        });

        registerDshRpcHandlers({
            client,
            dshSessionId: created.sessionId,
            workingDirectory,
            rpcHandlerManager: session.rpcHandlerManager,
            projector,
            logTag: 'dsh'
        });

        // User messages → DSH queue mode (the DSH host owns the queue;
        // session/queue snapshots surface it through dsh_state).
        // Prompt dispatch is serialized: async attachment preparation plus
        // the FIFO localId→native-seq mapping must not interleave across
        // concurrent user messages (that would corrupt fork/rewind anchors).
        let promptChain: Promise<void> = Promise.resolve();
        const bridgeRun = bridge.start(bridgeAbort.signal);
        await bridgeReady;
        session.emitSessionReady();
        session.onUserMessage((message, localId) => {
            const text = message.content.text;
            if (localId) {
                pendingUserLocalIds.push(localId);
            }
            promptChain = promptChain.then(async () => {
                // Uploads are registered under the HAPI row id; fork children
                // carry a distinct native DSH id, so validate against the
                // HAPI id or every fork-child image would be rejected.
                const content = await prepareDshPromptContent(text, hapiSessionId, message.content.attachments);
                return await client.prompt({
                    sessionId: created.sessionId,
                    mode: 'queue',
                    content
                });
            }).then(() => {
                // The DSH host owns the queue from here; mark the HAPI message
                // invoked so the standard queued-messages bar stays empty (the
                // dsh_state queue panel is the authoritative DSH queue view).
                if (localId) {
                    session.emitMessagesConsumed([localId]);
                }
            }).catch((error) => {
                logger.debug(`[dsh] prompt failed: ${error instanceof Error ? error.message : String(error)}`);
                // Do not let a rejected prompt corrupt the localId→seq FIFO
                // mapping used by fork/rewind anchors.
                if (localId) {
                    const index = pendingUserLocalIds.indexOf(localId);
                    if (index >= 0) {
                        pendingUserLocalIds.splice(index, 1);
                    }
                }
                session.sendAgentMessage({
                    type: 'error',
                    message: `Failed to send prompt: ${error instanceof Error ? error.message : String(error)}`
                });
            });
        });

        // Event bridge runs until the session ends; the host stream keeps the
        // process alive through keepAlive (session-alive heartbeats).
        await bridgeRun;

        lifecycle.setSessionEndReason('completed');
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[dsh] Session error:', error);
        session.sendAgentMessage({
            type: 'error',
            message: `DeepSeek Harness session failed: ${error instanceof Error ? error.message : String(error)}`
        });
    } finally {
        bridgeAbort.abort();
        if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
