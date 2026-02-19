import { logger } from '@/ui/logger';
import { codexLocal } from './codexLocal';
import { CodexSession } from './session';
import { createCodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

function isLocalResetCommand(message: string): boolean {
    const trimmed = message.trim();
    return trimmed === '/new' || trimmed === '/clear';
}

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    let currentSessionId = session.sessionId;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    try {
        // Outer loop: restarts the local process on /new or /clear
        while (true) {
            // Check if the queue already has a /new or /clear waiting
            const pending = session.queue.peek();
            if (pending && isLocalResetCommand(pending.message)) {
                const command = session.queue.shift()!;
                const isNew = command.message.trim() === '/new';
                logger.debug(`[codex-local]: Consumed queued ${command.message.trim()} command before launch`);

                if (isNew) {
                    currentSessionId = null;
                    session.sessionId = null;
                    session.sendSessionEvent({ type: 'message', message: 'Started a new conversation' });
                } else {
                    currentSessionId = null;
                    session.sessionId = null;
                    session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                }
                session.sendSessionEvent({ type: 'ready' });
                continue;
            }

            // If there are non-special messages queued, switch to remote to handle them
            if (session.queue.size() > 0) {
                return 'switch';
            }

            // Track whether a reset command caused the abort
            let resetCommand: string | null = null;

            const handleSessionFound = (sessionId: string) => {
                session.onSessionFound(sessionId);
                currentSessionId = sessionId;
                scanner?.onNewSession(sessionId);
            };

            // Wrap the queue so we can intercept /new and /clear
            // instead of switching to remote mode
            const interceptQueue = {
                size: () => session.queue.size(),
                reset: () => session.queue.reset(),
                setOnMessage: (callback: ((...args: unknown[]) => void) | null) => {
                    if (!callback) {
                        session.queue.setOnMessage(null);
                        return;
                    }
                    session.queue.setOnMessage((message: string) => {
                        if (isLocalResetCommand(message)) {
                            // Consume the command from the queue
                            const consumed = session.queue.shift();
                            if (consumed) {
                                resetCommand = consumed.message.trim();
                                logger.debug(`[codex-local]: Intercepted ${resetCommand} — requesting local restart`);
                            }
                            // Trigger the abort via the normal switch path
                            // (BaseLocalLauncher will kill the process)
                            callback();
                        } else {
                            // Normal message: switch to remote
                            callback();
                        }
                    });
                }
            };

            const launcher = new BaseLocalLauncher({
                label: 'codex-local',
                failureLabel: 'Local Codex process failed',
                queue: interceptQueue,
                rpcHandlerManager: session.client.rpcHandlerManager,
                startedBy: session.startedBy,
                startingMode: session.startingMode,
                launch: async (abortSignal) => {
                    await codexLocal({
                        path: session.path,
                        sessionId: currentSessionId,
                        onSessionFound: handleSessionFound,
                        abort: abortSignal,
                        codexArgs: session.codexArgs,
                        mcpServers
                    });
                },
                sendFailureMessage: (message) => {
                    session.sendSessionEvent({ type: 'message', message });
                },
                recordLocalLaunchFailure: (message, exitReason) => {
                    session.recordLocalLaunchFailure(message, exitReason);
                },
                abortLogMessage: 'doAbort',
                switchLogMessage: 'doSwitch'
            });

            const handleSessionMatchFailed = (message: string) => {
                logger.warn(`[codex-local]: ${message}`);
                session.sendSessionEvent({ type: 'message', message });
                launcher.control.requestExit();
            };

            scanner = await createCodexSessionScanner({
                sessionId: currentSessionId,
                cwd: session.path,
                startupTimestampMs: Date.now(),
                onSessionMatchFailed: handleSessionMatchFailed,
                onSessionFound: (sessionId) => {
                    session.onSessionFound(sessionId);
                },
                onEvent: (event) => {
                    const converted = convertCodexEvent(event);
                    if (converted?.sessionId) {
                        session.onSessionFound(converted.sessionId);
                        scanner?.onNewSession(converted.sessionId);
                    }
                    if (converted?.userMessage) {
                        session.sendUserMessage(converted.userMessage, { sentFrom: 'scanner' });
                    }
                    if (converted?.message) {
                        session.sendCodexMessage(converted.message);
                    }
                }
            });

            try {
                const result = await launcher.run();

                // If the abort was caused by a reset command, restart locally
                if (resetCommand) {
                    const isNew = resetCommand === '/new';
                    logger.debug(`[codex-local]: Handling ${resetCommand} — restarting local process`);

                    currentSessionId = null;
                    session.sessionId = null;

                    if (isNew) {
                        session.sendSessionEvent({ type: 'message', message: 'Started a new conversation' });
                    } else {
                        session.sendSessionEvent({ type: 'message', message: 'Context was reset' });
                    }
                    session.sendSessionEvent({ type: 'ready' });

                    await scanner?.cleanup();
                    scanner = null;
                    continue; // Restart the outer loop
                }

                return result;
            } finally {
                if (scanner) {
                    await scanner.cleanup();
                    scanner = null;
                }
            }
        }
    } finally {
        happyServer.stop();
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}
