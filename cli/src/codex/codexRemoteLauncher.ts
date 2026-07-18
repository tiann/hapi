import React from 'react';
import { randomUUID } from 'node:crypto';

import { CodexAppServerClient, CodexAppServerError, formatCodexAppServerFailure } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { AppServerEventConverter } from './utils/appServerEventConverter';
import { registerAppServerPermissionHandlers } from './utils/appServerPermissionAdapter';
import { buildThreadStartParams, buildTurnStartParams } from './utils/appServerConfig';
import { shouldIgnoreTerminalEvent } from './utils/terminalEventGuard';

function deliveryFailureState(error: unknown): 'definitive-no-write' | 'ambiguous' {
    if (error instanceof CodexAppServerError && error.writeState === 'not-written') return 'definitive-no-write';
    return 'ambiguous';
}
import { createCodexThreadTitlePoller, syncCodexThreadTitleToMetadata } from './utils/codexThreadTitle';
import { compactToolOutputForHapi } from './utils/toolOutputCompaction';
import {
    clearTerminalCodexGoal,
    createCodexGoalMcpTools,
    setCodexThreadGoalReplacingTerminal
} from './utils/hapiGoalTools';
import { parseSpecialCommand } from '@/parsers/specialCommands';
import { createCodexLiveAppendQueueHandler } from './utils/liveAppendQueue';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];
type QueuedMessage = {
    message: string;
    mode: EnhancedMode;
    isolate: boolean;
    hash: string;
    delivery?: { items: Array<{ messageId: string; sequence: number }>; attemptId: string };
};

class CodexRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CodexSession;
    private readonly appServerClient: CodexAppServerClient;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private abortGeneration = 0;
    private abortOperation: Promise<void> | null = null;
    private currentThreadId: string | null = null;
    private currentTurnId: string | null = null;
    private liveAppendTurnInFlight = false;
    private liveAppendActiveModeHash: string | null = null;
    private titlePoller: { stop: () => void } | null = null;

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.appServerClient = new CodexAppServerClient();
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private handleAbort(): Promise<void> {
        if (this.abortOperation) return this.abortOperation;
        const operation = this.performAbort();
        this.abortOperation = operation;
        void operation.then(
            () => { if (this.abortOperation === operation) this.abortOperation = null; },
            () => { if (this.abortOperation === operation) this.abortOperation = null; }
        );
        return operation;
    }

    private async performAbort(): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        this.abortGeneration += 1;
        this.abortController.abort();
        try {
            let interruptError: unknown = null;
            if (this.currentThreadId && this.currentTurnId) {
                try {
                    await this.appServerClient.interruptTurn({
                        threadId: this.currentThreadId,
                        turnId: this.currentTurnId
                    });
                } catch (error) {
                    interruptError = error;
                    logger.warn('[Codex] Native turn interruption failed; quarantining the session', error);
                }
            }
            this.currentTurnId = null;
            this.resetLiveAppendState();

            await this.session.invalidateQueuedMessages('codex-abort', 'canceled');
            if (interruptError) throw interruptError;
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            this.session.onAmbiguousDelivery?.();
            this.exitReason = 'exit';
            this.shouldExit = true;
            logger.warn('[Codex] Abort could not durably terminalize queued messages', error);
            throw error;
        } finally {
            // A durable-cancel failure leaves a mixed/unknown queue. Keep the
            // signal aborted and stop the launcher so no retained item can be
            // reserved or committed through a later delivery-barrier failure.
            if (!this.shouldExit) {
                this.abortController = new AbortController();
            }
        }
    }

    private async waitForAbortOperationToSettle(): Promise<void> {
        const operation = this.abortOperation;
        if (!operation) return;
        try {
            await operation;
        } catch {
            // performAbort already quarantines the session before rejecting.
        }
    }

    private resetLiveAppendState(): void {
        this.liveAppendTurnInFlight = false;
        this.liveAppendActiveModeHash = null;
    }

    private async handleExitFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Exiting agent via Ctrl-C');
        this.exitReason = 'exit';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchFromUi(): Promise<void> {
        logger.debug('[codex-remote]: Switching to local mode via double space');
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    private async handleSwitchRequest(): Promise<void> {
        this.exitReason = 'switch';
        this.shouldExit = true;
        await this.handleAbort();
    }

    public async launch(): Promise<RemoteLauncherExitReason> {
        if (this.session.codexArgs && this.session.codexArgs.length > 0) {
            if (hasCodexCliOverrides(this.session.codexCliOverrides)) {
                logger.debug(`[codex-remote] CLI args include sandbox/approval overrides; other args ` +
                    `are ignored in remote mode.`);
            } else {
                logger.debug(`[codex-remote] Warning: CLI args [${this.session.codexArgs.join(', ')}] are ignored in remote mode. ` +
                    `Remote mode uses message-based configuration (model/sandbox set via web interface).`);
            }
        }

        return this.start({
            onExit: () => this.handleExitFromUi(),
            onSwitchToLocal: () => this.handleSwitchFromUi()
        });
    }

    protected async runMainLoop(): Promise<void> {
        const session = this.session;
        const messageBuffer = this.messageBuffer;
        const appServerClient = this.appServerClient;
        const appServerEventConverter = new AppServerEventConverter();
        const shouldAutoExitAfterIdleTurn = session.startedBy === 'runner' && session.client.isDesktopMirrorSession();

        const syncThreadTitle = (threadId: string | null) => {
            if (!threadId) {
                return;
            }
            void syncCodexThreadTitleToMetadata(session.client, threadId);
        };
        this.titlePoller ??= createCodexThreadTitlePoller({
            client: session.client,
            getThreadId: () => this.currentThreadId
        });

        const normalizeCommand = (value: unknown): string | undefined => {
            if (typeof value === 'string') {
                const trimmed = value.trim();
                return trimmed.length > 0 ? trimmed : undefined;
            }
            if (Array.isArray(value)) {
                const joined = value.filter((part): part is string => typeof part === 'string').join(' ');
                return joined.length > 0 ? joined : undefined;
            }
            return undefined;
        };

        const asRecord = (value: unknown): Record<string, unknown> | null => {
            if (!value || typeof value !== 'object') {
                return null;
            }
            return value as Record<string, unknown>;
        };

        const asString = (value: unknown): string | null => {
            return typeof value === 'string' && value.length > 0 ? value : null;
        };

        const asStringArray = (value: unknown): string[] | null => {
            if (!Array.isArray(value)) {
                return null;
            }
            const strings = value.filter((entry): entry is string => typeof entry === 'string' && entry.length > 0);
            return strings.length > 0 ? strings : null;
        };

        const applyResolvedModel = (value: unknown): string | undefined => {
            const resolvedModel = asString(value) ?? undefined;
            if (!resolvedModel) {
                return undefined;
            }
            session.setModel(resolvedModel);
            logger.debug(`[Codex] Resolved app-server model: ${resolvedModel}`);
            return resolvedModel;
        };

        const buildMcpToolName = (server: unknown, tool: unknown): string | null => {
            const serverName = asString(server);
            const toolName = asString(tool);
            if (!serverName || !toolName) {
                return null;
            }
            return `mcp__${serverName}__${toolName}`;
        };

        const formatOutputPreview = (value: unknown): string => {
            if (typeof value === 'string') return value;
            if (typeof value === 'number' || typeof value === 'boolean') return String(value);
            if (value === null || value === undefined) return '';
            try {
                return JSON.stringify(value);
            } catch {
                return String(value);
            }
        };

        const setIfDefined = (target: Record<string, unknown>, key: string, value: unknown) => {
            if (value !== null && value !== undefined) {
                target[key] = value;
            }
        };

        const permissionHandler = new CodexPermissionHandler(session.client, () => {
            const mode = session.getPermissionMode();
            return mode === 'default' || mode === 'read-only' || mode === 'safe-yolo' || mode === 'yolo'
                ? mode
                : undefined;
        }, {
            onRequest: ({ id, toolName, input }) => {
                if (toolName === 'request_user_input') {
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'request_user_input',
                        callId: id,
                        input,
                        id: randomUUID()
                    });
                    return;
                }

                const inputRecord = input && typeof input === 'object' ? input as Record<string, unknown> : {};
                const message = typeof inputRecord.message === 'string' ? inputRecord.message : undefined;
                const rawCommand = inputRecord.command;
                const command = Array.isArray(rawCommand)
                    ? rawCommand.filter((part): part is string => typeof part === 'string').join(' ')
                    : typeof rawCommand === 'string'
                        ? rawCommand
                        : undefined;
                const cwdValue = inputRecord.cwd;
                const cwd = typeof cwdValue === 'string' && cwdValue.trim().length > 0 ? cwdValue : undefined;

                session.sendAgentMessage({
                    type: 'tool-call',
                    name: 'CodexPermission',
                    callId: id,
                    input: {
                        tool: toolName,
                        message,
                        command,
                        cwd
                    },
                    id: randomUUID()
                });
            },
            onComplete: ({ id, toolName, decision, reason, approved, answers }) => {
                session.sendAgentMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: toolName === 'request_user_input'
                        ? { answers }
                        : {
                            decision,
                            reason
                        },
                    is_error: !approved,
                    id: randomUUID()
                });
            }
        });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendAgentMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendAgentMessage(message);
        });
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;
        let readyAfterTurnTimer: ReturnType<typeof setTimeout> | null = null;
        let scheduleReadyAfterTurn: (() => void) | null = null;
        let clearReadyAfterTurnTimer: (() => void) | null = null;
        let turnInFlight = false;
        let allowAnonymousTerminalEvent = false;
        let manualCompactionInFlight = false;
        let goalCommandInFlight = false;
        let goalNotificationSuppressionDepth = 0;
        let resolveManualCompactionCompletion: (() => void) | null = null;
        let clearManualCompactionAbortHandler: (() => void) | null = null;
        const mcpToolNamesByCallId = new Map<string, string>();
        let turnDurationStartedAt: number | null = null;
        let turnDurationTurnId: string | null = null;

        const finishManualCompaction = () => {
            manualCompactionInFlight = false;
            clearManualCompactionAbortHandler?.();
            clearManualCompactionAbortHandler = null;
            const resolve = resolveManualCompactionCompletion;
            resolveManualCompactionCompletion = null;
            resolve?.();
        };

        const beginManualCompaction = (signal: AbortSignal): Promise<void> => {
            clearManualCompactionAbortHandler?.();
            manualCompactionInFlight = true;
            return new Promise((resolve) => {
                resolveManualCompactionCompletion = resolve;
                const abortHandler = () => finishManualCompaction();
                signal.addEventListener('abort', abortHandler, { once: true });
                clearManualCompactionAbortHandler = () => {
                    signal.removeEventListener('abort', abortHandler);
                };
            });
        };

        const runWithGoalNotificationSuppression = async <T,>(action: () => Promise<T>): Promise<T> => {
            goalNotificationSuppressionDepth += 1;
            goalCommandInFlight = true;
            try {
                return await action();
            } finally {
                goalNotificationSuppressionDepth = Math.max(0, goalNotificationSuppressionDepth - 1);
                goalCommandInFlight = goalNotificationSuppressionDepth > 0;
            }
        };

        const startTurnDurationIfNeeded = (turnId?: string | null) => {
            if (turnDurationStartedAt === null) {
                turnDurationStartedAt = Date.now();
                turnDurationTurnId = turnId ?? null;
                return;
            }
            if (!turnDurationTurnId && turnId) {
                turnDurationTurnId = turnId;
            }
        };

        const bindTurnDurationTurnIdIfNeeded = (turnId: string | null) => {
            if (turnDurationStartedAt !== null && !turnDurationTurnId && turnId) {
                turnDurationTurnId = turnId;
            }
        };

        const emitTurnDurationIfStarted = (turnId?: string | null) => {
            if (turnDurationStartedAt === null) {
                return false;
            }
            if (turnId && turnDurationTurnId && turnDurationTurnId !== turnId) {
                return false;
            }
            const durationMs = Math.max(0, Date.now() - turnDurationStartedAt);
            turnDurationStartedAt = null;
            turnDurationTurnId = null;
            session.sendSessionEvent({
                type: 'turn-duration',
                durationMs
            });
            return true;
        };

        const discardTurnDurationForTurn = (turnId?: string | null) => {
            if (!turnId || turnDurationStartedAt === null || turnDurationTurnId !== turnId) {
                return;
            }
            turnDurationStartedAt = null;
            turnDurationTurnId = null;
        };

        const handleCodexEvent = (msg: Record<string, unknown>) => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            const eventTurnId = asString(msg.turn_id ?? msg.turnId);
            const isManualContextCompacted = msgType === 'context_compacted' && manualCompactionInFlight;
            const isTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed' || isManualContextCompacted;

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    this.currentThreadId = threadId;
                    void session.onSessionFound(threadId);
                    syncThreadTitle(threadId);
                }
                return;
            }

            if (msgType === 'task_started') {
                const turnId = eventTurnId;
                startTurnDurationIfNeeded(turnId);
                if (turnId) {
                    this.currentTurnId = turnId;
                    allowAnonymousTerminalEvent = false;
                } else if (!this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
            }

            if (isTerminalEvent) {
                const currentTurnIdForGuard = manualCompactionInFlight && !eventTurnId
                    ? null
                    : this.currentTurnId;
                if (shouldIgnoreTerminalEvent({
                    eventTurnId,
                    currentTurnId: currentTurnIdForGuard,
                    turnInFlight,
                    allowAnonymousTerminalEvent: manualCompactionInFlight || allowAnonymousTerminalEvent
                })) {
                    discardTurnDurationForTurn(eventTurnId);
                    logger.debug(
                        `[Codex] Ignoring terminal event ${msgType} without matching turn context; ` +
                        `eventTurnId=${eventTurnId ?? 'none'}, activeTurn=${this.currentTurnId ?? 'none'}, ` +
                        `turnInFlight=${turnInFlight}, allowAnonymous=${allowAnonymousTerminalEvent}`
                    );
                    return;
                }
                emitTurnDurationIfStarted(eventTurnId);
                this.currentTurnId = null;
                this.resetLiveAppendState();
                allowAnonymousTerminalEvent = false;
                if (
                    isManualContextCompacted ||
                    (manualCompactionInFlight && (msgType === 'task_failed' || msgType === 'turn_aborted'))
                ) {
                    finishManualCompaction();
                }
            }

            if (msgType === 'turn_aborted' || msgType === 'task_failed') {
                session.sendAgentMessage(msg);
            }

            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    messageBuffer.addMessage(message, 'assistant');
                }
            } else if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    messageBuffer.addMessage(`[Thinking] ${text.substring(0, 100)}...`, 'system');
                }
            } else if (msgType === 'exec_command_begin') {
                const command = normalizeCommand(msg.command) ?? 'command';
                messageBuffer.addMessage(`Executing: ${command}`, 'tool');
            } else if (msgType === 'exec_command_end') {
                const output = msg.output ?? msg.error ?? 'Command completed';
                const outputText = formatOutputPreview(output);
                const truncatedOutput = outputText.substring(0, 200);
                messageBuffer.addMessage(
                    `Result: ${truncatedOutput}${outputText.length > 200 ? '...' : ''}`,
                    'result'
                );
            } else if (msgType === 'task_started') {
                messageBuffer.addMessage('Starting task...', 'status');
            } else if (msgType === 'task_complete') {
                messageBuffer.addMessage('Task completed', 'status');
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
            } else if (msgType === 'task_failed') {
                const error = asString(msg.error);
                messageBuffer.addMessage(error ? `Task failed: ${error}` : 'Task failed', 'status');
            } else if (msgType === 'context_compacted') {
                messageBuffer.addMessage('Context compacted', 'status');
            }

            if (msgType === 'task_started') {
                clearReadyAfterTurnTimer?.();
                turnInFlight = true;
                if (this.liveAppendActiveModeHash) {
                    this.liveAppendTurnInFlight = true;
                }
                if (!eventTurnId && !this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (isTerminalEvent) {
                turnInFlight = false;
                allowAnonymousTerminalEvent = false;
                syncThreadTitle(this.currentThreadId);
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                diffProcessor.reset();
                appServerEventConverter.reset();
            }

            if (isTerminalEvent && !turnInFlight && !manualCompactionInFlight) {
                scheduleReadyAfterTurn?.();
            } else if (readyAfterTurnTimer && msgType !== 'task_started') {
                scheduleReadyAfterTurn?.();
            }

            if (msgType === 'agent_reasoning_section_break') {
                reasoningProcessor.handleSectionBreak();
            }
            if (msgType === 'agent_reasoning_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    reasoningProcessor.processDelta(delta);
                }
            }
            if (msgType === 'agent_reasoning') {
                const text = asString(msg.text);
                if (text) {
                    reasoningProcessor.complete(text);
                }
            }
            if (msgType === 'agent_message') {
                const message = asString(msg.message);
                if (message) {
                    session.sendAgentMessage({
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_subagent_spawned') {
                const callId = asString(msg.call_id ?? msg.callId);
                const agentId = asString(msg.agent_id ?? msg.agentId);
                if (callId && agentId) {
                    const input: Record<string, unknown> = { agent_id: agentId };
                    setIfDefined(input, 'nickname', asString(msg.nickname));
                    setIfDefined(input, 'agent_type', asString(msg.agent_type ?? msg.agentType));
                    setIfDefined(input, 'message', asString(msg.message));

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'spawn_agent',
                        callId,
                        input,
                        id: randomUUID()
                    });
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: compactToolOutputForHapi(input, {
                            callId,
                            toolName: 'spawn_agent'
                        }),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_subagent_waited') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const input: Record<string, unknown> = {};
                    setIfDefined(input, 'target', asString(msg.target));
                    const targets = asStringArray(msg.targets);
                    if (targets) {
                        input.targets = targets;
                    }
                    const status = asRecord(msg.status);
                    if (status) {
                        input.status = status;
                    }

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'wait_agent',
                        callId,
                        input,
                        id: randomUUID()
                    });
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: compactToolOutputForHapi(status ?? input, {
                            callId,
                            toolName: 'wait_agent'
                        }),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'codex_subagent_closed') {
                const callId = asString(msg.call_id ?? msg.callId);
                const target = asString(msg.target);
                if (callId && target) {
                    const input: Record<string, unknown> = { target };
                    if (msg.previous_status !== undefined) {
                        input.previous_status = msg.previous_status;
                    }
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'close_agent',
                        callId,
                        input,
                        id: randomUUID()
                    });
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: compactToolOutputForHapi({ ...input, closed: true }, {
                            callId,
                            toolName: 'close_agent'
                        }),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'context_compacted') {
                session.sendAgentMessage({
                    ...msg,
                    id: randomUUID()
                });
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexBash',
                        callId: callId,
                        input: inputs,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const output: Record<string, unknown> = { ...msg };
                    delete output.type;
                    delete output.call_id;
                    delete output.callId;

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: compactToolOutputForHapi(output, {
                            callId,
                            toolName: 'CodexBash'
                        }),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'token_count') {
                session.sendAgentMessage({
                    ...msg,
                    id: randomUUID()
                });
            }
            if (msgType === 'patch_apply_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const changes = asRecord(msg.changes) ?? {};
                    const changeCount = Object.keys(changes).length;
                    const filesMsg = changeCount === 1 ? '1 file' : `${changeCount} files`;
                    messageBuffer.addMessage(`Modifying ${filesMsg}...`, 'tool');

                    session.sendAgentMessage({
                        type: 'tool-call',
                        name: 'CodexPatch',
                        callId: callId,
                        input: {
                            auto_approved: msg.auto_approved ?? msg.autoApproved,
                            changes
                        },
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'patch_apply_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const stdout = asString(msg.stdout);
                    const stderr = asString(msg.stderr);
                    const success = Boolean(msg.success);

                    if (success) {
                        const message = stdout || 'Files modified successfully';
                        messageBuffer.addMessage(message.substring(0, 200), 'result');
                    } else {
                        const errorMsg = stderr || 'Failed to modify files';
                        messageBuffer.addMessage(`Error: ${errorMsg.substring(0, 200)}`, 'result');
                    }

                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: compactToolOutputForHapi({
                            stdout,
                            stderr,
                            success
                        }, {
                            callId,
                            toolName: 'CodexPatch'
                        }),
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId);
                const invocation = asRecord(msg.invocation) ?? {};
                const name = buildMcpToolName(
                    invocation.server ?? invocation.server_name ?? msg.server,
                    invocation.tool ?? invocation.tool_name ?? msg.tool
                );
                if (callId && name) {
                    mcpToolNamesByCallId.set(callId, name);
                    session.sendAgentMessage({
                        type: 'tool-call',
                        name,
                        callId,
                        input: invocation.arguments ?? invocation.input ?? msg.arguments ?? msg.input ?? {},
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                const rawResult = msg.result;
                let output = rawResult;
                let isError = false;
                const resultRecord = asRecord(rawResult);
                if (resultRecord) {
                    if (Object.prototype.hasOwnProperty.call(resultRecord, 'Ok')) {
                        output = resultRecord.Ok;
                    } else if (Object.prototype.hasOwnProperty.call(resultRecord, 'Err')) {
                        output = resultRecord.Err;
                        isError = true;
                    }
                }

                if (callId) {
                    const toolName = mcpToolNamesByCallId.get(callId) ?? 'mcp';
                    session.sendAgentMessage({
                        type: 'tool-call-result',
                        callId,
                        output: compactToolOutputForHapi(output, {
                            callId,
                            toolName
                        }),
                        is_error: isError,
                        id: randomUUID()
                    });
                    mcpToolNamesByCallId.delete(callId);
                }
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        registerAppServerPermissionHandlers({
            client: appServerClient,
            permissionHandler,
            onUserInputRequest: async ({ id, input }) => {
                try {
                    const answers = await permissionHandler.handleUserInputRequest(id, input);
                    return {
                        decision: 'accept',
                        answers
                    };
                } catch (error) {
                    const message = error instanceof Error ? error.message : String(error);
                    logger.debug(`[Codex] request_user_input failed: ${message}`);
                    return {
                        decision: 'cancel'
                    };
                }
            }
        });

        appServerClient.setNotificationHandler((method, params) => {
            if (
                goalCommandInFlight &&
                (
                    method === 'thread/goal/updated' ||
                    method === 'thread/goal/cleared' ||
                    method === 'turn/started' ||
                    method === 'turn/completed'
                )
            ) {
                logger.debug('[Codex] Ignoring app-server notification emitted by native goal command', { method });
                return;
            }
            if (method === 'turn/started' && !turnInFlight && !manualCompactionInFlight) {
                logger.debug('[Codex] Ignoring app-server turn/started notification with no HAPI turn in flight');
                return;
            }
            const events = appServerEventConverter.handleNotification(method, params);
            for (const event of events) {
                const eventRecord = asRecord(event) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            }
        });

        const goalTools = createCodexGoalMcpTools({
            client: appServerClient,
            getThreadId: () => this.currentThreadId,
            getSignal: () => this.abortController.signal,
            runWithGoalNotificationSuppression
        });
        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client, {
            extraTools: goalTools
        });
        this.happyServer = happyServer;

        this.setupAbortHandlers(session.client.rpcHandlerManager, {
            onAbort: () => this.handleAbort(),
            onSwitch: () => this.handleSwitchRequest()
        });

        function logActiveHandles(tag: string) {
            if (!process.env.DEBUG) return;
            const anyProc: any = process as any;
            const handles = typeof anyProc._getActiveHandles === 'function' ? anyProc._getActiveHandles() : [];
            const requests = typeof anyProc._getActiveRequests === 'function' ? anyProc._getActiveRequests() : [];
            logger.debug(`[codex][handles] ${tag}: handles=${handles.length} requests=${requests.length}`);
            try {
                const kinds = handles.map((h: any) => (h && h.constructor ? h.constructor.name : typeof h));
                logger.debug(`[codex][handles] kinds=${JSON.stringify(kinds)}`);
            } catch {}
        }

        const sendReady = () => {
            session.sendSessionEvent({ type: 'ready' });
        };

        await appServerClient.connect();
        await appServerClient.initialize({
            clientInfo: {
                name: 'hapi-codex-client',
                version: '1.0.0'
            },
            capabilities: {
                experimentalApi: true
            }
        });

        let hasThread = false;
        let pending: QueuedMessage | null = null;

        clearReadyAfterTurnTimer = () => {
            if (!readyAfterTurnTimer) {
                return;
            }
            clearTimeout(readyAfterTurnTimer);
            readyAfterTurnTimer = null;
        };

        scheduleReadyAfterTurn = () => {
            clearReadyAfterTurnTimer?.();
            readyAfterTurnTimer = setTimeout(() => {
                readyAfterTurnTimer = null;
                emitReadyIfIdle({
                    pending,
                    queueSize: () => session.queue.size(),
                    shouldExit: this.shouldExit,
                    sendReady
                });
            }, 120);
            readyAfterTurnTimer.unref?.();
        };

        session.queue.setOnMessage?.(session.deliveryOutcomes ? null : createCodexLiveAppendQueueHandler({
            queue: session.queue,
            getActiveModeHash: () => this.liveAppendActiveModeHash,
            getThreadId: () => this.currentThreadId,
            getTurnId: () => this.currentTurnId,
            isTurnInFlight: () => this.liveAppendTurnInFlight,
            hasPendingPermission: () => permissionHandler.hasPendingRequests(),
            isManualCompactionInFlight: () => manualCompactionInFlight,
            isGoalCommandInFlight: () => goalCommandInFlight,
            getSteer: () => async ({ threadId, expectedTurnId, message: nextMessage }) => {
                const response = await appServerClient.steerTurn({
                    threadId,
                    expectedTurnId,
                    input: [{ type: 'text', text: nextMessage }]
                });
                return !response.turnId || response.turnId === expectedTurnId;
            },
            log: (logMessage) => logger.debug(logMessage),
            onAccepted: (next) => {
                messageBuffer.addMessage(next.message, 'user');
                logger.debug('[codexRemoteLauncher] live appended queued user message into active Codex turn');
            },
            onAmbiguous: (reason) => {
                session.sendSessionEvent({
                    type: 'message',
                    message: `A live-appended message may or may not have reached Codex and will not be replayed automatically: ${reason}`
                });
            }
        }));

        const persistAccepted = async (delivery: QueuedMessage['delivery']): Promise<boolean> => {
            if (!delivery) return true;
            let persisted = false;
            try {
                persisted = await session.deliveryOutcomes?.recordTerminal(delivery.items, delivery.attemptId, 'accepted') === true;
            } catch (error) {
                logger.warn('[Codex] Failed to persist accepted delivery boundary:', error);
            }
            if (persisted) return true;
            session.sendSessionEvent({
                type: 'message',
                message: 'Codex accepted the message, but HAPI could not durably record acceptance. The session is quarantined to prevent replay.'
            });
            session.onAmbiguousDelivery?.();
            this.exitReason = 'exit';
            this.shouldExit = true;
            return false;
        };

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            let message: QueuedMessage | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = this.abortController.signal;
                const dequeueGeneration = this.abortGeneration;
                const dequeueInterrupted = () => waitSignal.aborted || dequeueGeneration !== this.abortGeneration;
                const queueWithReservations = session.queue as typeof session.queue & {
                    waitForMessagesAndReserve?: typeof session.queue.waitForMessagesAndReserve;
                };
                if (!queueWithReservations.waitForMessagesAndReserve) {
                    const legacyBatch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                    if (!legacyBatch) {
                        if (waitSignal.aborted && !this.shouldExit) {
                            await this.waitForAbortOperationToSettle();
                            continue;
                        }
                        break;
                    }
                    pending = legacyBatch;
                    continue;
                }
                const reservation = await queueWithReservations.waitForMessagesAndReserve(waitSignal);
                if (!reservation) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        await this.waitForAbortOperationToSettle();
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!reservation}, shouldExit=${this.shouldExit}`);
                    break;
                }
                if (dequeueInterrupted()) {
                    session.queue.restore(reservation);
                    await this.waitForAbortOperationToSettle();
                    continue;
                }
                let delivery: QueuedMessage['delivery'];
                if (session.deliveryOutcomes) {
                    if (!session.queue.seal(reservation)) {
                        throw new Error('Queued message reservation became stale before delivery barrier');
                    }
                    const items = reservation.items.map((item) => ({ messageId: item.messageId, sequence: item.seq }));
                    const attemptId = randomUUID();
                    const barrier = await session.deliveryOutcomes.prepareBatch(items, attemptId);
                    if (dequeueInterrupted()) {
                        session.queue.restore(reservation);
                        if (barrier.written) {
                            let canceled = false;
                            try {
                                canceled = await session.deliveryOutcomes.recordTerminal(items, attemptId, 'canceled');
                            } catch (error) {
                                logger.warn('[Codex] Failed to cancel an interrupted delivery reservation', error);
                            }
                            if (!canceled) {
                                session.onAmbiguousDelivery?.();
                                this.exitReason = 'exit';
                                this.shouldExit = true;
                            }
                        }
                        await this.waitForAbortOperationToSettle();
                        continue;
                    }
                    if (!barrier.written) {
                        if (barrier.reason === 'definitive-no-write') {
                            session.queue.restore(reservation);
                            session.sendSessionEvent({ type: 'message', message: 'Message delivery could not be durably prepared. It remains queued.' });
                            this.shouldExit = true;
                            this.abortController.abort();
                            continue;
                        }
                        session.queue.commit(reservation);
                        session.onAmbiguousDelivery?.();
                        this.shouldExit = true;
                        session.sendSessionEvent({ type: 'message', message: 'Message delivery state is ambiguous. The batch was quarantined and will not be replayed.' });
                        this.abortController.abort();
                        continue;
                    }
                    delivery = { items, attemptId };
                }
                if (!session.queue.commit(reservation)) {
                    if (delivery) {
                        await session.deliveryOutcomes?.recordTerminal(delivery.items, delivery.attemptId, 'canceled');
                    }
                    throw new Error('Queued message reservation became stale before delivery');
                }
                message = {
                    message: reservation.message,
                    mode: reservation.mode,
                    isolate: reservation.isolate,
                    hash: reservation.hash,
                    delivery
                };
            }

            if (!message) {
                break;
            }

            messageBuffer.addMessage(message.message, 'user');
            try {
                if (!hasThread) {
                    const threadParams = buildThreadStartParams({
                        cwd: session.path,
                        mode: message.mode,
                        mcpServers,
                        cliOverrides: session.codexCliOverrides
                    });

                    const resumeCandidate = session.sessionId;
                    let threadId: string | null = null;

                    if (resumeCandidate) {
                        try {
                            const resumeResponse = await appServerClient.resumeThread({
                                threadId: resumeCandidate,
                                ...threadParams
                            }, {
                                signal: this.abortController.signal
                            });
                            const resumeRecord = asRecord(resumeResponse);
                            const resumeThread = resumeRecord ? asRecord(resumeRecord.thread) : null;
                            threadId = asString(resumeThread?.id) ?? resumeCandidate;
                            applyResolvedModel(resumeRecord?.model);
                            logger.debug(`[Codex] Resumed app-server thread ${threadId}`);
                        } catch (error) {
                            if (session.startedBy === 'runner') throw error;
                            logger.warn(`[Codex] Failed to resume app-server thread ${resumeCandidate}, starting new thread`, error);
                        }
                    }

                    if (!threadId) {
                        const threadResponse = await appServerClient.startThread(threadParams, {
                            signal: this.abortController.signal
                        });
                        const threadRecord = asRecord(threadResponse);
                        const thread = threadRecord ? asRecord(threadRecord.thread) : null;
                        threadId = asString(thread?.id);
                        applyResolvedModel(threadRecord?.model);
                        if (!threadId) {
                            throw new Error('app-server thread/start did not return thread.id');
                        }
                    }

                    if (!threadId) {
                        throw new Error('app-server resume did not return thread.id');
                    }

                    this.currentThreadId = threadId;
                    await session.onSessionFound(threadId);
                    syncThreadTitle(threadId);
                    hasThread = true;
                } else {
                    if (!this.currentThreadId) {
                        logger.debug('[Codex] Missing thread id; restarting app-server thread');
                        hasThread = false;
                        pending = message;
                        continue;
                    }
                }

                const specialCommand = parseSpecialCommand(message.message);
                if (specialCommand.type === 'compact') {
                    if (!this.currentThreadId) {
                        session.sendAgentMessage({
                            type: 'task_failed',
                            error: 'No Codex thread is available to compact.',
                            id: randomUUID()
                        });
                        sendReady();
                        continue;
                    }

                    messageBuffer.addMessage('Compaction started', 'status');
                    session.sendAgentMessage({
                        type: 'message',
                        message: 'Compaction started',
                        id: randomUUID()
                    });
                    const manualCompactionCompletion = beginManualCompaction(this.abortController.signal);
                    turnInFlight = true;
                    allowAnonymousTerminalEvent = true;
                    startTurnDurationIfNeeded();
                    try {
                        await appServerClient.compactThread({
                            threadId: this.currentThreadId
                        }, {
                            signal: this.abortController.signal
                        });
                        syncThreadTitle(this.currentThreadId);
                        if (manualCompactionInFlight) {
                            await manualCompactionCompletion;
                        }
                        await persistAccepted(message.delivery);
                    } catch (error) {
                        const failureState = deliveryFailureState(error);
                        if (message.delivery) {
                            await session.deliveryOutcomes?.recordTerminal(message.delivery.items, message.delivery.attemptId, failureState);
                        }
                        finishManualCompaction();
                        emitTurnDurationIfStarted();
                        const messageText = `Compaction failed: ${formatCodexAppServerFailure(error)}`;
                        logger.warn('[Codex] Failed to compact thread:', error);
                        messageBuffer.addMessage(messageText, 'status');
                        session.sendAgentMessage({
                            type: 'task_failed',
                            error: messageText,
                            id: randomUUID()
                        });
                        if (failureState === 'ambiguous') {
                            session.onAmbiguousDelivery?.();
                            this.exitReason = 'exit';
                            this.shouldExit = true;
                        }
                        sendReady();
                    } finally {
                        if (!manualCompactionInFlight) {
                            turnInFlight = false;
                            allowAnonymousTerminalEvent = false;
                        }
                    }
                    continue;
                }

                if (specialCommand.type === 'goal') {
                    const goalThreadId = this.currentThreadId;
                    if (!goalThreadId) {
                        session.sendAgentMessage({
                            type: 'task_failed',
                            error: 'No Codex thread is available to manage goals.',
                            id: randomUUID()
                        });
                        sendReady();
                        continue;
                    }

                    try {
                        const responseText = await runWithGoalNotificationSuppression(async () => {
                            if (specialCommand.goalAction === 'set' && specialCommand.goalText) {
                                const result = await setCodexThreadGoalReplacingTerminal(appServerClient, {
                                    threadId: goalThreadId,
                                    objective: specialCommand.goalText
                                }, { signal: this.abortController.signal });
                                return `Goal set: ${result.goal?.objective ?? specialCommand.goalText}`;
                            }
                            if (specialCommand.goalAction === 'clear') {
                                await appServerClient.clearThreadGoal({
                                    threadId: goalThreadId
                                }, { signal: this.abortController.signal });
                                return `Goal cleared`;
                            }
                            const result = await appServerClient.getThreadGoal({
                                threadId: goalThreadId
                            }, { signal: this.abortController.signal });
                            return result.goal?.objective ? `Current goal: ${result.goal.objective}` : 'No goal is currently set';
                        });

                        messageBuffer.addMessage(responseText, 'status');
                        session.sendAgentMessage({
                            type: 'message',
                            message: responseText,
                            id: randomUUID()
                        });
                        await persistAccepted(message.delivery);
                    } catch (error) {
                        const failureState = deliveryFailureState(error);
                        if (message.delivery) {
                            await session.deliveryOutcomes?.recordTerminal(message.delivery.items, message.delivery.attemptId, failureState);
                        }
                        let messageText = `Failed to manage goal: ${formatCodexAppServerFailure(error)}`;
                        // Gracefully handle older app-server versions that don't support the goal RPC methods
                        if ((error instanceof CodexAppServerError && error.code === -32601)
                            || (error instanceof Error && /method not found/i.test(error.message))) {
                            messageText = 'Your version of Codex does not support the native /goal command. Please update Codex.';
                        }
                        logger.warn('[Codex] Failed to manage goal:', error);
                        messageBuffer.addMessage(messageText, 'status');
                        session.sendAgentMessage({
                            type: 'task_failed',
                            error: messageText,
                            id: randomUUID()
                        });
                        if (failureState === 'ambiguous') {
                            session.onAmbiguousDelivery?.();
                            this.exitReason = 'exit';
                            this.shouldExit = true;
                        }
                    }
                    continue;
                }

                const sessionModelReasoningEffort = session.getModelReasoningEffort();
                const sessionServiceTier = session.getServiceTier();
                const currentThreadId = this.currentThreadId;
                if (!currentThreadId) {
                    throw new Error('No Codex thread is available to start a turn.');
                }
                try {
                    const clearedGoal = await runWithGoalNotificationSuppression(
                        () => clearTerminalCodexGoal(
                            appServerClient,
                            currentThreadId,
                            { signal: this.abortController.signal }
                        )
                    );
                    if (clearedGoal) {
                        logger.debug('[Codex] Cleared terminal goal before starting a normal turn', {
                            threadId: this.currentThreadId,
                            status: clearedGoal.status,
                            objective: clearedGoal.objective
                        });
                    }
                } catch (error) {
                    logger.debug('[Codex] Skipping terminal goal cleanup before turn:', error);
                }
                const turnParams = buildTurnStartParams({
                    threadId: this.currentThreadId,
                    message: message.message,
                    cwd: session.path,
                    mode: {
                        ...message.mode,
                        model: session.getModel() ?? message.mode.model,
                        modelReasoningEffort: sessionModelReasoningEffort !== undefined
                            ? ((sessionModelReasoningEffort ?? undefined) as EnhancedMode['modelReasoningEffort'])
                            : message.mode.modelReasoningEffort,
                        serviceTier: sessionServiceTier !== undefined
                            ? ((sessionServiceTier ?? undefined) as EnhancedMode['serviceTier'])
                            : message.mode.serviceTier
                    },
                    cliOverrides: session.codexCliOverrides
                });
                this.liveAppendActiveModeHash = message.hash;
                this.liveAppendTurnInFlight = true;
                turnInFlight = true;
                allowAnonymousTerminalEvent = false;
                startTurnDurationIfNeeded();
                const turnResponse = await appServerClient.startTurn(turnParams, {
                    signal: this.abortController.signal
                });
                syncThreadTitle(this.currentThreadId);
                const turnRecord = asRecord(turnResponse);
                const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                const turnId = asString(turn?.id);
                await persistAccepted(message.delivery);
                if (turnInFlight) {
                    if (turnId) {
                        bindTurnDurationTurnIdIfNeeded(turnId);
                        this.currentTurnId = turnId;
                    } else if (!this.currentTurnId) {
                        allowAnonymousTerminalEvent = true;
                    }
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                const failureMessage = formatCodexAppServerFailure(error);
                turnInFlight = false;
                this.resetLiveAppendState();
                allowAnonymousTerminalEvent = false;
                this.currentTurnId = null;
                if (message.delivery) {
                    const failureState = deliveryFailureState(error);
                    await session.deliveryOutcomes?.recordTerminal(
                        message.delivery.items,
                        message.delivery.attemptId,
                        failureState
                    );
                }

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                } else {
                    messageBuffer.addMessage(failureMessage, 'status');
                    session.sendSessionEvent({ type: 'message', message: failureMessage });
                    this.currentTurnId = null;
                    this.currentThreadId = null;
                    hasThread = false;
                }
                if (message.delivery && deliveryFailureState(error) === 'ambiguous') {
                    session.onAmbiguousDelivery?.();
                    this.exitReason = 'exit';
                    this.shouldExit = true;
                }
                emitTurnDurationIfStarted();
            } finally {
                if (!turnInFlight) {
                    this.resetLiveAppendState();
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    appServerEventConverter.reset();
                    session.onThinkingChange(false);
                    clearReadyAfterTurnTimer?.();
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                    if (
                        shouldAutoExitAfterIdleTurn
                        && !this.shouldExit
                        && !pending
                        && session.queue.size() === 0
                    ) {
                        logger.debug('[codex-remote]: desktop mirror takeover turn is idle; exiting runner to return ownership');
                        this.exitReason = 'exit';
                        this.shouldExit = true;
                    }
                }
                logActiveHandles('after-turn');
            }
        }
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        try {
            await this.appServerClient.disconnect();
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

        this.titlePoller?.stop();
        this.titlePoller = null;

        this.session.queue.setOnMessage?.(null);

        this.permissionHandler?.reset();
        this.reasoningProcessor?.abort();
        this.diffProcessor?.reset();
        this.permissionHandler = null;
        this.reasoningProcessor = null;
        this.diffProcessor = null;

        logger.debug('[codex-remote]: cleanup done');
    }
}

export async function codexRemoteLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const launcher = new CodexRemoteLauncher(session);
    return launcher.launch();
}
