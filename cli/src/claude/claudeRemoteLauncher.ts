import React from "react";
import { Session } from "./session";
import { RemoteModeDisplay } from "@/ui/ink/RemoteModeDisplay";
import { claudeRemote } from "./claudeRemote";
import { PermissionHandler } from "./utils/permissionHandler";
import { Future } from "@/utils/future";
import { SDKAssistantMessage, SDKMessage, SDKUserMessage } from "./sdk";
import { formatClaudeMessageForInk } from "@/ui/messageFormatterInk";
import { logger } from "@/ui/logger";
import { SDKToLogConverter } from "./utils/sdkToLogConverter";
import { PLAN_FAKE_REJECT } from "./sdk/prompts";
import { EnhancedMode } from "./loop";
import { OutgoingMessageQueue } from "./utils/OutgoingMessageQueue";
import type { ClaudePermissionMode } from "@hapi/protocol/types";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from "@/modules/common/remote/RemoteLauncherBase";

interface PermissionsField {
    date: number;
    result: 'approved' | 'denied';
    mode?: ClaudePermissionMode;
    allowedTools?: string[];
}

// If claudeRemote() throws before it ever reaches onReady (spawn failure,
// invalid model/args, auth failure, resume-anchor rejection, ...), the failure
// is almost certainly deterministic: respawning immediately just repeats the
// same failure. MAX_IMMEDIATE_RESPAWN_FAILURES caps consecutive such failures
// before this loop drops the message that keeps triggering them instead of
// respawning forever, and getRespawnBackoffMs() paces the retries in between.
// The streak resets whenever an attempt reaches onReady, or once the message
// is dropped, so a later unrelated failure gets its own fresh budget. Only
// the one message is given up on -- the session/process itself is not ended.
const MAX_IMMEDIATE_RESPAWN_FAILURES = 3;

function getRespawnBackoffMs(): number {
    const raw = process.env.CLAUDE_REMOTE_RESPAWN_BACKOFF_MS;
    if (raw === undefined) return 1000;
    const parsed = Number.parseInt(raw, 10);
    if (Number.isNaN(parsed) || parsed < 0) return 1000;
    return parsed;
}

class ClaudeRemoteLauncher extends RemoteLauncherBase {
    private readonly session: Session;
    private abortController: AbortController | null = null;
    private abortFuture: Future<void> | null = null;
    private permissionHandler: PermissionHandler | null = null;
    private handleSessionFound: ((sessionId: string) => void) | null = null;

    constructor(session: Session) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(RemoteModeDisplay, context);
    }

    private async abort(): Promise<void> {
        if (this.abortController && !this.abortController.signal.aborted) {
            this.abortController.abort();
        }
        await this.abortFuture?.promise;
    }

    // Waits for `ms`, but resolves early if `signal` aborts -- mirrors
    // cursorLegacyRemoteLauncher.transientBackoff (single completion path so
    // the abort listener is always removed, whether the timer or the abort
    // wins) so a user-initiated switch/exit during the respawn backoff isn't
    // stuck waiting out the full delay.
    private async respawnBackoff(ms: number, signal: AbortSignal): Promise<void> {
        if (ms <= 0 || signal.aborted) return;
        await new Promise<void>((resolve) => {
            let timer: ReturnType<typeof setTimeout> | null = null;
            const finish = () => {
                if (timer !== null) {
                    clearTimeout(timer);
                    timer = null;
                }
                signal.removeEventListener('abort', finish);
                resolve();
            };
            timer = setTimeout(finish, ms);
            signal.addEventListener('abort', finish, { once: true });
        });
    }

    private async handleAbortRequest(): Promise<void> {
        logger.debug('[remote]: doAbort');
        await this.abort();
    }

    private async handleSwitchRequest(): Promise<void> {
        logger.debug('[remote]: doSwitch');
        await this.requestExit('switch', async () => {
            await this.abort();
        });
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[remote]: Exiting client via Ctrl-C');
        await this.requestExit('exit', async () => {
            await this.abort();
        });
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[remote]: Switching to local mode via double space');
        await this.handleSwitchRequest();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        logger.debug('[claudeRemoteLauncher] Starting remote launcher');
        logger.debug(`[claudeRemoteLauncher] TTY available: ${this.hasTTY}`);

        const session = this.session;
        const messageBuffer = this.messageBuffer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbortRequest(),
            onSwitch: () => this.handleSwitchRequest()
        });

        const permissionHandler = new PermissionHandler(session);
        this.permissionHandler = permissionHandler;

        const messageQueue = new OutgoingMessageQueue(
            (logMessage) => session.client.sendClaudeSessionMessage(logMessage)
        );

        permissionHandler.setOnPermissionRequest((toolCallId: string) => {
            messageQueue.releaseToolCall(toolCallId);
        });

        const sdkToLogConverter = new SDKToLogConverter({
            sessionId: session.sessionId || 'unknown',
            cwd: session.path,
            version: process.env.npm_package_version,
            selectedModel: session.getModel()
        }, permissionHandler.getResponses());

        const handleSessionFound = (sessionId: string) => {
            sdkToLogConverter.updateSessionId(sessionId);
        };
        this.handleSessionFound = handleSessionFound;
        session.addSessionFoundCallback(handleSessionFound);

        let planModeToolCalls = new Set<string>();
        let ongoingToolCalls = new Map<string, { parentToolCallId: string | null }>();

        function onMessage(message: SDKMessage) {
            formatClaudeMessageForInk(message, messageBuffer);
            permissionHandler.onMessage(message);

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && (c.name === 'exit_plan_mode' || c.name === 'ExitPlanMode')) {
                            logger.debug('[remote]: detected plan mode tool call ' + c.id!);
                            planModeToolCalls.add(c.id! as string);
                        }
                    }
                }
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use') {
                            logger.debug('[remote]: detected tool use ' + c.id! + ' parent: ' + umessage.parent_tool_use_id);
                            ongoingToolCalls.set(c.id!, { parentToolCallId: umessage.parent_tool_use_id ?? null });
                        }
                    }
                }
            }
            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            ongoingToolCalls.delete(c.tool_use_id);
                            messageQueue.releaseToolCall(c.tool_use_id);
                        }
                    }
                }
            }

            let msg = message;

            if (message.type === 'user') {
                let umessage = message as SDKUserMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    msg = {
                        ...umessage,
                        message: {
                            ...umessage.message,
                            content: umessage.message.content.map((c) => {
                                if (c.type === 'tool_result' && c.tool_use_id && planModeToolCalls.has(c.tool_use_id!)) {
                                    if (c.content === PLAN_FAKE_REJECT) {
                                        logger.debug('[remote]: hack plan mode exit');
                                        logger.debugLargeJson('[remote]: hack plan mode exit', c);
                                        return {
                                            ...c,
                                            is_error: false,
                                            content: 'Plan approved',
                                            mode: c.mode
                                        };
                                    } else {
                                        return c;
                                    }
                                }
                                return c;
                            })
                        }
                    };
                }
            }

            const logMessage = sdkToLogConverter.convert(msg);
            if (logMessage) {
                if (logMessage.type === 'user' && logMessage.message?.content) {
                    const content = Array.isArray(logMessage.message.content)
                        ? logMessage.message.content
                        : [];

                    for (let i = 0; i < content.length; i++) {
                        const c = content[i];
                        if (c.type === 'tool_result' && c.tool_use_id) {
                            const responses = permissionHandler.getResponses();
                            const response = responses.get(c.tool_use_id);

                            if (response) {
                                const permissions: PermissionsField = {
                                    date: response.receivedAt || Date.now(),
                                    result: response.approved ? 'approved' : 'denied'
                                };

                                if (response.mode) {
                                    permissions.mode = response.mode;
                                }

                                if (response.allowTools && response.allowTools.length > 0) {
                                    permissions.allowedTools = response.allowTools;
                                }

                                content[i] = {
                                    ...c,
                                    permissions
                                };
                            }
                        }
                    }
                }

                if (logMessage.type === 'assistant' && message.type === 'assistant') {
                    const assistantMsg = message as SDKAssistantMessage;
                    const toolCallIds: string[] = [];

                    if (assistantMsg.message.content && Array.isArray(assistantMsg.message.content)) {
                        for (const block of assistantMsg.message.content) {
                            if (block.type === 'tool_use' && block.id) {
                                toolCallIds.push(block.id);
                            }
                        }
                    }

                    if (toolCallIds.length > 0) {
                        const isSidechain = assistantMsg.parent_tool_use_id !== undefined;

                        if (!isSidechain) {
                            messageQueue.enqueue(logMessage, {
                                delay: 250,
                                toolCallIds
                            });
                            return;
                        }
                    }
                }

                messageQueue.enqueue(logMessage);
            }

            if (message.type === 'assistant') {
                let umessage = message as SDKAssistantMessage;
                if (umessage.message.content && Array.isArray(umessage.message.content)) {
                    for (let c of umessage.message.content) {
                        if (c.type === 'tool_use' && c.name === 'Task' && c.input && typeof (c.input as any).prompt === 'string') {
                            const logMessage2 = sdkToLogConverter.convertSidechainUserMessage(c.id!, (c.input as any).prompt);
                            if (logMessage2) {
                                messageQueue.enqueue(logMessage2);
                            }
                        }
                    }
                }
            }
        }

        try {
            let pending: {
                message: string;
                mode: EnhancedMode;
                isolate: boolean;
                items: Array<{ message: string; localId?: string }>;
            } | null = null;

            let previousSessionId: string | null = null;
            let immediateFailureCount = 0;
            while (!this.exitReason) {
                logger.debug('[remote]: launch');
                messageBuffer.addMessage('═'.repeat(40), 'status');

                const isNewSession = session.sessionId !== previousSessionId;
                if (isNewSession) {
                    messageBuffer.addMessage('Starting new Claude session...', 'status');
                    permissionHandler.reset();
                    sdkToLogConverter.resetParentChain();
                    logger.debug(`[remote]: New session detected (previous: ${previousSessionId}, current: ${session.sessionId})`);
                } else {
                    messageBuffer.addMessage('Continuing Claude session...', 'status');
                    logger.debug(`[remote]: Continuing existing session: ${session.sessionId}`);
                }

                previousSessionId = session.sessionId;
                const controller = new AbortController();
                this.abortController = controller;
                this.abortFuture = new Future<void>();
                let modeHash: string | null = null;
                let mode: EnhancedMode | null = null;
                // True once onReady() has fired at least once during this
                // attempt. Used to distinguish an immediate/deterministic
                // failure (never reached ready) from a failure after real
                // progress was made, for the respawn-storm guard below.
                let reachedReadyThisAttempt = false;
                // True once nextMessage() has actually handed a message to the
                // SDK during this attempt (as opposed to parking it into
                // `pending` and returning null). Some commands complete and
                // return successfully without ever calling onReady -- e.g.
                // claudeRemote.ts's /clear handling calls onSessionReset() and
                // returns directly -- so onReady alone cannot tell "a real
                // message was processed" apart from "nothing was delivered
                // this attempt" (e.g. the livelock-prone park-then-return-null
                // case). See the success-path reset below.
                let deliveredMessageThisAttempt = false;
                // Tracks the most recent message batch handed to the SDK via
                // nextMessage() that has not yet been confirmed complete by a
                // following onReady(). If claudeRemote() throws while a
                // message is in flight, it is dequeued+acked already (see
                // MessageQueue2.collectBatch) but never delivered -- the catch
                // block below restores it with queue.unshift()/unshiftIsolated()
                // (per original item, preserving each item's localId) so it is
                // not silently dropped.
                type InFlightMessage = {
                    items: Array<{ message: string; localId?: string }>;
                    mode: EnhancedMode;
                    isolate: boolean;
                };
                // The `as InFlightMessage | null` (rather than plain `= null`)
                // is required, not decorative: the only assignments of a
                // non-null value happen inside the nextMessage()/onReady()
                // closures below, which TS's control-flow narrowing does not
                // see from this function body. Without the cast, TS narrows
                // this declaration to the `null` literal type, and the
                // `if (inFlightMessage)` checks further down then fail
                // typecheck with "Property 'isolate' does not exist on type
                // 'never'" (verified against `bun run typecheck`).
                let inFlightMessage: InFlightMessage | null = null as InFlightMessage | null;
                try {
                    await claudeRemote({
                        sessionId: session.sessionId,
                        path: session.path,
                        allowedTools: session.allowedTools ?? [],
                        mcpServers: session.mcpServers,
                        hookSettingsPath: session.hookSettingsPath,
                        canCallTool: permissionHandler.handleToolCall,
                        isAborted: (toolCallId: string) => {
                            return permissionHandler.isAborted(toolCallId);
                        },
                        nextMessage: async () => {
                            // Flush any pending outgoing messages before consuming the next user
                            // turn. Without this, scheduleProcessing()'s setTimeout(fn,0) fires
                            // after the microtask that sends messages-consumed, causing the hub
                            // to stamp invokedAt on the next user message before it stores the
                            // current turn's queued agent messages — making them sort permanently
                            // below the next user message.
                            await messageQueue.flush();

                            if (pending) {
                                let p = pending;
                                pending = null;
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                // Re-resolve the selected-model seed hint for every turn, not
                                // just the first: a single claudeRemote() call keeps accepting
                                // new turns (potentially with a different model, e.g. after a
                                // mid-session model switch), so a construction-time snapshot
                                // would go stale. See SDKToLogConverter.updateSelectedModel.
                                sdkToLogConverter.updateSelectedModel(p.mode.model ?? null);
                                inFlightMessage = { items: p.items, mode: p.mode, isolate: p.isolate };
                                deliveredMessageThisAttempt = true;
                                return p;
                            }

                            let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                            if (msg) {
                                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                    // Parked into `pending`, not handed to the
                                    // SDK -- deliberately NOT tracked as
                                    // inFlightMessage. `pending` is declared
                                    // outside the while loop and is only ever
                                    // cleared when actually consumed (the
                                    // `if (pending)` branch above), so it
                                    // already survives a throw in this or any
                                    // later attempt without help from the
                                    // restore-on-catch logic below. Tracking
                                    // it here too would restore a second copy
                                    // via queue.unshift() on top of the one
                                    // still safely held in `pending`,
                                    // delivering it twice.
                                    logger.debug('[remote]: mode has changed, pending message');
                                    pending = msg;
                                    return null;
                                }
                                modeHash = msg.hash;
                                mode = msg.mode;
                                permissionHandler.handleModeChange(mode.permissionMode);
                                sdkToLogConverter.updateSelectedModel(mode.model ?? null);
                                inFlightMessage = { items: msg.items, mode: msg.mode, isolate: msg.isolate };
                                deliveredMessageThisAttempt = true;
                                return {
                                    message: msg.message,
                                    mode: msg.mode
                                };
                            }

                            return null;
                        },
                        onSessionFound: (sessionId) => {
                            session.onSessionFound(sessionId);
                            // The one-time --resume flag must only be dropped once we know
                            // Claude actually captured a session id from it. If claudeRemote()
                            // bails out before this fires (e.g. the initial nextMessage() came
                            // back null because a relaunch trigger arrived before any turn was
                            // ever processed), the flag stays in session.claudeArgs so the next
                            // launch attempt can still resume the original session.
                            session.consumeOneTimeFlags();
                        },
                        onThinkingChange: session.onThinkingChange,
                        claudeEnvVars: session.claudeEnvVars,
                        claudeArgs: session.claudeArgs,
                        onMessage,
                        onFirstResult: (initialMessage) => {
                            applySessionTitleFallback(session.client, initialMessage);
                        },
                        onCompletionEvent: (message: string) => {
                            logger.debug(`[remote]: Completion event: ${message}`);
                            session.client.sendSessionEvent({ type: 'message', message });
                        },
                        onSessionReset: () => {
                            logger.debug('[remote]: Session reset');
                            session.clearSessionId();
                            // /clear discards the resume anchor along with the
                            // context. Without this, the flag would outlive the
                            // reset (claudeRemote() returns before spawning
                            // Claude, so onSessionFound never fires) and the
                            // next launch would resume the session the user
                            // just asked to clear.
                            session.consumeOneTimeFlags();
                        },
                        onReady: () => {
                            // Reaching ready at all means this attempt is not an
                            // immediate/deterministic failure -- reset the
                            // respawn-storm guard. The turn that led here is no
                            // longer "in flight" either.
                            reachedReadyThisAttempt = true;
                            inFlightMessage = null;

                            logger.debug(
                                `[claudeRemoteLauncher][async-debug] onReady callback ` +
                                `(hasPending=${Boolean(pending)}, queueSize=${session.queue.size()})`
                            );
                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event sent to hub');
                            } else {
                                logger.debug('[claudeRemoteLauncher][async-debug] ready event suppressed (pending input exists)');
                            }
                        },
                        signal: controller.signal,
                    });

                    if (!this.exitReason && controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }

                    // A full attempt completed without throwing. Clear the
                    // immediate-failure streak if this attempt either reached
                    // onReady, or actually delivered a message to the SDK
                    // (deliveredMessageThisAttempt) -- some commands complete
                    // successfully without ever calling onReady (e.g.
                    // claudeRemote.ts's /clear handling calls onSessionReset()
                    // and returns directly), and that is still real progress,
                    // not an immediate/deterministic failure. Without the
                    // deliveredMessageThisAttempt half of this condition, a
                    // successful /clear between two unrelated launch failures
                    // would not reset the streak and the cap could fire after
                    // just one more failure instead of a fresh budget of 3.
                    //
                    // Neither flag is set for a trivial no-op completion (e.g.
                    // the initial nextMessage() returning null because the
                    // only queued message was parked into `pending` for a
                    // later attempt, per claudeRemote.ts's "initial
                    // nextMessage returned null; exiting") -- resetting on
                    // that case would clear the streak every other attempt
                    // while the underlying deterministic failure keeps
                    // recurring on alternating attempts, and the cap would
                    // never fire (livelock).
                    if (reachedReadyThisAttempt || deliveredMessageThisAttempt) {
                        immediateFailureCount = 0;
                    }
                } catch (e) {
                    logger.debug('[remote]: launch error', e);

                    // Restores a message batch that was already
                    // dequeued+acked from the queue (see
                    // MessageQueue2.collectBatch: the ack fires at dequeue
                    // time, before the SDK ever sees the message) but never
                    // got a chance to be processed, so it is retried instead
                    // of lost. Each original item is unshifted individually,
                    // in reverse order, so per-item localId is preserved
                    // (reconnecting the retried prompt to its hub row instead
                    // of a localId-less orphan) and the original relative
                    // order is restored -- collectBatch() joins same-mode
                    // items into a single `message` string for the SDK, but
                    // still returns the pre-join `items` breakdown for this.
                    const restoreInFlightMessage = () => {
                        if (!inFlightMessage) return;
                        const { items, mode, isolate } = inFlightMessage;
                        for (const item of [...items].reverse()) {
                            if (isolate) {
                                session.queue.unshiftIsolated(item.message, mode, item.localId);
                            } else {
                                session.queue.unshift(item.message, mode, item.localId);
                            }
                        }
                        inFlightMessage = null;
                    };

                    if (!this.exitReason) {
                        const detail = e instanceof Error ? e.message : String(e);

                        if (reachedReadyThisAttempt) {
                            immediateFailureCount = 0;
                        } else {
                            immediateFailureCount += 1;
                        }

                        if (immediateFailureCount >= MAX_IMMEDIATE_RESPAWN_FAILURES) {
                            // Give up on retrying *this message*, not the
                            // whole session. Restoring it here would feed it
                            // straight back into another immediate failure on
                            // the very next attempt (unshift -> re-dequeue ->
                            // re-throw), storming again -- matches
                            // cursorLegacyRemoteLauncher's drop-and-reset
                            // policy on its own consecutive-failure cap.
                            // Reset the streak and keep the loop (and this OS
                            // process) alive so an unrelated later message
                            // gets its own fresh budget.
                            inFlightMessage = null;
                            session.client.sendSessionEvent({
                                type: 'message',
                                message: `Process exited unexpectedly ${MAX_IMMEDIATE_RESPAWN_FAILURES} times in a row: ${detail}. Dropping the queued message; resolve the issue and resend it.`
                            });
                            immediateFailureCount = 0;
                        } else {
                            restoreInFlightMessage();
                            session.client.sendSessionEvent({ type: 'message', message: `Process exited unexpectedly: ${detail}` });
                            await this.respawnBackoff(getRespawnBackoffMs(), controller.signal);
                            continue;
                        }
                    } else {
                        // exitReason already set by something else (e.g. a
                        // user-initiated switch/exit racing this throw) --
                        // still restore any in-flight message so it isn't
                        // silently dropped by that unrelated shutdown.
                        restoreInFlightMessage();
                    }
                } finally {
                    logger.debug('[remote]: launch finally');

                    for (let [toolCallId, { parentToolCallId }] of ongoingToolCalls) {
                        const converted = sdkToLogConverter.generateInterruptedToolResult(toolCallId, parentToolCallId);
                        if (converted) {
                            logger.debug('[remote]: terminating tool call ' + toolCallId + ' parent: ' + parentToolCallId);
                            session.client.sendClaudeSessionMessage(converted);
                        }
                    }
                    ongoingToolCalls.clear();

                    logger.debug('[remote]: flushing message queue');
                    await messageQueue.flush();
                    messageQueue.destroy();
                    logger.debug('[remote]: message queue flushed');

                    this.abortController = null;
                    this.abortFuture?.resolve(undefined);
                    this.abortFuture = null;
                    logger.debug('[remote]: launch done');
                    permissionHandler.reset();
                    modeHash = null;
                    mode = null;
                }
            }
        } finally {
            if (this.permissionHandler) {
                this.permissionHandler.reset();
            }
        }
    }

    protected async cleanup(): Promise<void> {
        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.handleSessionFound) {
            this.session.removeSessionFoundCallback(this.handleSessionFound);
            this.handleSessionFound = null;
        }

        if (this.permissionHandler) {
            this.permissionHandler.reset();
        }

        if (this.abortFuture) {
            this.abortFuture.resolve(undefined);
        }
    }
}

export async function claudeRemoteLauncher(session: Session): Promise<'switch' | 'exit'> {
    const launcher = new ClaudeRemoteLauncher(session);
    return launcher.launch();
}
