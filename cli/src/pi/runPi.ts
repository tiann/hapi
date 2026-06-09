import { logger } from '@/ui/logger';
import { bootstrapExistingSession, bootstrapSession } from '@/agent/sessionFactory';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { registerLocalHandoffHandler } from '@/agent/localHandoff';
import { createRunnerLifecycle, setControlledByUser } from '@/agent/runnerLifecycle';
import { resolveSessionConfigPermissionMode } from '@/agent/sessionConfigRpc';
import { formatMessageWithAttachments } from '@/utils/attachmentFormatter';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { PiTransport } from './PiTransport';
import { PiSession } from './session';
import { parsePiModels, parsePiCommands, sendPiRpcAndWait, wireTransportEvents } from './loop';
import type { PiThinkingLevel } from './types';
import type { SlashCommandsResponse } from '@hapi/protocol/apiTypes';
import type { PiPermissionMode } from '@hapi/protocol/modes';
import type { ListPiModelsResponse } from '@hapi/protocol/apiTypes';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export async function runPi(opts: {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    permissionMode?: PiPermissionMode;
    model?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    workingDirectory?: string;
} = {}): Promise<void> {
    const workingDirectory = opts.workingDirectory ?? getInvokedCwd();
    const startedBy = opts.startedBy ?? 'terminal';
    const startingMode: 'local' | 'remote' = opts.startingMode
        ?? (startedBy === 'runner' ? 'remote' : 'local');

    logger.debug(`[pi] Starting with options: startedBy=${startedBy}, startingMode=${startingMode}`);

    const bootstrap = opts.existingSessionId
        ? await bootstrapExistingSession({
            sessionId: opts.existingSessionId,
            flavor: 'pi',
            startedBy,
            workingDirectory,
        })
        : await bootstrapSession({
            flavor: 'pi',
            startedBy,
            workingDirectory,
            model: opts.model
        });
    const { session: apiSession } = bootstrap;

    setControlledByUser(apiSession, startingMode);

    const piSession = new PiSession({
        api: bootstrap.api,
        client: apiSession,
        path: workingDirectory,
        logPath: logger.getLogPath(),
        startedBy,
        startingMode,
        permissionMode: opts.permissionMode,
        model: opts.model,
    });

    const transportArgs = ['--mode', 'rpc'];
    if (opts.resumeSessionId) {
        transportArgs.push('--session-id', opts.resumeSessionId);
    }
    const transport = new PiTransport({ command: 'pi', args: transportArgs, cwd: workingDirectory });

    piSession.startKeepAlive();

    let killedByCleanup = false;
    const lifecycle = createRunnerLifecycle({
        session: apiSession,
        logTag: 'pi',
        stopKeepAlive: () => piSession.stopKeepAlive(),
        onAfterClose: () => {
            piSession.stopKeepAlive();
            killedByCleanup = true;
            transport.kill();
        }
    });

    lifecycle.registerProcessHandlers();
    registerKillSessionHandler(apiSession.rpcHandlerManager, lifecycle.cleanupAndExit);
    registerLocalHandoffHandler(apiSession.rpcHandlerManager, lifecycle);

    let cleanupInitiated = false;
    const safeCleanup = async () => {
        if (cleanupInitiated) return;
        cleanupInitiated = true;
        await lifecycle.cleanupAndExit();
    };

    // Pending user-message localIds in FIFO order
    const pendingLocalIds: string[] = [];

    // --- Transport error/close handlers ---
    transport.onError((error) => {
        logger.debug(`[pi] Transport error: ${error.message}`);
        lifecycle.markCrash(error);
        lifecycle.setExitCode(1);
        lifecycle.setArchiveReason(error.message.slice(0, 200));
        lifecycle.setSessionEndReason('error');
        void safeCleanup();
    });

    transport.onClose((code, signal) => {
        if (killedByCleanup) {
            logger.debug(`[pi] Pi process closed during lifecycle cleanup (code=${code}, signal=${signal})`);
            void safeCleanup();
            return;
        }
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

    // --- Wire transport events to session ---
    wireTransportEvents(transport, piSession, pendingLocalIds);

    // --- Session config RPC ---
    const PI_THINKING_LEVELS = ['off', 'minimal', 'low', 'medium', 'high', 'xhigh'] as const;

    const resolveThinkingLevel = (value: unknown): PiThinkingLevel | null => {
        if (value === null) return null;
        if (typeof value !== 'string') throw new Error('Invalid effort');
        const trimmed = value.trim().toLowerCase();
        if (!trimmed) throw new Error('Invalid effort');
        if (!PI_THINKING_LEVELS.includes(trimmed as PiThinkingLevel)) {
            throw new Error('Invalid effort');
        }
        return trimmed as PiThinkingLevel;
    };

    const resolveModel = (value: unknown): string | null => {
        if (value === null) return null;
        if (typeof value !== 'string') throw new Error('Invalid model');
        const trimmed = value.trim();
        if (!trimmed) throw new Error('Invalid model');
        return trimmed;
    };

    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.SetSessionConfig, async (payload: unknown) => {
        if (!payload || typeof payload !== 'object') {
            throw new Error('Invalid session config payload');
        }
        const config = payload as { permissionMode?: unknown; model?: unknown; effort?: unknown };

        if (config.permissionMode !== undefined) {
            piSession.currentPermissionMode = resolveSessionConfigPermissionMode<PiPermissionMode>(config.permissionMode, 'pi');
        }
        if (config.model !== undefined) {
            piSession.currentModel = resolveModel(config.model);
        }
        if (config.effort !== undefined) {
            piSession.currentThinkingLevel = resolveThinkingLevel(config.effort);
        }

        // Forward changes to Pi process
        if (piSession.currentModel && piSession.currentProvider) {
            transport.send({ type: 'set_model', provider: piSession.currentProvider, modelId: piSession.currentModel });
        } else if (piSession.currentModel && !piSession.currentProvider) {
            logger.debug('[pi] set_model suppressed: provider unknown until get_state');
        }
        if (piSession.currentThinkingLevel) {
            transport.send({ type: 'set_thinking_level', level: piSession.currentThinkingLevel });
        }
        piSession.pushKeepAlive();

        return {
            applied: {
                permissionMode: piSession.currentPermissionMode,
                model: piSession.currentModel,
                effort: piSession.currentThinkingLevel
            }
        };
    });

    // --- Pi model discovery RPC ---
    apiSession.rpcHandlerManager.registerHandler<Record<string, never>, ListPiModelsResponse>(
        RPC_METHODS.ListPiModels,
        async () => {
            if (piSession.cachedPiModels.length > 0) {
                return {
                    success: true,
                    availableModels: piSession.cachedPiModels,
                    currentModelId: piSession.currentModel,
                };
            }
            try {
                const data = await sendPiRpcAndWait(transport, { type: 'get_available_models' });
                const models = parsePiModels(data);
                if (models.length > 0) {
                    piSession.cachedPiModels = models;
                }
                return { success: true, availableModels: models, currentModelId: piSession.currentModel };
            } catch (error) {
                logger.debug('[pi] ListPiModels RPC failed:', error);
                return {
                    success: false,
                    error: error instanceof Error ? error.message : 'Failed to list Pi models',
                };
            }
        }
    );

    // --- Slash commands (Pi skills/commands) ---
    apiSession.rpcHandlerManager.registerHandler<{ agent?: string }, SlashCommandsResponse>(
        RPC_METHODS.ListSlashCommands,
        async () => {
            let commands = piSession.cachedPiCommands;
            if (commands.length === 0) {
                try {
                    const data = await sendPiRpcAndWait(transport, { type: 'get_commands' });
                    commands = parsePiCommands(data);
                    if (commands.length > 0) {
                        piSession.cachedPiCommands = commands;
                    }
                } catch {
                    // Fall through to return empty
                }
            }
            return {
                success: true,
                commands: commands.map((cmd) => ({
                    name: cmd.name,
                    description: cmd.description,
                    source: cmd.source === 'skill' ? 'plugin' as const
                        : cmd.source === 'prompt' ? 'user' as const
                        : 'plugin' as const,
                })),
            };
        }
    );

    // --- User message handler ---
    apiSession.onUserMessage((message, localId) => {
        const formattedText = formatMessageWithAttachments(message.content.text, message.content.attachments);
        if (localId) pendingLocalIds.push(localId);
        if (piSession.piIsStreaming) {
            transport.send({ type: 'steer', message: formattedText });
        } else {
            transport.send({ type: 'prompt', message: formattedText });
        }
    });

    // --- Abort handler ---
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
        transport.send({ type: 'abort' });
        void lifecycle.cleanupAndExit();
        return { success: true };
    });

    // --- Switch handler ---
    apiSession.rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async () => {
        lifecycle.setArchiveReason('Session switched');
        lifecycle.setSessionEndReason('terminated');
        void lifecycle.cleanupAndExit();
    });

    // --- Run ---
    let crashed = false;
    try {
        transport.start();
        transport.send({ type: 'new_session' });
        transport.send({ type: 'get_state' });
        transport.send({ type: 'get_available_models' });
        transport.send({ type: 'get_commands' });

        // Block until cleanup is triggered by error/close handler
        await new Promise<void>((resolve) => {
            const origCleanup = lifecycle.cleanupAndExit.bind(lifecycle);
            lifecycle.cleanupAndExit = async (codeOverride?: number) => {
                resolve();
                await origCleanup(codeOverride);
            };
        });
    } catch (error) {
        crashed = true;
        lifecycle.markCrash(error);
        lifecycle.setSessionEndReason('error');
        logger.debug('[pi] Loop error:', error);
    } finally {
        if (!crashed) {
            lifecycle.setSessionEndReason('completed');
        }
        await safeCleanup();
    }
}
