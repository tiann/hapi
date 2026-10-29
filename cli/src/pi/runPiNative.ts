import { bootstrapExistingSession, bootstrapSession, type SessionBootstrapResult } from '@/agent/sessionFactory';
import { createRunnerLifecycle, type RunnerLifecycle } from '@/agent/runnerLifecycle';
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand';
import { getInvokedCwd } from '@/utils/invokedCwd';
import { logger } from '@/ui/logger';
import { restoreTerminalState } from '@/ui/terminalState';
import { registerKillSessionHandler } from '@/claude/registerKillSessionHandler';
import { PiNativeTransport, type PiNativeEvent } from './native/transport';
import { PiNativeSessionBridge, type PiNativeState } from './native/session';
import { materializePiTitleExtension } from './titleExtension';
import type { SessionEndReason } from '@hapi/protocol';

export type PiLaunchOptions = {
    startedBy?: 'runner' | 'terminal';
    startingMode?: 'local' | 'remote';
    model?: string;
    effort?: string;
    resumeSessionId?: string;
    existingSessionId?: string;
    reservedSessionId?: string;
    workingDirectory?: string;
};

/** Native TUI requires its own terminal. Runner/no-TTY launches keep RPC mode. */
export function shouldUsePiNativeTui(options: PiLaunchOptions, terminal = {
    stdin: Boolean(process.stdin.isTTY), stdout: Boolean(process.stdout.isTTY),
}): boolean {
    return options.startedBy !== 'runner' && options.startingMode !== 'remote' && terminal.stdin && terminal.stdout;
}

export async function runPiNative(options: PiLaunchOptions): Promise<void> {
    const cwd = options.workingDirectory ?? getInvokedCwd();
    const args: string[] = ['--extension', await materializePiTitleExtension()];
    if (options.resumeSessionId) args.push('--session', options.resumeSessionId);
    if (options.model) args.push('--model', options.model);
    if (options.effort) args.push('--thinking', options.effort);
    const transport = new PiNativeTransport({ command: getAgentLaunchCommand('pi'), args, cwd });
    let binding: PiNativeSessionBridge | null = null;
    let lifecycle: RunnerLifecycle | null = null;
    let firstSession = true;
    let stopping = false;
    let exitCode = 0;
    let eventChain = Promise.resolve();
    let latestContext: string | null = null;
    const contextKey = (state: PiNativeState) => `${state.sessionId}:${state.sessionGeneration}`;
    let resolveClosed!: () => void;
    const closed = new Promise<void>(resolve => { resolveClosed = resolve; });

    const retireBinding = async (reason: string, endReason: SessionEndReason = 'completed') => {
        binding?.deactivate();
        binding = null;
        const previous = lifecycle;
        lifecycle = null;
        if (previous) {
            previous.setArchiveReason(reason);
            previous.setSessionEndReason(endReason);
            await previous.cleanup();
        }
    };

    const stop = async (code: number, reason: string, endReason: SessionEndReason = code === 0 ? 'completed' : 'error') => {
        if (stopping) return;
        stopping = true;
        exitCode = code;
        // Only an explicit stop or process shutdown kills the native engine.
        // A Hub reconnect never starts a replacement Pi or replays its inputs.
        transport.kill();
        try {
            await eventChain.catch(() => {});
            await retireBinding(reason, endReason);
        } catch (error) {
            exitCode = 1;
            logger.debug('[pi-native] Cleanup failed:', error);
        } finally {
            resolveClosed();
        }
    };

    const openBinding = async (state: PiNativeState, replayHistory: boolean) => {
        if (stopping) return;
        if (!state?.sessionId) throw new Error('Pi native bridge did not report a session identity');
        if (contextKey(state) !== latestContext) return;
        if (firstSession && options.resumeSessionId && !state.sessionId.startsWith(options.resumeSessionId) && state.sessionFile !== options.resumeSessionId) {
            throw new Error('Pi native bridge loaded a different session than requested');
        }
        await retireBinding('Continued in another Pi conversation');
        let bootstrap: SessionBootstrapResult;
        if (firstSession && options.existingSessionId) {
            bootstrap = await bootstrapExistingSession({ sessionId: options.existingSessionId, flavor: 'pi', startedBy: 'terminal', workingDirectory: cwd });
        } else {
            bootstrap = await bootstrapSession({ flavor: 'pi', startedBy: 'terminal', workingDirectory: cwd,
                reservedSessionId: firstSession ? options.reservedSessionId : undefined });
        }
        firstSession = false;
        if (stopping || contextKey(state) !== latestContext) {
            const abandoned = createRunnerLifecycle({ session: bootstrap.session, logTag: 'pi-native', restoreTerminal: false });
            abandoned.setArchiveReason('Pi changed conversation during startup');
            abandoned.setSessionEndReason('completed');
            await abandoned.cleanup();
            return;
        }
        const current = new PiNativeSessionBridge(bootstrap.session, state.sessionId,
            (command, sessionId) => transport.request(command, sessionId));
        binding = current;
        lifecycle = createRunnerLifecycle({ session: bootstrap.session, logTag: 'pi-native', stopKeepAlive: () => current.deactivate(), restoreTerminal: false });
        registerKillSessionHandler(bootstrap.session.rpcHandlerManager, {
            cleanupAndExit: async () => {
                if (binding !== current) throw new Error('This Pi conversation is no longer active');
                await stop(0, 'User terminated', 'terminated');
            },
        }, bootstrap.session);
        await current.initialize(state, replayHistory);
    };

    const onEvent = async ({ sessionId, event }: PiNativeEvent) => {
        if (stopping) return;
        if (event.type === 'session_start') {
            const state = event.state as PiNativeState;
            if (contextKey(state) !== latestContext) return;
            if (binding?.nativeSessionId === sessionId) {
                // /reload reinstalls the extension without changing conversation.
                await binding.initialize(state, false);
            } else {
                await openBinding(state, !(firstSession && options.existingSessionId));
            }
            return;
        }
        if (!binding || binding.nativeSessionId !== sessionId) return;
        if (event.type === 'session_shutdown' || event.type === 'bridge_disconnected') {
            // Immediately disable old-row callbacks before awaiting a new bootstrap.
            binding.suspend();
            return;
        }
        if (event.type === 'session_tree' && event.state) {
            await openBinding(event.state as PiNativeState, true);
            return;
        }
        binding.handleEvent(event);
    };

    transport.onEvent(event => {
        if ((event.event.type === 'session_start' || event.event.type === 'session_tree') && event.event.state) {
            latestContext = contextKey(event.event.state as PiNativeState);
            binding?.suspend();
        } else if (event.event.type === 'session_shutdown' || event.event.type === 'bridge_disconnected') {
            latestContext = null;
            if (binding?.nativeSessionId === event.sessionId) binding.suspend();
        }
        eventChain = eventChain.then(() => onEvent(event)).catch(error => {
            logger.debug('[pi-native] Bridge failed:', error);
            // Exit the wrapper on an identity/bootstrap failure; never silently
            // keep a web row attached to an unknown native conversation.
            void stop(1, 'Pi bridge failed');
        });
    });
    transport.onError(error => {
        logger.debug('[pi-native] Transport failed:', error);
        void stop(1, 'Pi bridge failed');
    });
    transport.onClose((code, signal) => {
        void stop(code ?? (signal ? 1 : 0), signal ? `Pi terminated by ${signal}` : 'Pi terminal closed');
    });
    const onInterrupt = () => { void stop(0, 'User terminated', 'terminated'); };
    const onTerminate = () => { void stop(0, 'Hub restart', 'terminated'); };
    const onCrash = (error: unknown) => {
        logger.debug('[pi-native] Wrapper crashed:', error);
        void stop(1, 'Pi bridge crashed');
    };
    process.on('SIGINT', onInterrupt);
    process.on('SIGTERM', onTerminate);
    process.on('uncaughtException', onCrash);
    process.on('unhandledRejection', onCrash);
    try {
        await transport.start();
        await closed;
    } finally {
        stopping = true;
        process.off('SIGINT', onInterrupt);
        process.off('SIGTERM', onTerminate);
        process.off('uncaughtException', onCrash);
        process.off('unhandledRejection', onCrash);
        transport.kill();
        await eventChain.catch(() => {});
        await retireBinding('Pi terminal closed');
        restoreTerminalState();
    }
    if (exitCode !== 0) throw new Error(`Pi native session exited with code ${exitCode}`);
}
