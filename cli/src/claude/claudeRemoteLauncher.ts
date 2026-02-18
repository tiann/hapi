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
    clearContext?: boolean;
    autoApproveEdits?: boolean;
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
            version: process.env.npm_package_version
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
                                // Strip agent metadata text blocks (agentId, usage stats) from Task tool results
                                if (c.type === 'tool_result' && Array.isArray(c.content)) {
                                    const cleanContent = (c.content as any[]).filter((block: any) => {
                                        if (typeof block === 'object' && block !== null && block.type === 'text' && typeof block.text === 'string') {
                                            return !block.text.startsWith('agentId:');
                                        }
                                        return true;
                                    });
                                    if (cleanContent.length !== (c.content as any[]).length) {
                                        return { ...c, content: cleanContent.length === 1 ? cleanContent[0] : cleanContent };
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

                                if (response.clearContext !== undefined) {
                                    permissions.clearContext = response.clearContext;
                                }

                                if (response.autoApproveEdits !== undefined) {
                                    permissions.autoApproveEdits = response.autoApproveEdits;
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
            } | null = null;

            let previousSessionId: string | null = null;
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
                            if (pending) {
                                let p = pending;
                                pending = null;
                                permissionHandler.handleModeChange(p.mode.permissionMode);
                                return p;
                            }

                            let msg = await session.queue.waitForMessagesAndGetAsString(controller.signal);

                            if (msg) {
                                if ((modeHash && msg.hash !== modeHash) || msg.isolate) {
                                    logger.debug('[remote]: mode has changed, pending message');
                                    pending = msg;
                                    return null;
                                }
                                modeHash = msg.hash;
                                mode = msg.mode;
                                permissionHandler.handleModeChange(mode.permissionMode);
                                return {
                                    message: msg.message,
                                    mode: msg.mode
                                };
                            }

                            return null;
                        },
                        onSessionFound: (sessionId) => {
                            session.onSessionFound(sessionId);
                        },
                        onThinkingChange: session.onThinkingChange,
                        claudeEnvVars: session.claudeEnvVars,
                        claudeArgs: session.claudeArgs,
                        onMessage,
                        onCompletionEvent: (message: string) => {
                            logger.debug(`[remote]: Completion event: ${message}`);
                            session.client.sendSessionEvent({ type: 'message', message });
                        },
                        onSessionReset: () => {
                            logger.debug('[remote]: Session reset');
                            session.clearSessionId();
                        },
                        onReady: () => {
                            if (!pending && session.queue.size() === 0) {
                                session.client.sendSessionEvent({ type: 'ready' });
                            }
                        },
                        signal: controller.signal,
                    });

                    session.consumeOneTimeFlags();

                    if (!this.exitReason && controller.signal.aborted) {
                        session.client.sendSessionEvent({ type: 'message', message: 'Aborted by user' });
                    }
                } catch (e) {
                    const error = e instanceof Error
                        ? { message: e.message, stack: e.stack }
                        : { value: String(e) };
                    logger.debugLargeJson('[remote]: launch error', error);
                    if (!this.exitReason) {
                        const message = e instanceof Error && e.message
                            ? `Process exited unexpectedly: ${e.message}`
                            : 'Process exited unexpectedly';
                        session.client.sendSessionEvent({ type: 'message', message });
                        continue;
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
