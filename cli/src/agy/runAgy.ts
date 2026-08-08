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
import { prepareAgyHookCarrier, cleanupAgyHookCarrier, sweepAgyHookCarriers, warmCarrierScope } from './utils/agyHookCarrier';
import type { AgyMcpServerEntry } from './utils/agyHookCarrier';
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
    // hooks.json contents for the carrier's two PreInvocation states, and the
    // MCP server entry needed to rebuild the carrier from scratch — handed to
    // the session so agyPtyLauncher can self-detach the PreInvocation hook
    // once the brain UUID is confirmed (it fires on every model call and is
    // redundant after that) and reattach it before every respawn (see
    // AgySession's docstring and Phase 2.7 of the agy-preinvocation-discovery
    // plan). Undefined outside PTY mode, where no carrier is built.
    let hooksJsonWithPreInvocation: string | undefined;
    let hooksJsonWithoutPreInvocation: string | undefined;
    let hookMcpServer: AgyMcpServerEntry | undefined;

    // Adopts a brain UUID discovered via an agy hook into session metadata,
    // first-wins: never overwrites an already-set sessionId (set by a resume
    // seed or an earlier hook firing), so a resumed session's seeded UUID is
    // never clobbered by a later hook, and a UUID discovered by one hook is
    // never re-adopted (as a no-op) by another.
    const adoptBrainUuidIfUnset = (conversationId: string | undefined, source: string): void => {
        if (!conversationId) return;
        const wrapper = sessionWrapperRef.current as { sessionId?: string | null; onSessionFound?: (id: string) => void } | null;
        if (wrapper && !wrapper.sessionId && typeof wrapper.onSessionFound === 'function') {
            logger.debug(`[agy] brain UUID from ${source} hook: ${conversationId}`);
            wrapper.onSessionFound(conversationId);
        }
    };

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'agy',
        stopKeepAlive: () => sessionWrapperRef.current?.stopKeepAlive(),
        onBeforeClose: () => { sessionWrapperRef.current?.kill(); },
        onAfterClose: () => {
            agyPermissionHandler?.cancelAll('Session ended');
            hookServer?.stop();
            hapiMcpBridge?.server.stop();
            // Prefer the session's live hookCarrierDir: agyPtyLauncher's
            // respawn-reattach cycle can rebuild the carrier at a NEW path
            // (prepareAgyHookCarrier always mkdtemps a fresh directory) if
            // the original one vanished mid-session. Falling back to the
            // local variable covers every path where the session wrapper
            // never got assigned (e.g. setup failed before onSessionReady).
            cleanupAgyHookCarrier(sessionWrapperRef.current?.hookCarrierDir ?? hookCarrierDir);
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    let crashed = false;

    try {
        if (isPtyMode) {
        // Best-effort: reclaim carriers left behind by sessions whose
        // owning process has since died (crash, kill -9 — anything that
        // skips onAfterClose's cleanupAgyHookCarrier). Fired without await:
        // sweep is a backup path for teardown that normally already
        // happened via cleanupAgyHookCarrier (see that function and this
        // one's docstring), so it must never delay THIS session's own
        // startup (hook server, carrier prep, PTY spawn) -- there is no
        // urgency requirement on it. It runs concurrently with this
        // session's own prepareAgyHookCarrier() call below; see
        // agyHookCarrier.test.ts's "racing safety" suite for why that is
        // safe. Never throws/rejects; the .catch below is defense in depth
        // only (sweepAgyHookCarriers's own docstring documents why it
        // should never reach here).
        void sweepAgyHookCarriers().catch((error) => {
            logger.debug('[agy] sweep failed unexpectedly (fire-and-forget, non-fatal)', error);
        });

        // Fired here (without await) so the macOS probe cost (two child
        // processes: ioreg, sysctl) overlaps with the hook server startup
        // and MCP bridge setup below instead of adding to session startup
        // latency. Awaited just before prepareAgyHookCarrier() so that
        // call's synchronous writeOwnerMetadata reads a warm cache instead
        // of falling back to the (Linux-only) synchronous path. See
        // warmCarrierScope's docstring for the respawn-path (agyPtyLauncher.ts)
        // rationale -- it needs no equivalent wiring since it always runs in
        // this same, by-then-already-warm process. Same fire-and-forget
        // contract as sweepAgyHookCarriers just above (never throws/rejects
        // on its own -- see warmCarrierScope's docstring); the .catch here
        // is the same defense-in-depth, kept symmetric with the sweep call
        // above rather than trusting that contract alone (both feed into
        // the same runnerLifecycle unhandledRejection -> markCrash path).
        void warmCarrierScope().catch((error) => {
            logger.debug('[agy] warmCarrierScope failed unexpectedly (fire-and-forget, non-fatal)', error);
        });

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
                // so resume works even if no other hook has fired yet. No-op
                // if the session already has a UUID (set by an earlier hook
                // or a resume seed).
                adoptBrainUuidIfUnset(data.conversationId, 'PreToolUse');
                const toolName = extractToolName(data) ?? '';
                const toolInput = extractToolInput(data);
                const toolUseId = extractToolUseId(data) ?? `${toolName}-${Date.now()}`;
                return agyPermissionHandler.requestDecision(toolUseId, toolName, toolInput);
            },
            onAgyPreInvocation: (data) => {
                // PreInvocation fires before every model call, tool use or
                // not — unlike PreToolUse, which only fires once a tool
                // actually runs. Registering both means a brain UUID is
                // discovered even on tool-free turns (e.g. a plain "hi").
                // Same first-wins guard, same fail-open discovery contract —
                // this hook carries no permission decision to adjudicate.
                adoptBrainUuidIfUnset(data.conversationId, 'PreInvocation');
            }
        });
        logger.debug(`[agy] Hook server started on port ${hookServer.port}`);

        // Keep endpoint secrets out of the carrier; the hook reads them from
        // the AGY child environment via --from-env. Two distinct forwarder
        // commands are needed: PreToolUse and PreInvocation have different
        // stdin/stdout contracts (see sessionHookForwarder.ts), and agy has
        // no way to tell them apart from the payload shape alone — only the
        // explicit --event flag distinguishes them.
        const buildForwarderCommand = (extraArgs: string[], label: string): string => {
            const { command, args } = getHappyCliCommand([
                'hook-forwarder', '--flavor', 'agy', '--from-env', ...extraArgs
            ]);
            try {
                return shellJoin([command, ...args]);
            } catch (error) {
                throw new Error(`agy PTY session aborted: could not safely encode the ${label} hook command.`, { cause: error });
            }
        };
        const hookCommand = buildForwarderCommand([], 'PreToolUse');
        const preInvocationHookCommand = buildForwarderCommand(['--event', 'pre-invocation'], 'PreInvocation');

        // Two variants: the carrier is always built with PreInvocation (a
        // resume-failure right after a respawn needs it to discover the
        // replacement conversation's UUID), but agyPtyLauncher swaps to the
        // PreToolUse-only variant once discovery is confirmed, and back
        // before every respawn. See AgySession's docstring.
        hooksJsonWithPreInvocation = buildAgyHooksJson({
            preToolUseCommand: hookCommand,
            preInvocationCommand: preInvocationHookCommand
        });
        hooksJsonWithoutPreInvocation = buildAgyHooksJson({
            preToolUseCommand: hookCommand
        });
        let carrierResult: ReturnType<typeof prepareAgyHookCarrier>;
        try {
            hapiMcpBridge = await buildHapiMcpBridge(session, {
                skillLookup: { workingDirectory, flavor: 'agy' }
            });
            const { command: mcpCommand, args: mcpArgs } = hapiMcpBridge.mcpServers.hapi;
            hookMcpServer = { command: mcpCommand, args: mcpArgs };
            // warmCarrierScope() never rejects (see its docstring), so this
            // await cannot itself trigger the catch below.
            await warmCarrierScope();
            carrierResult = prepareAgyHookCarrier(hooksJsonWithPreInvocation, hookMcpServer);
        } catch (error) {
            throw new Error('agy PTY session aborted: could not prepare the session-local HAPI MCP bridge.', { cause: error });
        }
        if (!carrierResult) {
            logger.debug('[agy] Failed to prepare hook carrier; aborting PTY session (fail-closed)');
            throw new Error(
                'agy PTY session aborted: could not prepare the hook carrier needed for the permission bridge. ' +
                'Check that HAPI_HOME (default: ~/.hapi) is writable and has sufficient space.'
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
            hooksJsonWithPreInvocation,
            hooksJsonWithoutPreInvocation,
            hookMcpServer,
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
