import { logger } from '@/ui/logger';
import { bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { convertAgentMessage } from '@/agent/messageConverter';
import { PiTransport } from './PiTransport';
import { convertPiEvent } from './PiEventConverter';
import { PiMessageAccumulator } from './PiMessageAccumulator';
import type { PiResponseEvent } from './types';
import type { PiPermissionMode } from '@hapi/protocol/modes';

export async function runPi(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PiPermissionMode;
    model?: string;
    resumeSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    logger.debug(`[pi] Starting with options: startedBy=${startedBy}, startingMode=${startingMode}`);

    const bootstrap = await bootstrapSession({
        flavor: 'pi',
        startedBy,
        workingDirectory,
        model: opts.model
    });
    const { session } = bootstrap;

    setControlledByUser(session, startingMode);

    let currentModel: string | null = opts.model ?? null;
    let currentPermissionMode: PiPermissionMode = opts.permissionMode ?? 'default';

    const transport = new PiTransport({ command: 'pi', args: ['--mode', 'rpc'], cwd: workingDirectory });

    // Keep-alive: send session-alive every 2s so hub doesn't expire the session (30s timeout)
    const keepAliveInterval = setInterval(() => {
        session.keepAlive(false, startingMode);
    }, 2000);

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'pi',
        stopKeepAlive: () => { clearInterval(keepAliveInterval); },
        onAfterClose: () => {
            clearInterval(keepAliveInterval);
            transport.kill();
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(session.rpcHandlerManager, lifecycle.cleanupAndExit);
    registerLocalHandoffHandler(session.rpcHandlerManager, lifecycle);

    // Cleanup guard — prevents double-cleanup from error/close/finally racing
    let cleanupInitiated = false;
    const safeCleanup = async () => {
        if (cleanupInitiated) return;
        cleanupInitiated = true;
        await lifecycle.cleanupAndExit();
    };

    // Pending user-message localIds in FIFO order. Pi's RPC protocol does not
    // echo the localId back on agent_start, so we rely on Pi processing
    // prompts in submission order. Each agent_start pops the oldest entry
    // and emits `messages-consumed` so the web UI transitions the user's
    // bubble from "queued" to "sent" — see Pi's protocol reference in
    // .xyz-harness/2026-06-05-hapi-pi-agent-backend/e2e-test-plan.md.
    const pendingLocalIds: string[] = [];

    const assistantMessageAccumulator = new PiMessageAccumulator();

// --- Transport event handlers ---

    transport.onError((error) => {
        logger.debug(`[pi] Transport error: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onClose((code, signal) => {
        const reason = signal
            ? `Pi process killed by signal ${signal}`
            : `Pi process exited with code ${code ?? 'null'}`;
        logger.debug(`[pi] ${reason}`);
        lifecycle.markCrash(new Error(reason));
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(reason.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onEvent((event) => {
        if (event.type === 'response') {
            handleResponse(event as unknown as PiResponseEvent, currentModel, (update) => {
                currentModel = update.model ?? currentModel;
                currentPermissionMode = update.permissionMode ?? currentPermissionMode;
            });
            return;
        }

        // Accumulate Pi text/thinking deltas into a single snapshot per
        // assistant message and flush on `message_end`. Without this,
        // each delta becomes a separate hub message → the web's reducer
        // (which dedupes reasoning by streamId but only WITHIN one
        // message's content array) would render the last delta as
        // the whole reasoning ("...") and stack every text delta as a
        // new agent-text block, producing a character-by-character
        // column. Matches codex's `ReasoningProcessor` pattern.
        const accumulated = assistantMessageAccumulator.handleEvent(event);
        if (accumulated.length > 0) {
            for (const msg of accumulated) {
                const converted = convertAgentMessage(msg);
                if (converted) session.sendAgentMessage(converted);
            }
        }

        // message_start/message_update/message_end are fully handled by
        // the accumulator. Skip the converter for them to avoid
        // duplicate emission.
        if (event.type === 'message_start' || event.type === 'message_update' || event.type === 'message_end') {
            // fall through to keep-alive handling below
        } else {
            const messages = convertPiEvent(event);
            for (const msg of messages) {
                // Route through the shared CLI → hub wire-format converter so
                // the rest of the system (hub / web) sees a codex-shaped
                // message rather than an internal `AgentMessage` shape.
                const converted = convertAgentMessage(msg);
                if (converted) {
                    session.sendAgentMessage(converted);
                }
            }
        }

        // Update keep-alive with thinking state for agent_start/turn_start/turn_end
        if (event.type === 'agent_start' || event.type === 'turn_start') {
            session.keepAlive(true, startingMode);
            // agent_start fires once per accepted prompt. Consume the
            // oldest pending localId so the user's bubble transitions
            // out of the floating queued bar. turn_start is intentionally
            // skipped — it can fire multiple times per agent run (e.g.
            // after tool calls) and does not correspond to a new prompt.
            if (event.type === 'agent_start' && pendingLocalIds.length > 0) {
                const oldestLocalId = pendingLocalIds.shift()!;
                session.emitMessagesConsumed([oldestLocalId]);
            }
        } else if (event.type === 'turn_end') {
            session.keepAlive(false, startingMode);
        }
    });

    function handleResponse(
        response: PiResponseEvent,
        model: string | null,
        onUpdate: (update: { model?: string | null; permissionMode?: PiPermissionMode }) => void
    ): void {
        const { command, success } = response;

        if (!success) {
            const error = response.error ?? 'Unknown Pi error';
            logger.debug(`[pi] RPC error for ${command}: ${error}`);
            session.sendSessionEvent({ type: 'message', message: error });
            // If Pi rejected a prompt, Pi will not emit agent_start, so the
            // matching localId would be stuck in the FIFO and poison the next
            // legitimate prompt. Consume it here so the user sees their
            // message transition out of the queued bar (the error is shown
            // as a session event above).  Only `prompt` carries a localId;
            // other commands are not user messages.
            if (command === 'prompt' && pendingLocalIds.length > 0) {
                const oldestLocalId = pendingLocalIds.shift()!;
                session.emitMessagesConsumed([oldestLocalId], { clearQueuedThinkingGrace: true });
            }
            return;
        }

        switch (command) {
            case 'get_state': {
                const data = response.data as Record<string, unknown> | undefined;
                if (data?.model) {
                    const modelObj = data.model as Record<string, unknown>;
                    const newModel = (modelObj.modelId as string) ?? model;
                    onUpdate({ model: newModel });
                    logger.debug(`[pi] Initial model: ${newModel}`);
                }
                break;
            }
            case 'set_model': {
                const data = response.data as Record<string, unknown> | undefined;
                if (data?.modelId) {
                    onUpdate({ model: data.modelId as string });
                }
                logger.debug(`[pi] Model changed to: ${(data?.modelId as string) ?? model}`);
                break;
            }
            case 'new_session':
                logger.debug('[pi] Pi session initialized');
                break;
            case 'abort':
                logger.debug('[pi] Abort confirmed');
                break;
            case 'prompt':
                logger.debug('[pi] Prompt accepted');
                break;
            default:
                logger.debug(`[pi] Response for ${command}`);
        }
    }

    // --- Session config RPC ---

    registerSessionConfigRpc<PiPermissionMode>({
        rpcHandlerManager: session.rpcHandlerManager,
        flavor: 'pi',
        modelMode: 'nullable',
        onApply: (config) => {
            if (config.permissionMode !== undefined) {
                currentPermissionMode = config.permissionMode;
            }
            if (config.model !== undefined) {
                currentModel = config.model;
            }
        },
        onAfterApply: () => {
            if (currentModel) {
                transport.send({ type: 'set_model', provider: '', modelId: currentModel });
            }
            session.keepAlive(false, startingMode);
        }
    });

    // --- User message handler ---

    session.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        if (localId) pendingLocalIds.push(localId);
        transport.send({ type: 'prompt', message: formattedText });
    });

    // --- Cancel handler ---

    session.rpcHandlerManager.registerHandler('cancel-prompt', async () => {
        transport.send({ type: 'abort' });
        return { success: true };
    });

    try {
        transport.start();

        transport.send({ type: 'new_session' });
        transport.send({ type: 'get_state' });

        // Block until cleanup is triggered by error/close handler
        await new Promise<void>((resolve) => {
            const origCleanup = lifecycle.cleanupAndExit.bind(lifecycle);
            lifecycle.cleanupAndExit = async (codeOverride?: number) => {
                resolve();
                await origCleanup(codeOverride);
            };
        });
    } catch (error) {
        lifecycle.markCrash(error);
        lifecycle.setSessionEndReason('error');
        logger.debug('[pi] Loop error:', error);
    } finally {
        await safeCleanup();
    }
}
