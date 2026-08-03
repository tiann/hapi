import { randomUUID } from 'node:crypto';
import { logger } from '@/ui/logger';
import { agyLoop } from './loop';
import { MessageQueue2 } from '@/utils/MessageQueue2';
import { hashObject } from '@/utils/deterministicJson';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import type { AgentState } from '@/api/types';
import type { AgyMode, PermissionMode } from './types';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createModeChangeHandler, createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import type { SessionEffort, SessionModel } from '@/api/types';
import { startHookServer } from '@/claude/utils/startHookServer';
import { AgyPermissionHandler } from './utils/agyPermissionHandler';
import { buildAgyHooksJson } from '@/modules/common/hooks/generateHookSettings';
import { prepareAgyHookCarrier, cleanupAgyHookCarrier } from './utils/agyHookCarrier';
import { shellJoin } from '@/modules/common/shellQuote';
import { getHappyCliCommand } from '@/utils/spawnHappyCLI';
import { extractToolName, extractToolInput, extractToolUseId } from '@/claude/utils/startHookServer';
import { buildHapiMcpBridge } from '@/codex/utils/buildHapiMcpBridge';

export async function runAgy(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote' | 'pty';
    permissionMode?: PermissionMode;
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';

    logger.debug(`[agy] Starting with options: startedBy=${startedBy}, startingMode=${opts.startingMode}`);

    const startingMode: 'local' | 'remote' | 'pty' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'pty');

    const initialState: AgentState = {
        controlledByUser: false,
        // Persist launch mode so reopen/resume restores it (agy is 'pty').
        startingMode
    };

    const initialModel = opts.model ?? null;

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'agy',
            startedBy,
            workingDirectory
        })
        : await bootstrapSession({
            flavor: 'agy',
            startedBy,
            workingDirectory,
            tag: `__hapi_pty__agy-${randomUUID()}`,
            agentState: initialState,
            model: initialModel ?? undefined,
            effort: opts.effort ?? undefined
        });
    const { api, session } = bootstrap;

    // Pass the real mode (not pty→remote) so agentState.startingMode persists as
    // 'pty' for reopen; controlledByUser is still false for pty (mode !== 'local').
    setControlledByUser(session, startingMode);

    const isPtyMode = startingMode === 'pty';

    const messageQueue = new MessageQueue2<AgyMode>((mode) => hashObject({
        permissionMode: mode.permissionMode,
    }));

    const sessionWrapperRef: { current: any | null } = { current: null };
    let currentPermissionMode: PermissionMode = opts.permissionMode ?? 'request-review';
    let sessionModel: SessionModel = initialModel;
    let sessionEffort: SessionEffort | undefined = opts.effort ?? undefined;

    // PTY-mode tool-approval bridge: start a hook server and wire up the agy
    // permission handler. Null in non-PTY modes (no hook is registered).
    let agyPermissionHandler: AgyPermissionHandler | null = null;
    let hookServer: Awaited<ReturnType<typeof startHookServer>> | null = null;
    let hapiMcpBridge: Awaited<ReturnType<typeof buildHapiMcpBridge>> | null = null;
    let hookCarrierDir: string | undefined;

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'agy',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onBeforeClose: () => { sessionWrapperRef.current?.kill(); },
        onAfterClose: () => {
            agyPermissionHandler?.cancelAll('Session ended');
            hookServer?.stop();
            hapiMcpBridge?.server.stop();
            cleanupAgyHookCarrier(hookCarrierDir);
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    let crashed = false;

    try {
        if (isPtyMode) {
        hookServer = await startHookServer({
            onSessionHook: () => {
                // agy does not fire a SessionStart hook; this callback is a
                // no-op placeholder (the hook server route still responds 200).
            },
            onPreToolUse: async (data) => {
                if (!agyPermissionHandler) {
                    // Handler not up yet — fail closed.
                    return { permissionDecision: 'deny', reason: 'Permission handler not ready.' };
                }
                // Reliable path: every PreToolUse hook carries the brain's
                // conversationId. Persist it to session metadata on first sight
                // so resume works even if the scanner's content-match hasn't
                // fired yet. No-op if the session already has a UUID (set by
                // the scanner's onBrainFound or a resume seed).
                if (data.conversationId) {
                    const wrapper = sessionWrapperRef.current as { sessionId?: string | null; onSessionFound?: (id: string) => void } | null;
                    if (wrapper && !wrapper.sessionId && typeof wrapper.onSessionFound === 'function') {
                        logger.debug(`[agy] brain UUID from PreToolUse hook: ${data.conversationId}`);
                        wrapper.onSessionFound(data.conversationId);
                    }
                }
                const toolName = extractToolName(data) ?? '';
                const toolInput = extractToolInput(data);
                const toolUseId = extractToolUseId(data) ?? `${toolName}-${Date.now()}`;
                return agyPermissionHandler.requestDecision(toolUseId, toolName, toolInput);
            }
        });
        logger.debug(`[agy] Hook server started on port ${hookServer.port}`);

        // Keep endpoint secrets out of the carrier; the hook reads them from
        // the AGY child environment via --from-env.
        const { command, args } = getHappyCliCommand([
            'hook-forwarder', '--flavor', 'agy', '--from-env'
        ]);
        let hookCommand: string;
        try {
            hookCommand = shellJoin([command, ...args]);
        } catch (error) {
            throw new Error('agy PTY session aborted: could not safely encode the hook command.', { cause: error });
        }

        const hooksJson = buildAgyHooksJson(hookCommand);
        let carrierResult: ReturnType<typeof prepareAgyHookCarrier>;
        try {
            hapiMcpBridge = await buildHapiMcpBridge(session, {
                skillLookup: { workingDirectory, flavor: 'agy' }
            });
            const { command: mcpCommand, args: mcpArgs } = hapiMcpBridge.mcpServers.hapi;
            carrierResult = prepareAgyHookCarrier(hooksJson, { command: mcpCommand, args: mcpArgs });
        } catch (error) {
            throw new Error('agy PTY session aborted: could not prepare the session-local HAPI MCP bridge.', { cause: error });
        }
        if (!carrierResult) {
            logger.debug('[agy] Failed to prepare hook carrier; aborting PTY session (fail-closed)');
            throw new Error(
                'agy PTY session aborted: could not prepare the hook carrier needed for the permission bridge. ' +
                'Check that the temporary directory is writable and has sufficient space.'
            );
        }
        hookCarrierDir = carrierResult.carrierDir;
        logger.debug(`[agy] Hook carrier prepared at ${carrierResult.carrierDir}`);

        agyPermissionHandler = new AgyPermissionHandler(session, {
            getPermissionMode: () => currentPermissionMode,
            onModeChange: (mode) => {
                // agy only has request-review/always-proceed. Ignore any other (claude) mode rather
                // than laundering it into agy session state via a cast — the web
                // mode picker for agy never offers them, but guard defensively.
                if (mode === 'request-review' || mode === 'always-proceed') {
                    currentPermissionMode = mode;
                    sessionWrapperRef.current?.setPermissionMode(mode);
                }
            }
        });
    }

    const syncSessionMode = () => {
        const sessionInstance = sessionWrapperRef.current;
        if (!sessionInstance) return;
        sessionInstance.setPermissionMode(currentPermissionMode);
        sessionInstance.setModel(sessionModel);
        sessionInstance.setEffort(sessionEffort);
        sessionInstance.pushKeepAlive();
        logger.debug(`[agy] Synced session config: permissionMode=${currentPermissionMode}, model=${sessionModel ?? '(default)'}`);
    };

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        const mode: AgyMode = {
            permissionMode: currentPermissionMode,
        };
        messageQueue.push(formattedText, mode, localId);
    });

    session.onCancelQueuedMessage((localId) => {
        const removed = messageQueue.cancelByLocalId(localId);
        logger.debug(`[agy] cancelByLocalId(${localId}): ${removed ? 'removed' : 'not found'}`);
        return removed;
    });

    registerSessionConfigRpc<PermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'agy',
        modelMode: 'nullable',
        onApply: async (config) => {
            if (config.model !== undefined && config.model !== sessionModel) {
                const sessionInstance = sessionWrapperRef.current;
                if (!sessionInstance) throw new Error('AGY PTY is not ready for a live model change');
                await sessionInstance.applyLiveModel(config.model);
            }
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode;
            }
            if (config.model !== undefined) {
                sessionModel = config.model;
            }
        },
        onAfterApply: syncSessionMode
    });

        await agyLoop({
            path: workingDirectory,
            startingMode,
            startedBy,
            messageQueue,
            session,
            api,
            permissionMode: currentPermissionMode,
            model: sessionModel ?? undefined,
            effort: sessionEffort,
            resumeSessionId: opts.resumeSessionId,
            hookCarrierDir,
            hookPort: hookServer?.port,
            hookToken: hookServer?.token,
            agyPermissionHandler,
            onModeChange: createModeChangeHandler(session),
            onSessionReady: (instance) => {
                sessionWrapperRef.current = instance;
                syncSessionMode();
            }
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        logger.debug('[agy] Loop error:', error);
    } finally {
        if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await lifecycle.cleanupAndExit();
    }
}
