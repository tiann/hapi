import type { AgentState, SessionPermissionMode } from '@/api/types';
import { logger } from '@/ui/logger';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { randomUUID } from 'node:crypto';
import { AgentRegistry } from '@/agent/AgentRegistry';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PermissionAdapter } from '@/agent/permissionAdapter';
import type { AgentBackend, AgentSessionConfig, AgentSessionHandle, PromptContent } from '@/agent/types';
import { startHappyServer } from '@/claude/utils/startHappyServer';
import { applyHapiTitleToMetadata, syncHapiMetadataTitleToCodexThread } from '@/codex/utils/codexThreadTitle';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { bootstrapSession } from '@/agent/sessionFactory';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PermissionModeSchema } from '@hapi/protocol/schemas';
import { isHermesMoaPreset, isPermissionModeAllowedForFlavor, supportsModelChange } from '@hapi/protocol';
import { applyHapiSessionEnvironment } from '@/agent/sessionEnvironment';
import { notifyRunnerNativeIdentity } from '@/runner/controlClient';
import { createRunnerLifecycle } from '@/agent/runnerLifecycle';

export type ManagedAgentLaunchContext = {
    launchNonce: string;
    resumeProfileFingerprint: string;
    expectedNativeResumeId?: string;
};

export function consumeManagedAgentLaunchContext(env: NodeJS.ProcessEnv = process.env): ManagedAgentLaunchContext | null {
    const launchNonce = env.HAPI_LAUNCH_NONCE;
    const resumeProfileFingerprint = env.HAPI_RESUME_PROFILE_FINGERPRINT;
    const expectedNativeResumeId = env.HAPI_EXPECTED_NATIVE_RESUME_ID;
    delete env.HAPI_LAUNCH_NONCE;
    delete env.HAPI_RUNNER_INSTANCE_ID;
    delete env.HAPI_RESUME_PROFILE_FINGERPRINT;
    delete env.HAPI_EXPECTED_NATIVE_RESUME_ID;
    if (!launchNonce) return null;
    if (!resumeProfileFingerprint) throw new Error('Managed agent launch is missing its resume profile fingerprint');
    return { launchNonce, resumeProfileFingerprint, ...(expectedNativeResumeId ? { expectedNativeResumeId } : {}) };
}

export async function acknowledgeManagedAgentIdentity(
    context: ManagedAgentLaunchContext | null,
    nativeResumeId: string,
    notify: typeof notifyRunnerNativeIdentity = notifyRunnerNativeIdentity
): Promise<void> {
    if (!context) return;
    if (context.expectedNativeResumeId && context.expectedNativeResumeId !== nativeResumeId) {
        throw new Error('Managed agent native resume identity mismatch');
    }
    const result = await notify({
        launchNonce: context.launchNonce,
        pid: process.pid,
        nativeResumeId,
        resumeProfileFingerprint: context.resumeProfileFingerprint
    });
    if (!result.acknowledged) throw new Error('Runner rejected native identity ownership');
}

export async function cleanupFailedAgentSetup(resources: {
    backend: Pick<AgentBackend, 'disconnect'>;
    happyServer?: { stop: () => void } | null;
    session: { sendSessionDeath: () => void; flush: () => Promise<void>; close: () => void };
}): Promise<void> {
    const errors: unknown[] = [];
    const attempt = async (operation: () => Promise<void> | void) => {
        try { await operation(); } catch (error) { errors.push(error); }
    };
    await attempt(() => resources.happyServer?.stop());
    await attempt(() => resources.session.sendSessionDeath());
    await attempt(() => resources.session.flush());
    await attempt(() => resources.session.close());
    await attempt(() => resources.backend.disconnect());
    if (errors.length > 0) throw new AggregateError(errors, 'Agent setup cleanup failed');
}

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

export function resolveAgentSessionModel(agentType: string, value: unknown): string | null {
    if (value === null) {
        if (agentType === 'hermes-moa') {
            throw new Error('Hermes MoA preset is required');
        }
        return null;
    }
    if (!supportsModelChange(agentType)) {
        throw new Error('Model selection is not supported for this agent');
    }
    if (typeof value !== 'string' || value.trim().length === 0) {
        throw new Error('Invalid model');
    }
    const model = value.trim();
    if (agentType === 'hermes-moa' && !isHermesMoaPreset(model)) {
        throw new Error('Invalid Hermes MoA preset');
    }
    return model;
}

export async function runAgentSession(opts: {
    agentType: string;
    startedBy?: 'runner' | 'terminal';
    permissionMode?: SessionPermissionMode;
    model?: string | null;
    resumeSessionId?: string | null;
    agentSessionIdMetadataField?: 'hermesSessionId';
}): Promise<void> {
    const workingDirectory = getInvokedCwd();
    const initialState: AgentState = {
        controlledByUser: false
    };
    const { session, sessionInfo, reportStartedToRunner } = await bootstrapSession({
        flavor: opts.agentType,
        startedBy: opts.startedBy ?? 'terminal',
        workingDirectory,
        agentState: initialState,
        model: opts.model ?? undefined
    });
    applyHapiSessionEnvironment(sessionInfo.id);

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
    let currentModel: string | null = opts.model ?? sessionInfo.model ?? null;

    const backend: AgentBackend = AgentRegistry.create(opts.agentType);
    let permissionAdapter: PermissionAdapter | null = null;
    let happyServer: Awaited<ReturnType<typeof startHappyServer>> | null = null;
    let agentSessionId = '';
    let agentResumeSessionId = '';
    let managedLaunch: ManagedAgentLaunchContext | null = null;
    let keepAliveInterval: NodeJS.Timeout | null = null;
    let waitAbortController: AbortController | null = null;
    const lifecycle = createRunnerLifecycle({
        session,
        logTag: opts.agentType,
        onBeforeClose: async () => {
            if (keepAliveInterval) {
                clearInterval(keepAliveInterval);
                keepAliveInterval = null;
            }
            waitAbortController?.abort();
            await permissionAdapter?.cancelAll('Session ended').catch((error) => logger.warn('[ACP] Permission cleanup failed', error));
            happyServer?.stop();
            await backend.disconnect();
        }
    });
    // This must run before consumeManagedAgentLaunchContext: lifecycle creation
    // consumes the signed outcome FD while the nonce and runner id are intact.
    lifecycle.registerProcessHandlers();
    await reportStartedToRunner();
    const normalizeSessionHandle = (result: string | AgentSessionHandle): AgentSessionHandle =>
        typeof result === 'string' ? { sessionId: result, resumeSessionId: result } : result;
    try {
        // bootstrapSession has copied ownership metadata into the HAPI session;
        // consume it now, before any provider backend can initialize or spawn.
        managedLaunch = consumeManagedAgentLaunchContext();
        await backend.initialize();
        permissionAdapter = new PermissionAdapter(session, backend, () => currentPermissionMode);
        happyServer = await startHappyServer(session);
        const bridgeCommand = getHappyCliCommand(['mcp', '--url', happyServer.url]);
        const sessionConfig: AgentSessionConfig = {
            cwd: workingDirectory,
            mcpServers: [{ name: 'happy', command: bridgeCommand.command, args: bridgeCommand.args, env: [] }]
        };
        const agentSessionHandle = normalizeSessionHandle(
            opts.resumeSessionId && backend.resumeSession
                ? await backend.resumeSession(opts.resumeSessionId, sessionConfig)
                : await backend.newSession(sessionConfig)
        );
        agentSessionId = agentSessionHandle.sessionId;
        agentResumeSessionId = agentSessionHandle.resumeSessionId ?? agentSessionId;
        await acknowledgeManagedAgentIdentity(managedLaunch, agentResumeSessionId);
    } catch (error) {
        lifecycle.markCrash(error);
        await lifecycle.cleanupAndExit(1);
        return;
    }
    if (opts.agentSessionIdMetadataField) {
        const field = opts.agentSessionIdMetadataField;
        session.updateMetadata((metadata) => ({
            ...metadata,
            [field]: agentResumeSessionId
        }));
    }

    let thinking = false;
    let shouldExit = false;

    const syncKeepAlive = () => {
        session.keepAlive(thinking, 'remote', {
            permissionMode: currentPermissionMode,
            model: currentModel
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
        const config = payload as { permissionMode?: unknown; model?: unknown };
        const requested: { permissionMode?: SessionPermissionMode; model?: string | null } = {};

        if (config.permissionMode !== undefined) {
            requested.permissionMode = resolvePermissionMode(config.permissionMode);
        }

        if (config.model !== undefined) {
            requested.model = resolveAgentSessionModel(opts.agentType, config.model);
        }

        if (backend.setSessionConfig) {
            await backend.setSessionConfig(agentSessionId, requested);
        }

        if (requested.permissionMode !== undefined) {
            currentPermissionMode = requested.permissionMode;
        }

        if (requested.model !== undefined) {
            currentModel = requested.model;
        }

        syncKeepAlive();
        return {
            applied: {
                ...(requested.permissionMode !== undefined ? { permissionMode: currentPermissionMode } : {}),
                ...(requested.model !== undefined ? { model: currentModel } : {})
            }
        };
    });

    syncKeepAlive();
    keepAliveInterval = setInterval(() => {
        syncKeepAlive();
    }, 2000);

    const sendReady = () => {
        session.sendSessionEvent({ type: 'ready' });
    };
    const applyAgentTitle = (title: string) => {
        const cleanTitle = title.trim();
        if (!cleanTitle) return;
        session.sendClaudeSessionMessage({
            type: 'summary',
            summary: cleanTitle,
            leafUuid: randomUUID()
        });
        const metadata = session.getMetadataSnapshot();
        session.updateMetadata((currentMetadata) => applyHapiTitleToMetadata(currentMetadata, cleanTitle));
        void syncHapiMetadataTitleToCodexThread(metadata ? applyHapiTitleToMetadata(metadata, cleanTitle) : null);
    };

    const handleAbort = async () => {
        logger.debug('[ACP] Abort requested');
        await backend.cancelPrompt(agentSessionId);
        await permissionAdapter?.cancelAll('User aborted');
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
        await permissionAdapter?.cancelAll('Session killed');
        if (waitAbortController) {
            waitAbortController.abort();
        }
        await lifecycle.cleanupAndExit();
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
                    if (message.type === 'title') {
                        applyAgentTitle(message.title);
                        return;
                    }
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
                await permissionAdapter?.cancelAll('Prompt finished');
                emitReadyIfIdle({
                    queueSize: () => messageQueue.size(),
                    shouldExit,
                    thinking,
                    sendReady
                });
            }
        }
    } finally {
        await lifecycle.cleanupAndExit();
    }
}
