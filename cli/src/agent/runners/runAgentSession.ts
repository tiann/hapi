import type { AgentState, SessionPermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { AgentRegistry } from '@/agent/AgentRegistry';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentBackend, PromptContent } from '@/agent/types';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { bootstrapSession } from '@/agent/sessionFactory';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { getPermissionModesForFlavor, type PermissionMode } from '@hapi/protocol';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';
import type { SessionEndReason } from '@hapi/protocol';

function emitReadyIfIdle(props: {
    queueSize: () => number;
    shouldExit: boolean;
    thinking: boolean;
    sendReady: () => void;
}): void {
    if (props.shouldExit) return;
    if (props.thinking) return;
    if (props.queueSize() > 0) return;
    props.sendReady();
}

export async function runAgentSession(opts: {
    agentType: string;
    startedBy?: 'runner' | 'terminal';
    permissionMode?: SessionPermissionMode;
    allowedPermissionModes?: readonly PermissionMode[];
    model?: string;
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const initialState: AgentState = {
        controlledByUser: false
    };
    const { session, sessionInfo } = await bootstrapSession({
        flavor: opts.agentType,
        startedBy: opts.startedBy ?? 'terminal',
        workingDirectory,
        agentState: initialState
    });

    session.updateAgentState((currentState) => ({
        ...currentState,
        controlledByUser: false
    }));

    const messageQueue = new MessageQueue2<Record<string, never>>(() => hashObject({}));

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, {}, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[agent] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found (best-effort)'}`);
        return removed;
    });

    let currentPermissionMode: SessionPermissionMode = opts.permissionMode ?? sessionInfo.permissionMode ?? 'default';
    let currentModel: string | null | undefined = sessionInfo.model ?? undefined

    const backend: AgentBackend = AgentRegistry.create(opts.agentType);
    await backend.initialize();

    const permissionAdapter = new PermissionAdapter(session, backend, () => currentPermissionMode);

    const happyServer = await startHappyServer(session);
    const bridgeCommand = getHappyCliCommand(['mcp', '--url', happyServer.url]);
    const mcpServers = [
        {
            name: 'happy',
            command: bridgeCommand.command,
            args: bridgeCommand.args,
            env: []
        }
    ];

    const agentSessionId = await backend.newSession({
        cwd: workingDirectory,
        mcpServers
    });
    if (opts.model) {
        try {
            if (backend.setModel) {
                await backend.setModel(agentSessionId, opts.model)
                currentModel = opts.model
            } else {
                logger.warn(`[agent] Agent ${opts.agentType} does not support runtime model selection; using backend default model.`)
                session.sendSessionEvent({
                    type: 'message',
                    message: `Agent ${opts.agentType} does not support runtime model selection; using the default model.`
                })
            }
        } catch (error) {
            logger.warn('[agent] Initial model selection failed', error)
            session.sendSessionEvent({
                type: 'message',
                message: 'Agent model selection failed. Continuing with the default model.'
            })
        }
    }

    let thinking = false;
    let shouldExit = false;
    let waitAbortController: AbortController | null = null;

    const syncKeepAlive = () => {
        session.keepAlive(thinking, 'remote', {
            permissionMode: currentPermissionMode,
            ...(currentModel !== undefined ? { model: currentModel } : {})
        });
    };

    const allowedPermissionModes = opts.allowedPermissionModes ?? getPermissionModesForFlavor(opts.agentType);
    const resolvePermissionMode = (value: unknown): SessionPermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !allowedPermissionModes.includes(parsed.data)) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as SessionPermissionMode;
    };

    session.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown };

        if (config.permissionMode !== undefined) {
            currentPermissionMode = resolvePermissionMode(config.permissionMode);
        }

        syncKeepAlive();
        return { applied: { permissionMode: currentPermissionMode } };
    });

    syncKeepAlive();
    const keepAliveInterval = setInterval(() => {
        syncKeepAlive();
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };

    const handleAbort = async () => {
        logger.debug('[ACP] Abort requested');
        await backend.cancelPrompt(agentSessionId);
        await permissionAdapter.cancelAll('User aborted');
        thinking = false;
        syncKeepAlive();
        sendReady();
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    session.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        await handleAbort();
    });

    const handleKillSession = async () => {
        if (shouldExit) return;
        shouldExit = true;
        await permissionAdapter.cancelAll('Session killed');
        if (waitAbortController) {
            waitAbortController.abort();
        }
    };

    registerKillSessionHandler(session.rpcHandlerManager, handleKillSession);

    let sessionEndReason: SessionEndReason = 'completed';
    try {
        while (!shouldExit) {
            waitAbortController = new AbortController();
            const batch = await messageQueue.waitForMessagesAndGetAsString(waitAbortController.signal);
            waitAbortController = null;
            if (!batch) {
                if (shouldExit) {
                    break;
                }
                continue;
            }

            const promptContent: PromptContent[] = [{
                type: 'text',
                text: batch.message
            }];

            thinking = true;
            syncKeepAlive();

            try {
                await backend.prompt(agentSessionId, promptContent, (message) => {
                    const converted = convertAgentMessage(message);
                    if (converted) {
                        session.sendAgentMessage(converted);
                    }
                });
            } catch (error) {
                logger.warn('[ACP] Prompt failed', error);
                session.sendSessionEvent({
                    type: 'message',
                    message: 'Agent prompt failed. Check logs for details.'
                });
            } finally {
                thinking = false;
                syncKeepAlive();
                await permissionAdapter.cancelAll('Prompt finished');
                emitReadyIfIdle({
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    thinking,
                    sendReady
                });
            }
        }
        if (shouldExit) {
            sessionEndReason = 'terminated';
        }
    } catch (error) {
        sessionEndReason = 'error';
        throw error;
    } finally {
        clearInterval(keepAliveInterval);
        await permissionAdapter.cancelAll('Session ended');
        session.sendSessionDeath(sessionEndReason);
        await session.flush();
        session.close();
        await backend.disconnect();
        happyServer.stop();
    }
}
