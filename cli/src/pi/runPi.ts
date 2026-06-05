import { logger } from '@/ui/logger';
import { bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { registerSessionConfigRpc } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PiTransport } from './PiTransport';
import { convertPiEvent } from './PiEventConverter';
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

    const lifecycle = createRunnerLifecycle({
        session,
        logTag: 'pi',
        stopKeepAlive: () => { /* Pi keep-alive handled by HAPI session */ },
        onAfterClose: () => {
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
            handleResponse(event as unknown as PiResponseEvent);
            return;
        }

        const messages = convertPiEvent(event);
        for (const msg of messages) {
            session.sendAgentMessage(msg);
        }
    });

    function handleResponse(response: PiResponseEvent): void {
        const { command, success } = response;

        if (!success) {
            const error = response.error ?? 'Unknown Pi error';
            logger.debug(`[pi] RPC error for ${command}: ${error}`);
            session.sendSessionEvent({ type: 'message', message: error });
            return;
        }

        switch (command) {
            case 'get_state': {
                const data = response.data as Record<string, unknown> | undefined;
                if (data?.model) {
                    const model = data.model as Record<string, unknown>;
                    currentModel = (model.modelId as string) ?? currentModel;
                    logger.debug(`[pi] Initial model: ${currentModel}`);
                }
                break;
            }
            case 'set_model': {
                const data = response.data as Record<string, unknown> | undefined;
                if (data?.modelId) {
                    currentModel = data.modelId as string;
                }
                logger.debug(`[pi] Model changed to: ${currentModel}`);
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

    session.onUserMessage((message) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
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
