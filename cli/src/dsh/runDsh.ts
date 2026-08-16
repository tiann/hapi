import { randomUUID } from 'node:crypto'
import { logger } from '@/ui/logger'
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory'
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler'
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc'
import { readBoundedAttachmentFile } from '@/modules/common/attachmentFile'
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
    attachments: Array<{ id: string; filename: string; mimeType: string; size: number; path: string; previewUrl?: string }> | undefined
): Promise<PromptContentPart[]> {
    const parts: PromptContentPart[] = []
    let body = text
    for (const attachment of attachments ?? []) {
        if (attachment.mimeType.toLowerCase().startsWith('image/')) {
            try {
                const buffer = await readBoundedAttachmentFile(attachment.path)
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

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'dsh',
        onBeforeClose: () => {
            stopKeepAlive();
            if (pendingHistoryMetadataFlush) {
                clearTimeout(pendingHistoryMetadataFlush);
                flushHistoryMetadata();
            }
            hostRef.current?.stop({ timeoutMs: 5_000 }).catch((error) => {
                logger.debug('[dsh] host stop error during cleanup:', error);
            });
            bridgeAbort.abort();
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
            dshRuntimeVersion: host.info.version || DSH_RUNTIME_VERSION,
            capabilities: {
                ...metadata.capabilities,
                conversationHistory: {
                    forkCurrent: true,
                    forkAtMessage: true,
                    rewindToMessage: true
                }
            }
        }));
        // Fork children wait for session-ready before reporting success, so
        // the hub can verify the child actually resumed the forked native id.
        session.emitSessionReady();

        const projector = new DshProjector(created.sessionId);
        let pendingCursorFlush: ReturnType<typeof setTimeout> | null = null;
        let latestCursorSeq = 0;
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

        const bridge = new DshEventBridge({
            client,
            dshSessionId: created.sessionId,
            projector,
            ...(typeof session.getMetadata()?.dshEventCursor === 'number'
                ? { initialCursor: session.getMetadata()!.dshEventCursor }
                : {}),
            onMessage: (message: DshProjectedMessage) => {
                if (message.type === 'dsh_native' && message.event.type === 'user/message') {
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
            return { nativeSessionId: result.sessionId, forkSession: false as const };
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
        let currentModelId: string | null = null;
        const resolveModelProvider = async (modelId: string): Promise<string | null> => {
            const catalog = await client.sessionModels(created.sessionId);
            const match = catalog.groups
                .flatMap((group) => group.models.map((m) => ({ ...m, provider: group.id })))
                .find((m) => m.id === modelId);
            return match?.provider ?? null;
        };
        registerSessionConfigRpc({
            rpcHandlerManager: session.rpcHandlerManager,
            flavor: 'dsh',
            modelMode: 'nullable',
            modelReasoningEffortMode: 'nullable',
            onApply: async (config) => {
                if (config.model !== undefined) {
                    if (config.model === null) {
                        return;
                    }
                    const provider = await resolveModelProvider(config.model);
                    if (!provider) {
                        throw new Error(`Unknown DSH model: ${config.model}`);
                    }
                    currentModelId = config.model;
                    const catalog = await client.sessionModels(created.sessionId);
                    const match = catalog.groups
                        .flatMap((group) => group.models.map((m) => ({ ...m, provider: group.id })))
                        .find((m) => m.id === config.model);
                    await client.selectModel({
                        sessionId: created.sessionId,
                        provider,
                        model: config.model,
                        ...(match?.reasoning?.defaultEffort !== undefined
                            ? { reasoningEffort: match.reasoning.defaultEffort }
                            : {})
                    });
                    return;
                }
                if (config.modelReasoningEffort !== undefined) {
                    // Effort is part of the DSH model selection. Before the
                    // user picks a model explicitly, apply it to the host's
                    // current/default model (catalog.current).
                    const target = currentModelId
                        ?? (await client.sessionModels(created.sessionId)).current.model;
                    const provider = await resolveModelProvider(target);
                    if (!provider) {
                        throw new Error(`Unknown DSH model: ${target}`);
                    }
                    await client.selectModel({
                        sessionId: created.sessionId,
                        provider,
                        model: target,
                        ...(config.modelReasoningEffort !== null
                            ? { reasoningEffort: config.modelReasoningEffort }
                            : {})
                    });
                }
            }
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
        session.onUserMessage((message, localId) => {
            const text = message.content.text;
            if (localId) {
                pendingUserLocalIds.push(localId);
            }
            promptChain = promptChain.then(async () => {
                const content = await prepareDshPromptContent(text, message.content.attachments);
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
        await bridge.start(bridgeAbort.signal);

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
