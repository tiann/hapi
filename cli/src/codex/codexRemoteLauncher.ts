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
    private useAppServer: boolean;
    private mcpClient: CodexMcpClient | null;
    private appServerClient: CodexAppServerClient | null;
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
            this.session.onThinkingChange(false);
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
        let useAppServer = this.useAppServer;
        let mcpClient = this.mcpClient;
        let appServerClient = this.appServerClient;
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

        const clearResumeThreadReference = (): void => {
            session.sessionId = null;
            session.client.updateMetadata((metadata) => ({
                ...metadata,
                codexSessionId: undefined
            }));
        };

        const permissionHandler = new CodexPermissionHandler(session.client, {
            onRequest: ({ id, toolName, input }) => {
                if (toolName === 'request_user_input' || toolName === 'AskUserQuestion' || toolName === 'ask_user_question') {
                    session.sendCodexMessage({
                        type: 'tool-call',
                        name: toolName,
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
            onComplete: ({ id, decision, reason, approved, answers }) => {
                session.sendCodexMessage({
                    type: 'tool-call-result',
                    callId: id,
                    output: {
                        decision,
                        reason,
                        approved,
                        answers
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

        const handleCodexEvent = (msg: Record<string, unknown>) => {
            const msgType = asString(msg.type);
            if (!msgType) return;

            if (msgType === 'thread_started') {
                const threadId = asString(msg.thread_id ?? msg.threadId);
                if (threadId) {
                    this.currentThreadId = threadId;
                    session.onSessionFound(threadId);
                }
                return;
            }

            if (msgType === 'task_started') {
                const turnId = asString(msg.turn_id ?? msg.turnId);
                if (turnId) {
                    this.currentTurnId = turnId;
                }
            }

            if (msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed') {
                this.currentTurnId = null;
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
                sendReady();
            } else if (msgType === 'turn_aborted') {
                messageBuffer.addMessage('Turn aborted', 'status');
                sendReady();
            } else if (msgType === 'task_failed') {
                const error = asString(msg.error);
                messageBuffer.addMessage(error ? `Task failed: ${error}` : 'Task failed', 'status');
                sendReady();
            } else if (msgType === 'turn_plan_updated') {
                const entriesRaw = Array.isArray(msg.entries) ? msg.entries : [];
                const entries = entriesRaw
                    .map((entry, index) => {
                        if (!entry || typeof entry !== 'object') {
                            return null;
                        }
                        const item = entry as Record<string, unknown>;
                        const content = asString(item.step ?? item.content);
                        if (!content) {
                            return null;
                        }
                        const statusRaw = asString(item.status) ?? 'pending';
                        const status = statusRaw === 'inProgress' ? 'in_progress' : statusRaw;
                        if (status !== 'pending' && status !== 'in_progress' && status !== 'completed') {
                            return null;
                        }
                        return {
                            id: asString(item.id) ?? `plan-${index + 1}`,
                            content,
                            status,
                            priority: 'medium'
                        };
                    })
                    .filter((entry): entry is { id: string; content: string; status: 'pending' | 'in_progress' | 'completed'; priority: 'medium' } => entry !== null);

                if (entries.length > 0) {
                    session.sendCodexMessage({
                        type: 'plan',
                        entries,
                        id: randomUUID()
                    });
                }
            } else if (msgType === 'plan_delta') {
                const delta = asString(msg.delta);
                if (delta) {
                    messageBuffer.addMessage(`[Plan] ${delta.substring(0, 120)}${delta.length > 120 ? '…' : ''}`, 'system');
                }
            } else if (msgType === 'mcp_startup_update') {
                const server = asString(msg.server) ?? 'unknown';
                const status = asString(asRecord(msg.status)?.state) ?? 'unknown';
                messageBuffer.addMessage(`MCP ${server}: ${status}`, 'status');
            } else if (msgType === 'mcp_startup_complete') {
                const ready = Array.isArray(msg.ready) ? msg.ready.filter((value): value is string => typeof value === 'string') : [];
                const failed = Array.isArray(msg.failed) ? msg.failed.filter((value): value is string => typeof value === 'string') : [];
                if (ready.length > 0) {
                    messageBuffer.addMessage(`MCP ready: ${ready.join(', ')}`, 'status');
                }
                if (failed.length > 0) {
                    messageBuffer.addMessage(`MCP failed: ${failed.join(', ')}`, 'status');
                }
            } else if (msgType === 'context_compacted') {
                messageBuffer.addMessage('Context compacted', 'status');
            } else if (msgType === 'web_search_begin') {
                const callId = asString(msg.call_id ?? msg.callId) ?? randomUUID();
                const query = asString(msg.query);
                messageBuffer.addMessage(query ? `Web search: ${query}` : 'Web search started', 'tool');
                session.sendCodexMessage({
                    type: 'tool-call',
                    name: 'CodexWebSearch',
                    callId,
                    input: {
                        query
                    },
                    id: randomUUID()
                });
            } else if (msgType === 'web_search_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId,
                        output: {
                            query: asString(msg.query),
                            action: msg.action
                        },
                        id: randomUUID()
                    });
                }
            } else if (msgType === 'mcp_tool_call_begin') {
                const callId = asString(msg.call_id ?? msg.callId) ?? randomUUID();
                const invocation = asRecord(msg.invocation) ?? {};
                const server = asString(invocation.server) ?? 'unknown';
                const tool = asString(invocation.tool) ?? 'tool';

                messageBuffer.addMessage(`MCP tool: ${server}/${tool}`, 'tool');
                session.sendCodexMessage({
                    type: 'tool-call',
                    name: `MCP:${server}/${tool}`,
                    callId,
                    input: {
                        server,
                        tool,
                        arguments: invocation.arguments ?? {}
                    },
                    id: randomUUID()
                });
            } else if (msgType === 'mcp_tool_call_end') {
                const callId = asString(msg.call_id ?? msg.callId);
                if (callId) {
                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId,
                        output: {
                            duration: msg.duration,
                            result: msg.result
                        },
                        id: randomUUID()
                    });
                }
            }

            if (msgType === 'task_started') {
                if (useAppServer) {
                    turnInFlight = true;
                }
                if (!session.thinking) {
                    logger.debug('thinking started');
                    session.onThinkingChange(true);
                }
            }
            if (msgType === 'task_complete' || msgType === 'turn_aborted' || msgType === 'task_failed') {
                if (useAppServer) {
                    turnInFlight = false;
                }
                if (session.thinking) {
                    logger.debug('thinking completed');
                    session.onThinkingChange(false);
                }
                diffProcessor.reset();
                appServerEventConverter?.reset();
            }
            if (msgType === 'codex_step_complete') {
                // Intermediate step within a multi-step agentic chain.
                // Reset diff state but keep thinking=true and turnInFlight=true.
                diffProcessor.reset();
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
            if (msgType === 'turn_diff') {
                const diff = asString(msg.unified_diff);
                if (diff) {
                    diffProcessor.processDiff(diff);
                }
            }
        };

        const attachMcpHandlers = (client: CodexMcpClient) => {
            client.setPermissionHandler(permissionHandler);
            client.setHandler((msg) => {
                const eventRecord = asRecord(msg) ?? { type: undefined };
                handleCodexEvent(eventRecord);
            });
        };

        if (useAppServer && appServerClient && appServerEventConverter) {
            registerAppServerPermissionHandlers({
                client: appServerClient,
                permissionHandler,
                onUserInputRequest: async (request) => {
                    const params = asRecord(request) ?? {};
                    const requestId = asString(params.itemId ?? params.callId) ?? randomUUID();
                    const result = await permissionHandler.handleToolCall(
                        requestId,
                        'request_user_input',
                        params
                    );

                    if (result.decision !== 'approved' && result.decision !== 'approved_for_session') {
                        return {};
                    }

                    const answersRaw = result.answers;
                    if (!answersRaw || typeof answersRaw !== 'object') {
                        return {};
                    }

                    const normalized: Record<string, { answers: string[] }> = {};
                    for (const [key, value] of Object.entries(answersRaw as Record<string, unknown>)) {
                        if (Array.isArray(value)) {
                            normalized[key] = { answers: value.filter((entry): entry is string => typeof entry === 'string') };
                            continue;
                        }
                        if (value && typeof value === 'object' && Array.isArray((value as Record<string, unknown>).answers)) {
                            normalized[key] = {
                                answers: ((value as Record<string, unknown>).answers as unknown[])
                                    .filter((entry): entry is string => typeof entry === 'string')
                            };
                        }
                    }

                    return normalized;
                },
                onDynamicToolCall: async (request) => {
                    const params = asRecord(request) ?? {};
                    const callId = asString(params.callId) ?? randomUUID();
                    const dynamicToolName = asString(params.tool) ?? 'dynamic_tool';

                    session.sendCodexMessage({
                        type: 'tool-call',
                        name: 'CodexDynamicTool',
                        callId,
                        input: {
                            tool: dynamicToolName,
                            arguments: params.arguments ?? {}
                        },
                        id: randomUUID()
                    });

                    const notSupportedMessage = `Dynamic tool '${dynamicToolName}' is not supported by this hapi Codex client yet.`;
                    messageBuffer.addMessage(notSupportedMessage, 'status');

                    const output = {
                        success: false,
                        error: notSupportedMessage
                    };

                    session.sendCodexMessage({
                        type: 'tool-call-result',
                        callId,
                        output,
                        is_error: true,
                        id: randomUUID()
                    });

                    return {
                        success: false,
                        contentItems: [
                            {
                                type: 'inputText',
                                text: notSupportedMessage
                            }
                        ]
                    };
                }
            });

            appServerClient.setNotificationHandler((method, params) => {
                const events = appServerEventConverter.handleNotification(method, params);
                for (const event of events) {
                    const eventRecord = asRecord(event) ?? { type: undefined };
                    handleCodexEvent(eventRecord);
                }
            });
        } else if (mcpClient) {
            attachMcpHandlers(mcpClient);
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
            try {
                await appServerClient.connect();
                await appServerClient.initialize({
                    clientInfo: {
                        name: 'hapi-codex-client',
                        version: '1.0.0'
                    }
                });
            } catch (error) {
                logger.warn('[Codex] Failed to initialize app-server transport, falling back to MCP transport', error);
                try {
                    await appServerClient.disconnect();
                } catch { }
                this.appServerClient = null;
                appServerClient = null;
                useAppServer = false;
                this.useAppServer = false;
                this.currentThreadId = null;
                this.currentTurnId = null;
                appServerEventConverter?.reset();

                mcpClient = mcpClient ?? new CodexMcpClient();
                this.mcpClient = mcpClient;
                attachMcpHandlers(mcpClient);
                await mcpClient.connect();
            }
        } else if (mcpClient) {
            await mcpClient.connect();
        }

        let wasCreated = false;
        let currentModeHash: string | null = null;
        let pending: { message: string; mode: EnhancedMode; isolate: boolean; hash: string } | null = null;
        let lastDisconnectedRetryKey: string | null = null;
        let first = true;
        let turnInFlight = false;
        let forceFreshThread = false;
        let previousThreadIdBeforeReset: string | null = null;

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

            // Handle isolated messages (/new, /model) – reset session state
            if (message.isolate) {
                const isNewCommand = message.message.trim() === '/new';
                const isClearCommand = message.message.trim() === '/clear';
                const isModelCommand = message.message.trim() === '/model';
                const requiresFreshThread = isNewCommand || isClearCommand;
                const threadIdBeforeReset = this.currentThreadId ?? session.sessionId;
                const statusLabel = isNewCommand
                    ? 'Starting a new conversation...'
                    : isClearCommand
                        ? 'Resetting context...'
                    : isModelCommand
                        ? 'Restarting Codex session (model changed)...'
                        : 'Restarting Codex session...';

                logger.debug(`[Codex] Isolated command received – resetting session: ${message.message}`);
                messageBuffer.addMessage('═'.repeat(40), 'status');
                messageBuffer.addMessage(statusLabel, 'status');

                if (useAppServer) {
                    this.currentThreadId = null;
                    this.currentTurnId = null;
                    if (isNewCommand && this.appServerClient) {
                        try {
                            await this.appServerClient.disconnect();
                            await this.appServerClient.connect();
                            await this.appServerClient.initialize({
                                clientInfo: {
                                    name: 'hapi-codex-client',
                                    version: '1.0.0'
                                }
                            });
                            logger.debug('[Codex] App-server disconnected for /new reset');
                        } catch (error) {
                            logger.debug('[Codex] Failed to disconnect app-server for /new reset', error);
                        }
                    }
                } else {
                    if (isNewCommand) {
                        try {
                            await mcpClient?.disconnect();
                            await mcpClient?.connect();
                            logger.debug('[Codex] MCP client disconnected for /new reset');
                        } catch (error) {
                            logger.debug('[Codex] Failed to disconnect MCP client for /new reset', error);
                        }
                    } else {
                        mcpClient?.clearSession();
                    }
                }
                wasCreated = false;
                currentModeHash = null;
                if (requiresFreshThread) {
                    previousThreadIdBeforeReset = threadIdBeforeReset;
                    forceFreshThread = true;
                    clearResumeThreadReference();
                }
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                turnInFlight = false;
                session.onThinkingChange(false);
                if (isNewCommand) {
                    session.sendSessionEvent({ type: 'message', message: 'Started a new conversation' });
                } else if (isClearCommand) {
                    session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                }
                sendReady();
                continue;
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

            // Signal thinking immediately when processing begins (matches Claude behavior)
            session.onThinkingChange(true);

            try {
                if (!wasCreated) {
                    if (useAppServer && appServerClient) {
                        const threadParams = buildThreadStartParams({
                            mode: message.mode,
                            mcpServers,
                            cliOverrides: session.codexCliOverrides
                        });

                        const canResumeExistingThread = first && !forceFreshThread;
                        const resumeCandidate = canResumeExistingThread ? session.sessionId : null;
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

                            if (forceFreshThread && previousThreadIdBeforeReset && threadId === previousThreadIdBeforeReset) {
                                logger.warn(`[Codex] thread/start returned same thread after reset (${threadId}), forcing app-server restart and retry`);
                                await appServerClient.disconnect();
                                await appServerClient.connect();
                                await appServerClient.initialize({
                                    clientInfo: {
                                        name: 'hapi-codex-client',
                                        version: '1.0.0'
                                    }
                                });
                                const retriedThreadResponse = await appServerClient.startThread(threadParams, {
                                    signal: this.abortController.signal
                                });
                                const retriedThreadRecord = asRecord(retriedThreadResponse);
                                const retriedThread = retriedThreadRecord ? asRecord(retriedThreadRecord.thread) : null;
                                const retriedThreadId = asString(retriedThread?.id);
                                if (!retriedThreadId) {
                                    throw new Error('app-server thread/start retry did not return thread.id');
                                }
                                threadId = retriedThreadId;
                            }
                        }

                        if (!threadId) {
                            throw new Error('app-server resume did not return thread.id');
                        }

                        this.currentThreadId = threadId;
                        session.onSessionFound(threadId);
                        forceFreshThread = false;
                        previousThreadIdBeforeReset = null;

                        const turnParams = buildTurnStartParams({
                            threadId,
                            message: message.message,
                            mode: message.mode,
                            cliOverrides: session.codexCliOverrides
                        });
                        turnInFlight = true;
                        const turnResponse = await appServerClient.startTurn(turnParams, {
                            signal: this.abortController.signal
                        });
                        const turnRecord = asRecord(turnResponse);
                        const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                        const turnId = asString(turn?.id);
                        if (turnId) {
                            this.currentTurnId = turnId;
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
                    lastDisconnectedRetryKey = null;
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
                    const turnResponse = await appServerClient.startTurn(turnParams, {
                        signal: this.abortController.signal
                    });
                    const turnRecord = asRecord(turnResponse);
                    const turn = turnRecord ? asRecord(turnRecord.turn) : null;
                    const turnId = asString(turn?.id);
                    if (turnId) {
                        this.currentTurnId = turnId;
                    }
                } else if (mcpClient) {
                    await mcpClient.continueSession(message.message, { signal: this.abortController.signal });
                    syncSessionId();
                    lastDisconnectedRetryKey = null;
                }
            } catch (error) {
                logger.warn('Error in codex session:', error);
                const isAbortError = error instanceof Error && error.name === 'AbortError';
                const isDisconnectedTransportError = error instanceof Error
                    && error.message.toLowerCase().includes('disconnected transport');
                if (useAppServer) {
                    turnInFlight = false;
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
                    let sentSpecificError = false;
                    if (!useAppServer && isDisconnectedTransportError) {
                        const retryKey = `${message.hash}:${message.message}`;
                        if (lastDisconnectedRetryKey !== retryKey) {
                            logger.debug('[Codex] Disconnected transport detected, resetting session and retrying once');
                            lastDisconnectedRetryKey = retryKey;
                            wasCreated = false;
                            currentModeHash = null;
                            mcpClient?.clearSession();
                            pending = message;
                            continue;
                        }

                        lastDisconnectedRetryKey = null;
                        wasCreated = false;
                        currentModeHash = null;
                        mcpClient?.clearSession();
                        messageBuffer.addMessage('Codex transport disconnected. Please resend your message.', 'status');
                        session.sendSessionEvent({ type: 'message', message: 'Codex transport disconnected. Please resend your message.' });
                        sentSpecificError = true;
                    } else {
                        messageBuffer.addMessage('Process exited unexpectedly', 'status');
                    }
                    if (!sentSpecificError) {
                        session.sendSessionEvent({ type: 'message', message: 'Process exited unexpectedly' });
                    }
                    if (useAppServer) {
                        this.currentTurnId = null;
                        this.currentThreadId = null;
                        wasCreated = false;
                    }
                }
            } finally {
                permissionHandler.reset();
                reasoningProcessor.abort();
                diffProcessor.reset();
                if (!useAppServer || !turnInFlight) {
                    appServerEventConverter?.reset();
                    session.onThinkingChange(false);
                }
                if (!useAppServer || !turnInFlight) {
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
