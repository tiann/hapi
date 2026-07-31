import { logger } from '@/ui/logger';
import { randomUUID } from 'node:crypto';
import { opencodeLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { OpencodeSession } from './session';
import type { OpencodeMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { startOpencodeHookServer } from './utils/startOpencodeHookServer';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { listSlashCommands } from '@/modules/common/slashCommands';
import { resolveOpencodeSlashCommand } from './utils/slashCommands';

export async function runOpencode(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PermissionMode;
    model?: string;
    modelReasoningEffort?: string | null;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[opencode] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    if (startedBy === 'runner' && opts.startingMode === 'local') {
        logger.debug('[opencode] Runner spawn requested with local mode; forcing remote mode');
        opts.startingMode = 'remote';
    }

    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    if (opts.permissionMode === 'plan' && startingMode !== 'remote') {
        throw new Error('OpenCode plan mode is only supported in remote mode');
    }

    const initialState: AgentState = {
        controlledByUser: false
    };

    // Persist only when the user (or runner) explicitly chose a model on launch.
    // Mid-session selections are persisted by the hub via the set-session-config RPC,
    // not by this initial bootstrap.
    const initialModel = opts.model ?? null;
    const initialModelReasoningEffort = opts.modelReasoningEffort ?? null;

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'opencode',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'opencode',
            startedBy,
            workingDirectory,
            agentState: initialState,
            model: initialModel ?? undefined,
            modelReasoningEffort: initialModelReasoningEffort ?? undefined
        });
    const { api, session } = bootstrap;

    setControlledByUser(session, startingMode);

    const messageQueue = new MessageQueue2<OpencodeMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
        // Distinguish "explicit reset" (null) from "no change" (undefined) so
        // batches with different intent don't merge — the launcher uses null
        // to mean "switch back to defaultBackendModel".
        model: mode.model === null ? '__reset__' : mode.model ?? null,
        modelReasoningEffort: mode.modelReasoningEffort ?? null,
        // Defense in depth: a compact item is always pushed via
        // `pushIsolated` (never batches with siblings regardless of mode
        // hash), but including `operation` here too means a prompt and a
        // compact request could never be merged into one batch even if that
        // isolation guard were ever bypassed.
        operation: mode.operation ?? null
    }));

    const sessionWrapperRef: { current: OpencodeSession | null } = { current: null };
    // Set by opencodeRemoteLauncher once the ACP backend + internal HTTP
    // baseUrl are actually ready (remote mode only), and reset to false as
    // early as possible whenever this session leaves remote mode
    // (OpencodeRemoteLauncher's onLeavingRemote() override — see its doc
    // comment on RemoteLauncherBase for exactly when that fires). While
    // false, the `slash.kind === 'compact'` branch below must tell apart two
    // situations that both look like "compactSupported is false, mode is
    // 'remote'": a session that just entered remote mode and hasn't finished
    // ACP initialize+session load/new yet (should queue /compact like a
    // prompt), versus a session whose remote launcher is already tearing
    // down (onLeavingRemote fired, `mode` hasn't flipped back to 'local' yet
    // because that only happens once the whole launcher unwinds — see
    // AgentSessionBase.onModeChange). `compactTeardownInProgress` below is
    // what distinguishes them — a hostile-review sweep found that gating on
    // `mode` alone (added to fix the first case) silently re-opened the
    // second: it let /compact queue during the exact teardown window
    // onLeavingRemote exists to protect, since `mode` stays 'remote'
    // throughout it.
    let compactSupported = false;
    // True from the moment onCompactAvailabilityChange(false) fires (which,
    // per onLeavingRemote's contract, only ever happens because remote mode
    // is being left — never because remote just started) until this session
    // next re-enters remote mode (see the wrapped `onModeChange` below).
    // Only meaningful while `sessionWrapperRef.current?.mode === 'remote'`;
    // harmless/stale otherwise since the mode check alone already rejects a
    // genuinely local-mode session regardless of this flag's value.
    let compactTeardownInProgress = false;
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'default';
    let sessionModel: string | null = initialModel;
    let sessionModelReasoningEffort: string | null = initialModelReasoningEffort;
    const hookServer = await startOpencodeHookServer({
        onEvent: (event) => {
            const currentSession = sessionWrapperRef.current;
            if (!currentSession) {
                return;
            }
            currentSession.emitHookEvent(event);
        }
    });
    const hookUrl = `http://127.0.0.1:${hookServer.port}/hook/opencode`;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'opencode',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onAfterClose: () => {
            hookServer.stop();
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) {
            return;
        }
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(sessionModel);
        sessionInstance.setModelReasoningEffort(sessionModelReasoningEffort);

        // Notify hub immediately so the UI reflects the change without
        // waiting for the next 2s keepalive tick.
        sessionInstance.pushKeepAlive();

        logger.debug(`[opencode] Synced session config for keepalive: permissionMode=${currentPermissionMode}, model=${sessionModel ?? '(default)'}, modelReasoningEffort=${sessionModelReasoningEffort ?? '(default)'}`);
    };

    // Slash-command resolution now runs inside an async chain on
    // `session.onUserMessage`, so there is a window between the message
    // arriving and `messageQueue.push` / `sendAgentMessage` where
    // `cancelByLocalId` would find nothing. Track in-flight localIds so the
    // cancel RPC can ack the cancel during that window and the chain can
    // short-circuit when it resumes.
    const preparingLocalIds = new Set<string>();
    const cancelledBeforeEnqueue = new Set<string>();
    // Mirrors `cancelledBeforeEnqueue` above, but for the other side of the
    // queued-compact ack: `onCancelQueuedMessage` below can still fire for a
    // localId that's neither in the queue nor in `preparingLocalIds`. Track
    // it here and let the launcher consume it via `isLocalIdCancelled`
    // (passed through opencodeLoop) so it can suppress the eventual
    // "Compaction completed/failed" + Reasoning-block result if this really
    // was that localId.
    //
    // Note on how narrow this window actually is: the hub only calls back
    // into the CLI's `onCancelQueuedMessage` when its own DB lookup still
    // finds the row queued (invoked_at IS NULL) — see
    // `cancelQueuedMessage`'s Phase 1 in hub/src/sync/messageService.ts.
    // `session.emitMessagesConsumed([localId])` a few lines below fires the
    // "invoked" ack for the /compact message *before* it's pushed onto
    // `messageQueue`, i.e. long before the launcher ever dequeues it and
    // starts the REST call. So once that ack's DB write lands, every later
    // cancel request short-circuits on the hub side and never reaches the
    // CLI at all — this Set can only ever be populated during the brief
    // network round trip between the CLI emitting that ack and the hub
    // recording it, not while the compact REST call is actually running.
    // That's an existing characteristic of the hub's first-write-wins
    // queued-message protocol (present since Phase 1 of this feature, not
    // something this change introduced or is trying to fix — a hub-side
    // redesign of that protocol is out of scope here since it would affect
    // cancel behavior for every flavor, not just OpenCode /compact).
    //
    // Nothing here distinguishes "this localId was actually a /compact
    // message" from any other queued message whose cancel happened to land
    // in that race window — the fallback branch below has no way to know.
    // For a real /compact race, `isLocalIdCancelled` reads (and deletes) the
    // entry once `runCompactOperation` checks it; for anything else, the
    // entry would sit here unread for the rest of the process's life. Cap
    // the Set (oldest-first eviction, relying on Set's insertion-order
    // iteration) so a long-running session can't accumulate these forever —
    // realistically at most a handful of entries would ever coexist, so this
    // cap is a defensive bound, not something expected to trigger.
    const MAX_CANCELLED_DEQUEUED_LOCAL_IDS = 50;
    const cancelledDequeuedLocalIds = new Set<string>();
    const addCancelledDequeuedLocalId = (localId: string): void => {
        cancelledDequeuedLocalIds.add(localId);
        while (cancelledDequeuedLocalIds.size > MAX_CANCELLED_DEQUEUED_LOCAL_IDS) {
            const oldest = cancelledDequeuedLocalIds.values().next().value;
            if (oldest === undefined) break;
            cancelledDequeuedLocalIds.delete(oldest);
        }
    };

    let userMessageChain: Promise<void> = Promise.resolve();
    session.onUserMessage((message, localId) => {
        if (localId) preparingLocalIds.add(localId);
        userMessageChain = userMessageChain.then(async () => {
            const wasCancelled = (): boolean => {
                if (!localId) return false;
                return cancelledBeforeEnqueue.delete(localId);
            };
            const buildMode = (): OpencodeMode => ({
                permissionMode: currentPermissionMode,
                // Propagate null distinctly from undefined so the launcher can
                // tell "reset to default" (from `/model default`) apart from
                // "model unchanged".
                model: sessionModel,
                modelReasoningEffort: sessionModelReasoningEffort
            });
            const pushPlain = () => {
                const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
                messageQueue.push(formattedText, buildMode(), localId);
            };
            try {
                if (wasCancelled()) return;
                let text = message.content.text;
                const commands = await listSlashCommands('opencode', workingDirectory).catch(() => []);
                if (wasCancelled()) return;
                const slash = resolveOpencodeSlashCommand(text, {
                    commands,
                    permissionMode: currentPermissionMode,
                    model: sessionModel,
                    modelReasoningEffort: sessionModelReasoningEffort
                });

                if (slash.kind === 'compact') {
                    // `compactSupported` alone conflates two different
                    // situations: a genuinely local-mode session (compact
                    // fundamentally can't run — there's no ACP backend to
                    // run it against) versus a session that's already in
                    // remote mode but hasn't finished ACP initialize +
                    // session load/new yet (onCompactAvailabilityChange(true)
                    // hasn't fired *yet*, but will shortly). A hostile-review
                    // sweep found the old code treated both the same way —
                    // an immediate not-yet-supported reply — even though a
                    // regular prompt sent in that exact same startup window
                    // queues normally and just waits.
                    //
                    // `sessionWrapperRef.current?.mode` (not the `session`
                    // variable in this closure, which is the lower-level
                    // ApiSessionClient without a `mode` field) is the actual
                    // OpencodeSession instance's mode — 'local' | 'remote',
                    // synced synchronously by onModeChange before either
                    // launcher starts (see AgentSessionBase). `undefined`
                    // (not yet set) falls through to the safe
                    // not-yet-supported default below, same as genuinely
                    // local mode.
                    //
                    // `mode !== 'remote'` alone isn't enough, though:
                    // `mode` stays 'remote' for the *entire* teardown
                    // window too (it only flips back to 'local' once the
                    // whole remote launcher has fully unwound), so without
                    // also checking `compactTeardownInProgress`, this would
                    // re-open queuing during exactly the window
                    // onLeavingRemote() exists to protect — a hostile-review
                    // sweep found this the first time this branch checked
                    // `mode` alone (see compactTeardownInProgress's
                    // declaration comment for the full distinction).
                    if (!compactSupported && (sessionWrapperRef.current?.mode !== 'remote' || compactTeardownInProgress)) {
                        if (localId) {
                            session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                        }
                        session.sendAgentMessage({
                            type: 'message',
                            message: '/compact is not yet supported in HAPI OpenCode sessions.',
                            id: randomUUID()
                        });
                        sessionWrapperRef.current?.onThinkingChange(false);
                        return;
                    }
                    // No manual emitMessagesConsumed here (unlike the
                    // synchronous 'handled' branch below): `messageQueue`
                    // (== session.queue, wired in AgentSessionBase's
                    // constructor — see sessionBase.ts) already acks
                    // automatically at dequeue time via `onBatchConsumed`,
                    // exactly like any regular prompt — `collectBatch()` in
                    // MessageQueue2.ts calls it right after shifting an
                    // item off the queue, which for /compact happens in
                    // opencodeRemoteLauncher.ts's dequeue loop. An earlier
                    // version of this branch (from when /compact ran via a
                    // trigger function invoked directly from this chain,
                    // bypassing the queue entirely) called
                    // `session.emitMessagesConsumed([localId])` manually
                    // right here, before the item was even queued — that
                    // stopped mattering for FIFO ordering once /compact
                    // moved to `pushIsolated` below, but it kept firing the
                    // hub ack immediately regardless, which is what actually
                    // broke cancellation of an already-queued-but-not-yet-
                    // dequeued /compact: the hub marked it invoked the
                    // instant it was queued, so `cancelByLocalId` in
                    // `onCancelQueuedMessage` below always found it already
                    // gone from the queue and could never remove it before
                    // that premature ack landed. Removing the manual call
                    // lets the automatic dequeue-time ack (and therefore
                    // `messageQueue.cancelByLocalId`) work the same way it
                    // already does for prompts — a queued /compact can now
                    // actually be cancelled before opencodeRemoteLauncher.ts
                    // dequeues it and calls `runCompactOperation()`.
                    //
                    // pushIsolated (not push): must never batch with a
                    // sibling prompt, but must still occupy its real FIFO
                    // position relative to prompts already queued ahead of
                    // it.
                    messageQueue.pushIsolated('', { ...buildMode(), operation: 'compact' }, localId);
                    return;
                }

                if (slash.kind !== 'passthrough') {
                    if (slash.updates) {
                        if (slash.updates.permissionMode !== undefined) {
                            currentPermissionMode = slash.updates.permissionMode;
                        }
                        if (slash.updates.model !== undefined) {
                            sessionModel = slash.updates.model;
                        }
                        if (slash.updates.modelReasoningEffort !== undefined) {
                            sessionModelReasoningEffort = slash.updates.modelReasoningEffort;
                        }
                        syncSessionMode();
                    }
                    if (slash.kind === 'handled') {
                        // Ack the user's slash-command message before sending the
                        // agent reply. The web sorts the conversation by
                        // `invokedAt ?? createdAt` (web/src/lib/messages.ts), so
                        // stamping invokedAt first keeps the user prompt above
                        // the reply instead of below it. Pass
                        // `clearQueuedThinkingGrace` so the hub drops its 15s
                        // grace — this synchronous path never calls
                        // `onThinkingChange(true)`, so the next `thinking=false`
                        // keepalive must be honored immediately.
                        if (localId) {
                            session.emitMessagesConsumed([localId], { clearQueuedThinkingGrace: true });
                        }
                        if (slash.message) {
                            session.sendAgentMessage({
                                type: 'message',
                                message: slash.message,
                                id: randomUUID()
                            });
                        }
                        // Push a thinking=false keepalive immediately so the
                        // spinner clears without waiting for the next 2s tick.
                        // (The hub-side queued-thinking grace is dropped on
                        // messages-consumed above, so this keepalive is honored.)
                        sessionWrapperRef.current?.onThinkingChange(false);
                        return;
                    }
                    if (slash.message) {
                        session.sendAgentMessage({
                            type: 'message',
                            message: slash.message,
                            id: randomUUID()
                        });
                    }
                    text = slash.text;
                }

                const formattedText = formatMessageWithAttachments(text, message.content.attachments);
                messageQueue.push(formattedText, buildMode(), localId);
            } catch (error) {
                logger.debug('[opencode] Failed to handle user message', error);
                if (!wasCancelled()) {
                    pushPlain();
                }
            } finally {
                if (localId) {
                    preparingLocalIds.delete(localId);
                    cancelledBeforeEnqueue.delete(localId);
                }
            }
        }).catch((error) => {
            logger.debug('[opencode] User message handler chain failed', error);
        });
    });

    session.onCancelQueuedMessage((localId) => {
        const removedFromQueue = messageQueue.cancelByLocalId(localId);
        if (removedFromQueue) {
            logger.debug(`[opencode] cancelByLocalId(${localId}): removed from queue`);
            return true;
        }
        if (preparingLocalIds.has(localId)) {
            cancelledBeforeEnqueue.add(localId);
            logger.debug(`[opencode] cancelByLocalId(${localId}): marked for cancellation before enqueue`);
            return true;
        }
        // Not in the queue and not in the pre-enqueue preparing window. As
        // explained where `cancelledDequeuedLocalIds` is declared above, the
        // hub only calls this at all while its own row is still queued, so
        // reaching this branch means we're in the brief race between our
        // /compact ack (`emitMessagesConsumed`) being sent and the hub
        // recording it — not, as the name might suggest, the compact REST
        // call itself running. Remember it so the launcher can suppress the
        // result if that's what this turns out to be; harmless if it doesn't
        // match anything (just an unread entry that never gets consumed).
        // Return value is unchanged from before this tracking existed — we
        // don't actually know whether this cancelled anything real, so this
        // stays "best-effort: not found".
        addCancelledDequeuedLocalId(localId);
        logger.debug(`[opencode] cancelByLocalId(${localId}): not found in queue; marked in case it lands in the compact ack race window (best-effort)`);
        return false;
    });

    registerSessionConfigRpc<PermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'opencode',
        modelMode: 'nullable',
        modelReasoningEffortMode: 'nullable',
        onApply: (config) => {
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode;
            }
            if (config.model !== undefined) {
                sessionModel = config.model;
            }
            if (config.modelReasoningEffort !== undefined) {
                sessionModelReasoningEffort = config.modelReasoningEffort;
            }
        },
        onAfterApply: syncSessionMode
    });

    let crashed = false;
    const notifyHubModeChange = createModeChangeHandler(session);

    try {
        await opencodeLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined,
            modelReasoningEffort: sessionModelReasoningEffort,
            resumeSessionId: opts.resumeSessionId,
            hookServer,
            hookUrl,
            onModeChange: (mode) => {
                if (mode === 'remote') {
                    // A fresh remote entry is beginning (first-ever, or a
                    // local interlude ending) — whatever the previous
                    // remote attempt's teardown state was, it no longer
                    // applies. (The very first entry into remote mode,
                    // when `startingMode` is already 'remote', never calls
                    // onModeChange at all — see loopBase.ts — but this
                    // flag's initial `false` already covers that case.)
                    compactTeardownInProgress = false;
                }
                notifyHubModeChange(mode);
            },
            onReasoningEffortRollback: (effort) => {
                sessionModelReasoningEffort = effort;
            },
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            },
            onCompactAvailabilityChange: (available) => {
                compactSupported = available;
                if (!available) {
                    // onCompactAvailabilityChange(false) only ever fires
                    // from OpencodeRemoteLauncher's onLeavingRemote() (the
                    // old reset-on-next-local-entry was removed — see its
                    // declaration comment) — so reaching here always means
                    // "leaving remote", never "not ready yet".
                    compactTeardownInProgress = true;
                }
            },
            isLocalIdCancelled: (localId) => cancelledDequeuedLocalIds.delete(localId)
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[opencode] Loop error:', error);
    } finally {
        const localFailure = sessionWrapperRef.current?.localLaunchFailure;
        if (localFailure?.exitReason === 'exit') {
            lifecycle.setExitCode(1);
            lifecycle.setArchiveReason(`Local launch failed: ${localFailure.message.slice(0, 200)}`);
            lifecycle.setSessionEndReason('error');
        } else if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
