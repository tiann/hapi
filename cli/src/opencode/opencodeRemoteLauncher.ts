import React from 'react';
import { randomUUID } from 'node:crypto';
import { registerAcpSessionTitleSync } from '@/agent/acpSessionTitle';
import { logger } from '@/ui/logger';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';
import { convertAgentMessage } from '@/agent/messageConverter';
import type { AgentMessage, McpServerStdio, PromptContent } from '@/agent/types';
import { RemoteLauncherBase, type RemoteLauncherDisplayContext, type RemoteLauncherExitReason } from '@/modules/common/remote/RemoteLauncherBase';
import { OpencodeDisplay } from '@/ui/ink/OpencodeDisplay';
import type { OpencodeSession } from './session';
import type { OpencodeMode, PermissionMode } from './types';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import { allocateFreePort, createOpencodeBackend } from './utils/opencodeBackend';
import { fetchCompactionSummary, splitProviderModel, triggerOpencodeCompact } from './utils/opencodeCompactBridge';
import { OpencodePermissionHandler } from './utils/permissionHandler';
import { OPENCODE_NATIVE_TOOL_INSTRUCTION, PLAN_MODE_INSTRUCTION } from './utils/systemPrompt';
import { resolveThoughtLevelEffort } from './thoughtLevelEffort';

type OpencodeRemoteLauncherOptions = {
    onReasoningEffortRollback?: (effort: string | null) => void;
    // Called with `true` once the ACP backend + internal HTTP baseUrl are
    // ready (so /compact can actually run) and with `false` whenever this
    // session leaves remote mode. runOpencode.ts uses this to decide whether
    // a `/compact` message should be queued or immediately answered with a
    // "not yet supported" reply — see its `slash.kind === 'compact'` branch.
    onCompactAvailabilityChange?: (available: boolean) => void;
    // Consumes (delete-and-return) whether the queued item with this localId
    // was cancelled via runOpencode.ts's `onCancelQueuedMessage` fallback
    // branch (see the comment on `cancelledDequeuedLocalIds` there for what
    // that actually covers — in practice a narrow ack-vs-hub-DB-write race,
    // not "cancel while the REST call is running"). Checked once the REST
    // call (and summary lookup) settles, so a cancelled request's result
    // doesn't surface for an action the user no longer expects a reply from.
    isLocalIdCancelled?: (localId: string) => boolean;
};

export type AbortStatusDecision = {
    message: string;
    shouldClearThinking: boolean;
};

/**
 * Pure decision logic for handleAbort()'s final step: which status message
 * to show, and whether `thinking` should be cleared. Extracted out of the
 * method itself (which calls this with freshly re-read state, not a
 * snapshot from before its awaits — see the call site) so it's unit
 * testable without needing to observe `MessageBuffer`/Ink rendering, which
 * this file's test harness (`opencodeRemoteLauncher.test.ts`) has no
 * infrastructure for.
 *
 * A compact operation left deliberately running after a plain Stop (see
 * `compactResultSuppressed`'s field doc comment on the class) is the one
 * case where nothing has actually stopped yet — Stop alone cannot leave
 * this remote session, only switch-to-local/exit can, so the message says
 * so explicitly rather than leaving the user wondering why the UI still
 * looks busy.
 */
export function selectAbortStatusMessage(opts: {
    hasCompactInFlight: boolean;
    leavingRemote: boolean;
    compactAborted: boolean;
}): AbortStatusDecision {
    const compactStillWaiting = opts.hasCompactInFlight && !opts.leavingRemote && !opts.compactAborted;
    if (compactStillWaiting) {
        return {
            message: 'Stop requested — waiting for the in-progress compaction to finish on the server. Switch to local or exit to leave immediately.',
            shouldClearThinking: false
        };
    }
    return { message: 'Turn aborted', shouldClearThinking: true };
}

class OpencodeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: OpencodeSession;
    private backend: ReturnType<typeof createOpencodeBackend> | null = null;
    /** Loopback base URL of the OpenCode ACP subprocess's internal HTTP API, set once the backend is spawned with an explicit --port/--hostname. */
    private baseUrl: string | null = null;
    private permissionHandler: OpencodePermissionHandler | null = null;
    private happyServer: { stop: () => void } | null = null;
    private abortController = new AbortController();
    // Set by the dequeue loop as soon as a batch is identified as a
    // `operation:'compact'` one — deliberately *before* that batch's inline
    // model/effort switch runs, not only once runCompactOperation()'s
    // triggerOpencodeCompact() REST call actually starts (a hostile-review
    // sweep found that creating it any later left a window during that
    // switch — a real async ACP round-trip — where an abort had nothing to
    // act on yet). Null whenever no compact batch is in flight. Unlike
    // `abortController` above (which governs the dequeue loop's
    // wait-for-next-message signal), `handleAbort()` needs this to actually
    // interrupt the compact's HTTP call(s) — without it, Stop/switch-to-local
    // has no way to unblock a dequeued /compact whose REST call is
    // deliberately unbounded (see triggerOpencodeCompact's doc comment) and
    // the launcher stays wedged until it eventually settles on its own.
    private compactAbortController: AbortController | null = null;
    // True from the moment handleAbort() observes a compact operation in
    // flight until the dequeue loop creates the next one. A 6th PR-review
    // round found that unconditionally aborting `compactAbortController` on
    // *plain* Stop (not just switch/exit) broke a core invariant this
    // feature's whole redesign (see the FIFO-queue comment on the dequeue
    // loop) depends on: compact and a prompt must never touch the same
    // OpenCode session at once. Aborting only unblocks the *client's* fetch
    // — `session/update` notifications are a separate channel from that
    // HTTP request's lifecycle (see AcpSdkBackend.suppressUpdatesDuring's
    // doc comment), so the agent can still be compacting server-side well
    // after the client gives up, and the quiet-drain there (bounded at
    // ~1.2s) is not a real guarantee that a multi-minute server-side
    // compaction has actually finished. If the dequeue loop moved on to a
    // prompt as soon as the client-side abort settled, that prompt could
    // run concurrently with a compaction still touching the same session.
    //
    // The fix: plain Stop only sets this flag (suppressing the eventual
    // result) and leaves `compactAbortController` alone, so
    // runCompactOperation()'s own awaits keep blocking the dequeue loop
    // until the *real* HTTP response arrives — i.e. until the server
    // actually finishes. Switch-to-local/exit still abort the controller for
    // real (see handleAbort's `leavingRemote` parameter) because cleanup()
    // is about to disconnect the whole ACP subprocess regardless, so there's
    // no session left to protect.
    private compactResultSuppressed = false;
    private displayPermissionMode: PermissionMode | null = null;
    private instructionsSent = false;
    private currentBackendModel: string | null = null;
    private defaultBackendModel: string | null = null;
    private currentBackendEffort: string | null = null;
    private defaultBackendEffort: string | null = null;
    private setModelSupported: boolean | undefined = undefined;
    private setEffortSupported: boolean | undefined = undefined;

    constructor(
        session: OpencodeSession,
        private readonly options: OpencodeRemoteLauncherOptions = {}
    ) {
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

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            enableChangeTitle: false,
            skillLookup: { workingDirectory: session.path, flavor: 'opencode' }
        });
        this.happyServer = happyServer;

        // Pre-select a loopback port for the ACP subprocess's internal HTTP
        // API and pass it explicitly via --port/--hostname. opencode does not
        // announce the bound port anywhere (stdout/stderr/ACP responses) when
        // launched with --port 0, so HAPI must choose it up front to be able
        // to reach that HTTP API later (e.g. for /compact — see
        // opencodeCompactBridge.ts).
        const hostname = '127.0.0.1';
        const port = await allocateFreePort(hostname);
        this.baseUrl = `http://${hostname}:${port}`;

        const backend = createOpencodeBackend({
            cwd: session.path,
            port,
            hostname
        });
        this.backend = backend;
        registerAcpSessionTitleSync(backend, session.client);

        backend.onStderrError((error) => {
            logger.debug('[opencode-remote] stderr error', error);
            session.sendSessionEvent({ type: 'message', message: error.message });
            messageBuffer.addMessage(error.message, 'status');
        });

        await backend.initialize();

        const resumeSessionId = session.sessionId;
        const mcpServerList = toAcpMcpServers(mcpServers);
        let acpSessionId: string;
        if (resumeSessionId) {
            try {
                acpSessionId = await backend.loadSession({
                    sessionId: resumeSessionId,
                    cwd: session.path,
                    mcpServers: mcpServerList
                });
            } catch (error) {
                logger.warn('[opencode-remote] resume failed, starting new session', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'OpenCode resume failed; starting a new session.'
                });
                acpSessionId = await backend.newSession({
                    cwd: session.path,
                    mcpServers: mcpServerList
                });
            }
        } else {
            acpSessionId = await backend.newSession({
                cwd: session.path,
                mcpServers: mcpServerList
            });
        }
        session.onSessionFound(acpSessionId);

        // Seed currentBackendModel from the ACP session metadata so the first
        // batch — whose model the hub mirrors from the just-discovered session —
        // does not trigger a redundant setModel on the very first turn.
        const initialMetadata = backend.getSessionModelsMetadata?.(acpSessionId);
        this.currentBackendModel = initialMetadata?.currentModelId ?? null;
        this.defaultBackendModel = this.currentBackendModel;
        const thoughtLevelOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
        this.currentBackendEffort = thoughtLevelOption?.currentValue ?? null;
        this.defaultBackendEffort = this.currentBackendEffort;

        // Let the caller (runOpencode.ts) know native /compact can actually
        // run now that the ACP backend + internal HTTP baseUrl exist. The
        // dequeue loop below (not an externally-invoked trigger) is what
        // executes it, in its actual FIFO queue position.
        //
        // A 9th PR-review round found a race here: a terminal
        // switch-to-local/exit can land *during* the newSession/loadSession
        // await above (setupTerminal() wires up onExit/onSwitchToLocal
        // before runMainLoop() even starts, so this is reachable well
        // before setupAbortHandlers() below registers the RPC
        // 'abort'/'switch' handlers). RemoteLauncherBase.requestExit()
        // already fired onLeavingRemote() (availability(false)) and set
        // `this.shouldExit = true` synchronously for that switch/exit,
        // before awaiting its handler — but this line used to run
        // regardless once initialization finished, resurrecting
        // availability(true) even though the session is already on its way
        // out. runOpencode.ts's compactSupported/compactTeardownInProgress
        // gate treats compactSupported flipping true as reason enough to
        // ignore compactTeardownInProgress entirely (see that gate's doc
        // comment), so this stray true could let a /compact arriving right
        // after slip into the queue mid-teardown. Checking `shouldExit`
        // here — the same flag requestExit() already set — keeps
        // availability from ever un-flipping once a switch/exit is
        // underway.
        if (!this.shouldExit) {
            this.options.onCompactAvailabilityChange?.(true);
        }

        // Expose the cached models metadata via per-session RPC so the hub can
        // forward it to the web UI's model selector without round-tripping ACP.
        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListOpencodeModels, async () => {
            const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
            if (!metadata) {
                return { success: false, error: 'OpenCode model metadata is not available' };
            }
            return {
                success: true,
                availableModels: metadata.availableModels,
                currentModelId: metadata.currentModelId
            };
        });

        session.client.rpcHandlerManager.registerHandler(RPC_METHODS.ListOpencodeReasoningEffortOptions, async () => {
            const effortOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
            if (!effortOption) {
                return { success: false, error: 'OpenCode reasoning effort options are not available' };
            }
            return {
                success: true,
                options: effortOption.options,
                currentValue: effortOption.currentValue ?? null
            };
        });

        this.permissionHandler = new OpencodePermissionHandler(
            session.client,
            backend,
            () => session.getPermissionMode() as PermissionMode | undefined
        );
        this.applyDisplayMode(session.getPermissionMode() as PermissionMode);

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            // Explicit `false`: plain Stop stays in this remote session, so
            // an in-flight compact must not be aborted client-side — see
            // handleAbort's `leavingRemote` doc comment.
            onAbort: () => this.handleAbort(false),
            onSwitch: () => this.handleSwitchRequest()
        });

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        while (!this.shouldExit) {
            const waitSignal = this.abortController.signal;
            const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
            if (!batch) {
                if (waitSignal.aborted && !this.shouldExit) {
                    continue;
                }
                break;
            }

            // Created here — before the model/effort switch below — rather
            // than inside runCompactOperation(), so it already exists for
            // handleAbort() to act on during that switch. backend.setModel()/
            // setConfigOption() are real async ACP round-trips that yield to
            // the event loop; a hostile-review whole-feature sweep found
            // that an abort landing in that window used to hit a still-null
            // compactAbortController (a no-op) and then get silently
            // forgotten once runCompactOperation() created a *fresh*
            // controller afterward — the compact's unbounded REST call would
            // then run to completion with no way to interrupt it, despite
            // the user having already pressed Stop/switch/exit.
            const isCompactBatch = batch.mode.operation === 'compact';
            const compactAbortController = isCompactBatch ? new AbortController() : null;
            if (compactAbortController) {
                this.compactAbortController = compactAbortController;
                // Reset here (as early as the controller itself — see its
                // sibling field's doc comment for why that timing matters)
                // rather than inside runCompactOperation(), so a plain Stop
                // landing during the model/effort switch below already has
                // something to suppress.
                this.compactResultSuppressed = false;
            }

            // Inline model change via ACP RPC (session/set_model — see ACP SDK
            // schema `x-method: session/set_model`). Mirrors the Gemini pattern
            // from PR #543: if the running OpenCode build does not implement the
            // RPC, we learn that from the first method-not-found response and stop
            // attempting it for the rest of this session.
            //
            // `batch.mode.model` semantics: a string is a specific model id;
            // `null` means "reset to whatever model the backend launched with"
            // (emitted by `/model default`); `undefined` means "no change".
            const requestedModel = batch.mode.model === null
                ? this.defaultBackendModel
                : batch.mode.model;
            // The very first batch seeds currentBackendModel — the OpenCode CLI was
            // launched with that model via --model and there is nothing to switch yet.
            if (requestedModel && this.currentBackendModel === null) {
                this.currentBackendModel = requestedModel;
            } else if (requestedModel && requestedModel !== this.currentBackendModel) {
                if (!backend.setModel || this.setModelSupported === false) {
                    batch.mode.model = this.currentBackendModel ?? undefined;
                } else {
                    logger.debug(`[opencode-remote] Switching model inline: ${this.currentBackendModel} -> ${requestedModel}`);
                    try {
                        await backend.setModel(acpSessionId, requestedModel, { flavor: 'opencode' });
                        this.currentBackendModel = requestedModel;
                        this.setModelSupported = true;
                        // Reflect the resolved model back into the batch so
                        // downstream display logic sees the concrete id rather
                        // than a `null` placeholder.
                        batch.mode.model = requestedModel;
                    } catch (error) {
                        const message = error instanceof Error ? error.message : String(error);
                        const methodNotFound = /method not found/i.test(message);
                        if (methodNotFound && this.setModelSupported === undefined) {
                            this.setModelSupported = false;
                            logger.warn('[opencode-remote] OpenCode build does not support session/set_model; inline switching disabled for this session');
                            session.sendSessionEvent({
                                type: 'message',
                                message: 'This OpenCode build does not support inline model switching. Restart the session to apply a different model.'
                            });
                        } else {
                            logger.warn('[opencode-remote] Inline model switch failed', error);
                            session.sendSessionEvent({
                                type: 'message',
                                message: `Failed to switch model to ${requestedModel}. Continuing with ${this.currentBackendModel ?? '(default)'}.`
                            });
                        }
                        batch.mode.model = this.currentBackendModel ?? undefined;
                    }
                }
            }

            const requestedEffort = batch.mode.modelReasoningEffort ?? this.defaultBackendEffort;
            if (requestedEffort && requestedEffort !== this.currentBackendEffort) {
                const thoughtLevelOption = backend.getThoughtLevelConfigOption?.(acpSessionId);
                if (!backend.setConfigOption || !thoughtLevelOption || this.setEffortSupported === false) {
                    this.rollbackReasoningEffort(batch, this.currentBackendEffort);
                } else {
                    const resolvedEffort = resolveThoughtLevelEffort(
                        requestedEffort,
                        thoughtLevelOption,
                        this.currentBackendEffort ?? this.defaultBackendEffort
                    );
                    if (!resolvedEffort || resolvedEffort === this.currentBackendEffort) {
                        if (requestedEffort !== resolvedEffort) {
                            logger.warn(
                                `[opencode-remote] Unsupported reasoning effort "${requestedEffort}"; continuing with ${resolvedEffort ?? this.currentBackendEffort ?? '(default)'}`
                            );
                            this.rollbackReasoningEffort(batch, resolvedEffort ?? this.currentBackendEffort);
                        }
                    } else {
                        logger.debug(`[opencode-remote] Switching effort inline: ${this.currentBackendEffort ?? '(default)'} -> ${resolvedEffort}`);
                        try {
                            await backend.setConfigOption(acpSessionId, thoughtLevelOption.id, resolvedEffort);
                            this.currentBackendEffort = resolvedEffort;
                            this.setEffortSupported = true;
                            if (requestedEffort !== resolvedEffort) {
                                this.rollbackReasoningEffort(batch, resolvedEffort);
                            }
                        } catch (error) {
                            const message = error instanceof Error ? error.message : String(error);
                            const methodNotFound = /method not found/i.test(message);
                            if (methodNotFound && this.setEffortSupported === undefined) {
                                this.setEffortSupported = false;
                                logger.warn('[opencode-remote] OpenCode build does not support session/set_config_option; inline effort switching disabled for this session');
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: 'This OpenCode build does not support inline reasoning effort switching.'
                                });
                            } else {
                                logger.warn('[opencode-remote] Inline effort switch failed', error);
                                session.sendSessionEvent({
                                    type: 'message',
                                    message: `Failed to switch reasoning effort to ${resolvedEffort}. Continuing with ${this.currentBackendEffort ?? '(default)'}.`
                                });
                            }
                            this.rollbackReasoningEffort(batch, this.currentBackendEffort);
                        }
                    }
                }
            }

            this.applyDisplayMode(batch.mode.permissionMode);
            messageBuffer.addMessage(batch.message, 'user');

            // /compact reaches here through the exact same dequeue loop as
            // any prompt — it was pushed via messageQueue.pushIsolated(...)
            // in runOpencode.ts, so it occupies its real FIFO position
            // relative to prompts queued before or after it (fixes a prior
            // design where /compact ran via an externally-invoked trigger
            // and could execute ahead of an already-queued prompt). The
            // model/effort switch above already ran for this batch just like
            // any other, so compaction runs under whatever model this batch
            // resolved to.
            if (isCompactBatch && compactAbortController) {
                // A compact batch is always a single isolated item (pushed
                // via pushIsolated), so its own localId is exactly
                // batch.items[0]?.localId.
                const compactLocalId = batch.items[0]?.localId;

                // A 7th PR-review round found that a plain Stop landing
                // *during the model/effort switch above* — before this
                // compact's REST request has ever actually been sent — was
                // silently ignored here. Plain Stop's handleAbort(false) only
                // sets `compactResultSuppressed = true`; it deliberately
                // leaves compactAbortController.signal alone (see that
                // field's doc comment — Round 6 needs the real HTTP request
                // to keep running so the dequeue loop can wait for genuine
                // server-side completion). But that logic assumed a request
                // was already in flight to wait for. Here, mid-switch, none
                // has been sent yet — so this branch used to call
                // runCompactOperation() unconditionally once the switch
                // resolved anyway, starting a brand new REST request the
                // instant a cancelled compact's turn came up and blocking
                // the dequeue loop for however long that takes.
                //
                // The fix is narrow on purpose: skip starting the operation
                // only when a plain Stop landed (compactResultSuppressed)
                // AND the controller was never actually aborted. If the
                // controller WAS aborted, that means switch/exit's
                // handleAbort(true) ran instead — and Round 5's test
                // (below) established that runCompactOperation() must still
                // be called in that case, threading the pre-aborted signal
                // through so the fetch call rejects immediately without any
                // network I/O, rather than being skipped here.
                //
                // An 8th PR-review round found this same reasoning also
                // applies to isLocalIdCancelled, which round 7 had
                // deliberately left out of this check (see runOpencode.ts's
                // preparingLocalIds/cancelledBeforeEnqueue doc comment for
                // the full mechanism): the localId-keyed cancel Set it reads
                // can *only* ever be populated during the brief network
                // round trip between the CLI emitting the /compact item's
                // "invoked" ack and the hub recording it — never while a
                // compact REST call is actually running. So if
                // isLocalIdCancelled(compactLocalId) is already true here,
                // that unconditionally means this compact was cancelled
                // before its REST request was ever sent, exactly like the
                // compactResultSuppressed case above — there's no
                // in-flight server-side work to preserve by starting the
                // operation anyway. (isLocalIdCancelled is a delete-and-
                // return, one-shot callback, so checking it here consumes
                // the same entry runCompactOperation()'s own isCancelled()
                // would otherwise have consumed — it isn't checked twice.)
                const compactCancelledByLocalId = compactLocalId
                    ? (this.options.isLocalIdCancelled?.(compactLocalId) ?? false)
                    : false;
                const cancelledBeforeStart =
                    (this.compactResultSuppressed && !compactAbortController.signal.aborted)
                    || compactCancelledByLocalId;
                if (cancelledBeforeStart) {
                    if (this.compactAbortController === compactAbortController) {
                        this.compactAbortController = null;
                    }
                    // A 10th PR-review round found this skip path never
                    // calls session.onThinkingChange(true) (that's the
                    // whole point of skipping) but also never told the hub
                    // this queued item is done, leaving the web UI spinner
                    // stuck: markMessageQueued's 15s "queued thinking"
                    // grace (hub/src/sync/sessionCache.ts) keeps thinking
                    // pinned true regardless of keepalives until either the
                    // grace expires or a messages-consumed ack with
                    // `clearQueuedThinkingGrace` arrives. Same situation,
                    // same fix, as the synchronous slash.kind === 'handled'
                    // path in runOpencode.ts (e.g. /model — see its
                    // `clearQueuedThinkingGrace` comment there): ack with
                    // the grace-clearing flag, then push an immediate
                    // thinking=false keepalive so the spinner clears
                    // without waiting on the grace. (This is on top of, not
                    // instead of, the queue's own unflagged
                    // onBatchConsumed ack — a second ack for an
                    // already-invoked localId is a no-op on the hub's
                    // first-write-wins queued-message protocol, and
                    // clearQueuedThinkingGrace itself is keyed by session,
                    // not by localId, so it's idempotent too.)
                    if (compactLocalId) {
                        session.client.emitMessagesConsumed([compactLocalId], { clearQueuedThinkingGrace: true });
                    }
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        sendReady();
                    }
                    continue;
                }

                session.onThinkingChange(true);
                try {
                    await this.runCompactOperation(acpSessionId, compactAbortController, compactLocalId);
                } finally {
                    session.onThinkingChange(false);
                    if (session.queue.size() === 0 && !this.shouldExit) {
                        sendReady();
                    }
                }
                continue;
            }

            // Inject title instructions on first prompt
            let messageText = batch.message;
            if (batch.mode.permissionMode === 'plan') {
                messageText = `${PLAN_MODE_INSTRUCTION}\n\n${messageText}`;
            }
            if (!this.instructionsSent) {
                messageText = `${OPENCODE_NATIVE_TOOL_INSTRUCTION}\n\n${messageText}`;
                this.instructionsSent = true;
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: messageText
            }];

            session.onThinkingChange(true);

            try {
                await backend.prompt(acpSessionId, promptContent, (message: AgentMessage) => {
                    this.handleAgentMessage(message);
                });
                void backend.refreshSessionInfo(acpSessionId, session.path);
            } catch (error) {
                logger.warn('[opencode-remote] prompt failed', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'OpenCode prompt failed. Check logs for details.'
                });
                messageBuffer.addMessage('OpenCode prompt failed', 'status');
            } finally {
                session.onThinkingChange(false);
                await this.permissionHandler?.cancelAll('Prompt finished');
                if (session.queue.size() === 0 && !this.shouldExit) {
                    sendReady();
                }
            }
        }
    }

    /**
     * /compact must stop being offered the instant remote mode starts
     * leaving — not merely by the time it's actually torn down, and
     * critically not only on the *next* local-mode entry (the previous
     * mechanism, in loop.ts's `runLocal:` callback). That gap between "a
     * switch/exit was requested" and "the next runLocal() call reset this"
     * is exactly the window a PR-review round found: a /compact slash
     * command arriving in it still queues normally (runOpencode.ts's
     * `compactSupported` flag hadn't flipped yet), and since local mode
     * immediately hands back to remote when it finds a non-empty queue, that
     * queued compact can end up running anyway — despite the user having
     * already asked to leave remote mode. See onLeavingRemote()'s doc
     * comment on RemoteLauncherBase for exactly when this fires.
     */
    protected onLeavingRemote(): void {
        this.options.onCompactAvailabilityChange?.(false);
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.permissionHandler) {
            await this.permissionHandler.cancelAll('Session ended');
            this.permissionHandler = null;
        }

        if (this.backend) {
            await this.backend.disconnect();
            this.backend = null;
        }

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }
    }

    private rollbackReasoningEffort(batch: { mode: OpencodeMode }, effort: string | null): void {
        batch.mode.modelReasoningEffort = effort;
        this.session.setModelReasoningEffort(effort);
        this.session.pushKeepAlive();
        this.options.onReasoningEffortRollback?.(effort);
    }

    /**
     * Executes the /compact operation for a queued `operation:'compact'`
     * batch. Reached only through the main dequeue loop (so it never runs
     * concurrently with a prompt turn — see the loop's doc comment), which
     * is also why this needs no timeout/mutex of its own despite the REST
     * call it makes potentially taking several minutes.
     *
     * `localId` is used to detect a cancel that runOpencode.ts's
     * `isLocalIdCancelled` reports for this item (see its declaration there
     * for the real — and narrow — race window that covers) — checked at each
     * point below right before a result would be shown, same as the
     * pre-redesign behavior where this was a single `wasCancelled()` check
     * after one combined async trigger(). "Compaction started" itself is
     * never suppressed (it wasn't before either).
     *
     * Separately, `compactAbortController`/`compactResultSuppressed` cover a
     * different case: Stop/switch-to-local firing *while the REST call is
     * actually in flight*, which `isLocalIdCancelled` cannot — that
     * mechanism only ever observes a cancel for this item's *queue message*,
     * and by this point the item has already been dequeued. `isCancelled()`
     * below checks all three, so any kind of cancellation suppresses the
     * eventual result the same way — but only switch/exit (`leavingRemote`
     * in handleAbort()) actually aborts `compactAbortController.signal`; a
     * plain Stop sets `compactResultSuppressed` alone and deliberately
     * leaves the signal un-aborted, so this function's own awaits below keep
     * blocking the dequeue loop until the operation *really* finishes
     * server-side — see `compactResultSuppressed`'s field doc comment for
     * why that invariant matters.
     *
     * `compactAbortController` is created by the caller (the dequeue loop),
     * not here, and passed in — deliberately, before the loop's model/effort
     * switch for this batch runs, not after. A hostile-review whole-feature
     * sweep found that creating it in here (i.e. only once this function was
     * actually entered) left a window during that switch — a real async ACP
     * round-trip — where an abort had nothing to act on yet (`this
     * .compactAbortController` was still null) and was silently lost by the
     * time this function created a *fresh* controller afterward.
     */
    private async runCompactOperation(
        acpSessionId: string,
        compactAbortController: AbortController,
        localId?: string
    ): Promise<void> {
        const session = this.session;
        session.sendSessionEvent({ type: 'message', message: '📦 Compaction started' });

        try {
            const isCancelled = (): boolean =>
                (localId ? (this.options.isLocalIdCancelled?.(localId) ?? false) : false)
                || compactAbortController.signal.aborted
                || this.compactResultSuppressed;

            const backend = this.backend;
            const baseUrl = this.baseUrl;
            if (!baseUrl || !backend) {
                if (!isCancelled()) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: '📦 Compaction failed: OpenCode internal HTTP API base URL is not available.'
                    });
                }
                return;
            }

            const metadata = backend.getSessionModelsMetadata?.(acpSessionId);
            const split = splitProviderModel(metadata?.currentModelId ?? this.currentBackendModel);
            if (!split) {
                if (!isCancelled()) {
                    session.sendSessionEvent({
                        type: 'message',
                        message: '📦 Compaction failed: OpenCode model metadata is not available; cannot determine provider/model for compaction.'
                    });
                }
                return;
            }

            // Suppressed: OpenCode keeps streaming session/update notifications
            // (agent_thought_chunk etc.) over the ACP transport while this raw
            // HTTP call runs — with no prompt() turn in flight to own them, they
            // would otherwise leak into the previous turn's still-installed
            // onUpdate and render as a duplicate assistant message alongside the
            // explicit summary we show below (from fetchCompactionSummary).
            // See AcpSdkBackend.suppressUpdatesDuring's doc comment.
            //
            // `signal` lets handleAbort() interrupt this specific call (see
            // compactAbortController's field doc comment) — triggerOpencodeCompact
            // otherwise has no deadline by design, since a real compaction can
            // legitimately take minutes.
            const result = await backend.suppressUpdatesDuring(() => triggerOpencodeCompact({
                baseUrl,
                sessionId: acpSessionId,
                providerId: split.providerId,
                modelId: split.modelId,
                signal: compactAbortController.signal
            }));
            if (!result.ok) {
                if (!isCancelled()) {
                    session.sendSessionEvent({ type: 'message', message: `📦 Compaction failed: ${result.error}` });
                } else {
                    logger.debug('[opencode-remote] /compact failure suppressed: cancelled or aborted before it resolved');
                }
                return;
            }

            // Best-effort: fetch the actual summary text OpenCode generated
            // before the final cancellation check, so a cancel landing anywhere
            // during this whole operation (REST call or summary lookup)
            // suppresses "Compaction completed" and the Reasoning block
            // together — this mirrors the pre-redesign behavior, where both were
            // produced by one combined async step checked once. `signal` is
            // required on this call (see OpencodeCompactCallOpts) for exactly
            // the reason a prior PR-review round flagged as missing here: the
            // POST above being interruptible isn't enough on its own if this
            // GET can still block Stop/switch-to-local for as long as it takes.
            const summary = await fetchCompactionSummary({ baseUrl, sessionId: acpSessionId, signal: compactAbortController.signal });

            if (isCancelled()) {
                logger.debug('[opencode-remote] /compact result suppressed: cancelled or aborted before it resolved');
                return;
            }

            session.sendSessionEvent({ type: 'message', message: '📦 Compaction completed' });
            if (summary.found) {
                const converted = convertAgentMessage({ type: 'reasoning', text: summary.text, id: randomUUID() });
                if (converted) {
                    session.sendAgentMessage(converted);
                }
            }
        } finally {
            // Defensive: only clear if this is still the controller we set —
            // mirrors the same "don't clobber a newer value" guard as
            // AcpSdkBackend.suppressUpdatesDuring's restore. In practice this
            // is always still the same instance, since compact runs
            // serialized through the single dequeue loop (never concurrently
            // with another runCompactOperation call).
            if (this.compactAbortController === compactAbortController) {
                this.compactAbortController = null;
            }
        }
    }

    private handleAgentMessage(message: AgentMessage): void {
        const converted = convertAgentMessage(message);
        if (converted) {
            this.session.sendAgentMessage(converted);
        }

        switch (message.type) {
            case 'text':
                this.messageBuffer.addMessage(message.text, 'assistant');
                break;
            case 'reasoning':
                if (message.live) {
                    break;
                }
                this.messageBuffer.addMessage(`[Thinking] ${message.text.substring(0, 100)}...`, 'system');
                break;
            case 'tool_call':
                this.messageBuffer.addMessage(`Tool call: ${message.name}`, 'tool');
                break;
            case 'tool_result':
                this.messageBuffer.addMessage('Tool result received', 'result');
                break;
            case 'usage':
                break;
            case 'plan':
                this.messageBuffer.addMessage('Plan updated', 'status');
                break;
            case 'error':
                this.messageBuffer.addMessage(message.message, 'status');
                break;
            case 'turn_complete':
                this.messageBuffer.addMessage('Turn complete', 'status');
                break;
            default: {
                const _exhaustive: never = message;
                return _exhaustive;
            }
        }
    }

    private applyDisplayMode(permissionMode: PermissionMode | undefined): void {
        if (permissionMode && permissionMode !== this.displayPermissionMode) {
            this.displayPermissionMode = permissionMode;
            this.messageBuffer.addMessage(`[MODE:${permissionMode}]`, 'system');
        }
    }

    /**
     * `leavingRemote` distinguishes plain Stop (`false`, the default — stays
     * in the same remote session) from switch-to-local/exit (`true` — the
     * session is being torn down). A 6th PR-review round rejected an earlier
     * fix (always aborting `compactAbortController` here) because it broke
     * this feature's core invariant: compact and a prompt must never touch
     * the same OpenCode session concurrently (see
     * `compactResultSuppressed`'s field doc comment for the full
     * reasoning). Plain Stop now only suppresses the eventual result and
     * leaves the compact operation's REST call running for real — the
     * dequeue loop stays blocked on it until the server actually finishes,
     * exactly as it does for an un-aborted turn. Switch/exit still abort it
     * for real: `cleanup()` disconnects the whole ACP subprocess right
     * after, so there is no shared-session invariant left to protect and
     * responsiveness (fixed in an earlier round) matters more.
     */
    private async handleAbort(leavingRemote = false): Promise<void> {
        // A hostile-review sweep found that a plain Stop during an in-flight
        // compact — which deliberately leaves the operation running for real
        // (see compactResultSuppressed's doc comment) — still unconditionally
        // flipped `thinking` off and reported "Turn aborted" below, telling
        // the user the turn had stopped while the dequeue loop was actually
        // still blocked inside runCompactOperation() for however long the
        // real server-side compaction takes (potentially minutes). Track
        // that specific case so the messaging stays honest: nothing has
        // actually stopped yet from the user's perspective, and the dequeue
        // loop's own `finally` (once runCompactOperation() genuinely
        // returns) remains the sole source of truth for when this turn is
        // done.
        const compactAbortController = this.compactAbortController;
        if (compactAbortController) {
            this.compactResultSuppressed = true;
            if (leavingRemote) {
                compactAbortController.abort();
            }
        }
        const backend = this.backend;
        if (backend && this.session.sessionId) {
            await backend.cancelPrompt(this.session.sessionId);
        }
        await this.permissionHandler?.cancelAll('User aborted');
        this.session.queue.reset();
        this.abortController.abort();
        this.abortController = new AbortController();
        // Re-read here (not the snapshot taken above, before the awaits) in
        // case a concurrent leavingRemote=true call for the same compact
        // interleaved with this one and already aborted it — RPC dispatch
        // doesn't serialize handleAbort() calls against each other, so a
        // Stop immediately followed by a switch-to-local can genuinely
        // overlap. Without this, the (now-stale) plain-Stop continuation
        // could append its "still waiting" message after the switch's
        // "Turn aborted" already ran, showing the two in a confusing order.
        const decision = selectAbortStatusMessage({
            hasCompactInFlight: compactAbortController !== null,
            leavingRemote,
            compactAborted: compactAbortController?.signal.aborted ?? false
        });
        if (decision.shouldClearThinking) {
            this.session.onThinkingChange(false);
        }
        this.messageBuffer.addMessage(decision.message, 'status');
    }

    private async handleExitFromUi(): Promise<void> {
        await this.requestExit('exit', () => this.handleAbort(true));
    }

    private async handleSwitchFromUi(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort(true));
    }

    private async handleSwitchRequest(): Promise<void> {
        await this.requestExit('switch', () => this.handleAbort(true));
    }
}

function toAcpMcpServers(config: Record<string, { command: string; args: string[] }>): McpServerStdio[] {
    return Object.entries(config).map(([name, entry]) => ({
        name,
        command: entry.command,
        args: entry.args,
        env: []
    }));
}

export async function opencodeRemoteLauncher(
    session: OpencodeSession,
    options: OpencodeRemoteLauncherOptions = {}
): Promise<'switch' | 'exit'> {
    const launcher = new OpencodeRemoteLauncher(session, options);
    return launcher.launch();
}
