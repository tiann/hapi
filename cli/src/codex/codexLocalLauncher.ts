import { logger } from '@/ui/logger';
import { codexLocal } from './codexLocal';
import { CodexSession } from './session';
import { Future } from '@/utils/future';
import { createCodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent } from './utils/codexEventConverter';

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const scanner = await createCodexSessionScanner({
        sessionId: session.sessionId,
        onSessionFound: (sessionId) => {
            session.onSessionFound(sessionId);
        },
        onEvent: (event) => {
            const converted = convertCodexEvent(event);
            if (converted?.sessionId) {
                session.onSessionFound(converted.sessionId);
                scanner.onNewSession(converted.sessionId);
            }
            if (converted?.message) {
                session.sendCodexMessage(converted.message);
            }
        }
    });

    let exitReason: 'switch' | 'exit' | null = null;
    const processAbortController = new AbortController();
    const exitFuture = new Future<void>();

    try {
        async function abortProcess() {
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
            await exitFuture.promise;
        }

        async function doAbort() {
            logger.debug('[codex-local]: doAbort');
            if (!exitReason) {
                exitReason = 'switch';
            }
            session.queue.reset();
            await abortProcess();
        }

        async function doSwitch() {
            logger.debug('[codex-local]: doSwitch');
            if (!exitReason) {
                exitReason = 'switch';
            }
            await abortProcess();
        }

        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch);
        session.queue.setOnMessage(() => {
            void doSwitch();
        });

        if (session.queue.size() > 0) {
            return 'switch';
        }

        const handleSessionFound = (sessionId: string) => {
            session.onSessionFound(sessionId);
            scanner.onNewSession(sessionId);
        };

        while (true) {
            if (exitReason) {
                return exitReason;
            }

            logger.debug('[codex-local]: launch');
            try {
                await codexLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    onSessionFound: handleSessionFound,
                    abort: processAbortController.signal,
                    codexArgs: session.codexArgs
                });

                if (!exitReason) {
                    exitReason = 'exit';
                    break;
                }
            } catch (error) {
                logger.debug('[codex-local]: launch error', error);
                const message = error instanceof Error ? error.message : String(error);
                session.sendSessionEvent({ type: 'message', message: `Local Codex process failed: ${message}` });
                if (!exitReason) {
                    exitReason = 'switch';
                }
                break;
            }
        }
    } finally {
        exitFuture.resolve(undefined);
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        session.queue.setOnMessage(null);
        await scanner.cleanup();
    }

    return exitReason || 'exit';
}
