import React from 'react';
import { randomUUID } from 'node:crypto';

import { CodexMcpClient } from './codexMcpClient';
import { CodexAppServerClient } from './codexAppServerClient';
import { CodexPermissionHandler } from './utils/permissionHandler';
import { ReasoningProcessor } from './utils/reasoningProcessor';
import { DiffProcessor } from './utils/diffProcessor';
import { logger } from '@/ui/logger';
import { CodexDisplay } from '@/ui/ink/CodexDisplay';
import type { CodexSessionConfig } from './types';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { emitReadyIfIdle } from './utils/emitReadyIfIdle';
import type { CodexSession } from './session';
import type { EnhancedMode } from './loop';
import { hasCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexStartConfig } from './utils/codexStartConfig';
import { AppServerEventConverter } from './utils/appServerEventConverter';
import { registerAppServerPermissionHandlers } from './utils/appServerPermissionAdapter';
import { buildThreadStartParams, buildTurnStartParams } from './utils/appServerConfig';
import { shouldIgnoreTerminalEvent } from './utils/terminalEventGuard';
import {
    RemoteLauncherBase,
    type RemoteLauncherDisplayContext,
    type RemoteLauncherExitReason
} from '@/modules/common/remote/RemoteLauncherBase';

type HappyServer = Awaited<ReturnType<typeof buildHapiMcpBridge>>['server'];

function shouldUseAppServer(): boolean {
    const useMcpServer = process.env.CODEX_USE_MCP_SERVER === '1';
    return !useMcpServer;
}

class CodexRemoteLauncher extends RemoteLauncherBase {
    private readonly session: CodexSession;
    private readonly useAppServer: boolean;
    private readonly mcpClient: CodexMcpClient | null;
    private readonly appServerClient: CodexAppServerClient | null;
    private permissionHandler: CodexPermissionHandler | null = null;
    private reasoningProcessor: ReasoningProcessor | null = null;
    private diffProcessor: DiffProcessor | null = null;
    private happyServer: HappyServer | null = null;
    private abortController: AbortController = new AbortController();
    private currentThreadId: string | null = null;
    private currentTurnId: string | null = null;

    constructor(session: CodexSession) {
        super(process.env.DEBUG ? session.logPath : undefined);
        this.session = session;
        this.useAppServer = shouldUseAppServer();
        this.mcpClient = this.useAppServer ? null : new CodexMcpClient();
        this.appServerClient = this.useAppServer ? new CodexAppServerClient() : null;
    }

    protected createDisplay(context: RemoteLauncherDisplayContext): React.ReactElement {
        return React.createElement(CodexDisplay, context);
    }

    private async handleAbort(): Promise<void> {
        logger.debug('[Codex] Abort requested - stopping current task');
        try {
            if (this.useAppServer && this.appServerClient) {
                if (this.currentThreadId && this.currentTurnId) {
                    try {
                        await this.appServerClient.interruptTurn({
                            threadId: this.currentThreadId,
                            turnId: this.currentTurnId
                        });
                    } catch (error) {
                        logger.debug('[Codex] Error interrupting app-server turn:', error);
                    }
                }

                this.currentTurnId = null;
            }

            this.abortController.abort();
            this.session.queue.reset();
            this.permissionHandler?.reset();
            this.reasoningProcessor?.abort();
            this.diffProcessor?.reset();
            logger.debug('[Codex] Abort completed - session remains active');
        } catch (error) {
            logger.debug('[Codex] Error during abort:', error);
        } finally {
            this.abortController = new AbortController();
        }
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
        const useAppServer = this.useAppServer;
        const mcpClient = this.mcpClient;
        const appServerClient = this.appServerClient;
        const appServerEventConverter = useAppServer ? new AppServerEventConverter() : null;

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

        const permissionHandler = new CodexPermissionHandler(session.client, {
            onRequest: ({ id, toolName, input }) => {
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

                session.sendCodexMessage({
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
            onComplete: ({ id, decision, reason, approved }) => {
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: {
                        decision,
                        reason
                    },
                    is_error: !approved,
                    id: randomUUID()
                });
            }
        });
        const reasoningProcessor = new ReasoningProcessor((message) => {
            session.sendCodexMessage(message);
        });
        const diffProcessor = new DiffProcessor((message) => {
            session.sendCodexMessage(message);
        });
        this.permissionHandler = permissionHandler;
        this.reasoningProcessor = reasoningProcessor;
        this.diffProcessor = diffProcessor;
        let readyAfterTurnTimer: ReturnType<typeof setTimeout> | null = null;
        let scheduleReadyAfterTurn: (() => void) | null = null;
        let clearReadyAfterTurnTimer: (() => void) | null = null;
        let turnInFlight = false;
        let allowAnonymousTerminalEvent = false;

        const handleCodexEvent = (msg: Record<string, unknown>) => {
            const msgType = asString(msg.type);
            if (!msgType) return;
            const eventTurnId = asString(msg.turn_id ?? msg.turnId);
            const isTerminalEvent = msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed';

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                }
                return;
            }

            if (msgType === 'task_started') {
                const turnId = eventTurnId;
                if (turnId) {
                    this.currentTurnId = turnId;
                    allowAnonymousTerminalEvent = false;
                } else if (useAppServer && !this.currentTurnId) {
                    allowAnonymousTerminalEvent = true;
                }
            }

            if (isTerminalEvent) {
                if (shouldIgnoreTerminalEvent({
                    useAppServer,
                    eventTurnId,
                    currentTurnId: this.currentTurnId,
                    turnInFlight,
                    allowAnonymousTerminalEvent
                })) {
                    logger.debug(
                        `[Codex] Ignoring terminal event ${msgType} without matching turn context; ` +
                        `eventTurnId=${eventTurnId ?? 'none'}, activeTurn=${this.currentTurnId ?? 'none'}, ` +
                        `turnInFlight=${turnInFlight}, allowAnonymous=${allowAnonymousTerminalEvent}`
                    );
                    return;
                }
                this.currentTurnId = null;
                allowAnonymousTerminalEvent = false;
            }

            if (!useAppServer) {
                logger.debug(`[Codex] MCP message: ${JSON.stringify(msg)}`);

                if (msgType === 'event_msg' || msgType === 'response_item' || msgType === 'session_meta') {
                    const payload = asRecord(msg.payload);
                    const payloadType = asString(payload?.type);
                    logger.debug(`[Codex] MCP wrapper event type: ${msgType}${payloadType ? ` (payload=${payloadType})` : ''}`);
                }
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
                if (!useAppServer) {
                    sendReady();
                }
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
                if (!useAppServer) {
                    sendReady();
                }
            } else if (msgType === 'task_failed') {
                const error = asString(msg.error);
                messageBuffer.addMessage(error ? `Task failed: ${error}` : 'Task failed', 'status');
                if (!useAppServer) {
                    sendReady();
                }
            }

            if (msgType === 'task_started') {
                clearReadyAfterTurnTimer?.();
                if (useAppServer) {
                    turnInFlight = true;
                    if (!eventTurnId && !this.currentTurnId) {
                        allowAnonymousTerminalEvent = true;
                    }
                }
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (isTerminalEvent) {
                if (useAppServer) {
                    turnInFlight = false;
                    allowAnonymousTerminalEvent = false;
                }
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                diffProcessor.reset();
                appServerEventConverter?.reset();
            }

            if (useAppServer) {
                if (isTerminalEvent && !turnInFlight) {
                    scheduleReadyAfterTurn?.();
                } else if (readyAfterTurnTimer && msgType !== 'task_started') {
                    scheduleReadyAfterTurn?.();
                }
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
                    session.sendCodexMessage({
                        type: 'message',
                        message,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'exec_command_begin' || msgType === 'exec_approval_request') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    const inputs: Record<string, unknown> = { ...msg };
                    delete inputs.type;
                    delete inputs.call_id;
                    delete inputs.callId;

                    session.sendCodexMessage({
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

                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'token_count') {
                session.sendCodexMessage({
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

                    session.sendCodexMessage({
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

                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId: callId,
                        output: {
                            stdout,
                            stderr,
                            success
                        },
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
                    session.sendCodexMessage({
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
                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: isError,
                        id: randomUUID()
                    });
                }
            }
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        if (useAppServer && appServerClient && appServerEventConverter) {
            registerAppServerPermissionHandlers({
                client: appServerClient,
                permissionHandler
            });

            appServerClient.setNotificationHandler((method, params) => {
                const events = appServerEventConverter.handleNotification(method, params);
                for (const event of events) {
                    const eventRecord = asRecord(event) ?? { type: undefined };
                    handleCodexEvent(eventRecord);
                }
            });
        } else if (mcpClient) {
            mcpClient.setPermissionHandler(permissionHandler);
            mcpClient.setHandler((msg) => {
                const eventRecord = asRecord(msg) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            });
        }

        const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
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

        const syncSessionId = () => {
            if (!mcpClient) return;
            const clientSessionId = mcpClient.getSessionId();
            if (clientSessionId && clientSessionId !== session.sessionId) {
                session.onSessionFound(clientSessionId);
            }
        };

        if (useAppServer && appServerClient) {
            await appServerClient.connect();
            await appServerClient.initialize({
                clientInfo: {
                    name: 'hapi-codex-client',
                    version: '1.0.0'
                }
            });
        } else if (mcpClient) {
            await mcpClient.connect();
        }

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let first = true;

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

        while (!this.shouldExit) {
            logActiveHandles('loop-top');
            let message: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = pending;
            pending = null;
            if (!message) {
                const waitSignal = this.abortController.signal;
                const batch = await session.queue.waitForMessagesAndGetAsString(waitSignal);
                if (!batch) {
                    if (waitSignal.aborted && !this.shouldExit) {
                        logger.debug('[codex]: Wait aborted while idle; ignoring and continuing');
                        continue;
                    }
                    logger.debug(`[codex]: batch=${!!batch}, shouldExit=${this.shouldExit}`);
                    break;
                }
                message = batch;
            }

            if (!message) {
                break;
            }

            if (!useAppServer && wasCreated && currentModeHash && message.hash !== currentModeHash) {
                logger.debug('[Codex] Mode changed – restarting Codex session');
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage('Starting new Codex session (mode changed)...', 'status');
                mcpClient?.clearSession();
                wasCreated = false;
                currentModeHash = null;
                pending = message;
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                session.onThinkingChange(false);
                continue;
            }

            messageBuffer.addMessage(message.message, 'user');
            currentModeHash = message.hash;

            try {
                if (!wasCreated) {
                    if (useAppServer && appServerClient) {
                        const threadParams = buildThreadStartParams({
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
                                logger.debug(`[Codex] Resumed app-server thread ${threadId}`);
                            } catch (error) {
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
                            if (!threadId) {
                                throw new Error('app-server thread/start did not return thread.id');
                            }
                        }

                        if (!threadId) {
                            throw new Error('app-server resume did not return thread.id');
                        }

                        this.currentThreadId = threadId;
                        session.onSessionFound(threadId);

                        const turnParams = buildTurnStartParams({
                            threadId,
                            message: message.message,
                            mode: message.mode,
                            cliOverrides: session.codexCliOverrides
                        });
                        turnInFlight = true;
                        allowAnonymousTerminalEvent = false;
                        const turnResponse = await appServerClient.startTurn(turnParams, {
                            signal: this.abortController.signal
                        });
                        const turnRecord = asRecord(turnResponse);
                        const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                        const turnId = asString(turn?.id);
                        if (turnId) {
                            this.currentTurnId = turnId;
                        } else if (!this.currentTurnId) {
                            allowAnonymousTerminalEvent = true;
                        }
                    } else if (mcpClient) {
                        const startConfig: CodexSessionConfig = buildCodexStartConfig({
                            message: message.message,
                            mode: message.mode,
                            first,
                            mcpServers,
                            cliOverrides: session.codexCliOverrides
                        });

                        await mcpClient.startSession(startConfig, { signal: this.abortController.signal });
                        syncSessionId();
                    }

                    wasCreated = true;
                    first = false;
                } else if (useAppServer && appServerClient) {
                    if (!this.currentThreadId) {
                        logger.debug('[Codex] Missing thread id; restarting app-server thread');
                        wasCreated = false;
                        pending = message;
                        continue;
                    }

                    const turnParams = buildTurnStartParams({
                        threadId: this.currentThreadId,
                        message: message.message,
                        mode: message.mode,
                        cliOverrides: session.codexCliOverrides
                    });
                    turnInFlight = true;
                    allowAnonymousTerminalEvent = false;
                    const turnResponse = await appServerClient.startTurn(turnParams, {
                        signal: this.abortController.signal
                    });
                    const turnRecord = asRecord(turnResponse);
                    const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                    const turnId = asString(turn?.id);
                    if (turnId) {
                        this.currentTurnId = turnId;
                    } else if (!this.currentTurnId) {
                        allowAnonymousTerminalEvent = true;
                    }
                } else if (mcpClient) {
                    await mcpClient.continueSession(message.message, { signal: this.abortController.signal });
                    syncSessionId();
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                if (useAppServer) {
                    turnInFlight = false;
                    allowAnonymousTerminalEvent = false;
                    this.currentTurnId = null;
                }

                if (isAbortError) {
                    messageBuffer.addMessage('Aborted by user', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    if (!useAppServer) {
                        wasCreated = false;
                        currentModeHash = null;
                        logger.debug('[Codex] Marked session as not created after abort for proper resume');
                    }
                } else {
                    messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    if (useAppServer) {
                        this.currentTurnId = null;
                        this.currentThreadId = null;
                        wasCreated = false;
                    }
                }
            } finally {
                const shouldFinalizeTurnState = !useAppServer || !turnInFlight;
                if (shouldFinalizeTurnState) {
                    permissionHandler.reset();
                    reasoningProcessor.abort();
                    diffProcessor.reset();
                    appServerEventConverter?.reset();
                    session.onThinkingChange(false);
                    clearReadyAfterTurnTimer?.();
                    emitReadyIfIdle({
                        pending,
                        queueSize: () => session.queue.size(),
                        shouldExit: this.shouldExit,
                        sendReady
                    });
                }
                logActiveHandles('after-turn');
            }
        }
    }

    protected async cleanup(): Promise<void> {
        logger.debug('[codex-remote]: cleanup start');
        try {
            if (this.appServerClient) {
                await this.appServerClient.disconnect();
            }
            if (this.mcpClient) {
                await this.mcpClient.disconnect();
            }
        } catch (error) {
            logger.debug('[codex-remote]: Error disconnecting client', error);
        }

        this.clearAbortHandlers(this.session.client.rpcHandlerManager);

        if (this.happyServer) {
            this.happyServer.stop();
            this.happyServer = null;
        }

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
