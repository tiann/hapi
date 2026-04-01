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
import { isPermissionModeAllowedForFlavor } from '@hapi/protocol';

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

    session.onUserMessage((message) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        messageQueue.push(formattedText, {});
    });

    let currentPermissionMode: SessionPermissionMode = opts.permissionMode ?? sessionInfo.permissionMode ?? 'default';

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

    let thinking = false;
    let shouldExit = false;
    let waitAbortController: AbortController | null = null;

    const syncKeepAlive = () => {
        session.keepAlive(thinking, 'remote', {
            permissionMode: currentPermissionMode
        });
    };

    const resolvePermissionMode = (value: unknown): SessionPermissionMode => {
        const parsed = PermissionModeSchema.safeParse(value);
        if (!parsed.success || !isPermissionModeAllowedForFlavor(parsed.data, opts.agentType)) {
            throw new Error('Invalid permission mode');
        }
        return parsed.data as SessionPermissionMode;
    };

    session.rpcHandlerManager.registerHandler('set-session-config', async (payload: unknown) => {
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

    session.rpcHandlerManager.registerHandler('abort', async () => {
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
    } finally {
        clearInterval(keepAliveInterval);
        await permissionAdapter.cancelAll('Session ended');
        session.sendSessionDeath();
        await session.flush();
        session.close();
        await backend.disconnect();
        happyServer.stop();
    }
}
