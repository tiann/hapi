import { logger } from '@/ui/logger';
import { geminiLocal } from './geminiLocal';
import { GeminiSession } from './session';
import { Future } from '@/utils/future';
import { createGeminiSessionScanner } from './utils/sessionScanner';
import { getLocalLaunchExitReason } from '@/agent/localLaunchPolicy';
import type { PermissionMode } from './types';
import { randomUUID } from 'node:crypto';

type GeminiScannerHandle = Awaited<ReturnType<typeof createGeminiSessionScanner>>;

function mapApprovalMode(mode: PermissionMode | undefined): string | undefined {
    if (!mode || mode === 'default' || mode === 'read-only') {
        return 'default';
    }
    if (mode === 'safe-yolo') {
        return 'auto_edit';
    }
    return 'yolo';
}

export async function geminiLocalLauncher(
    session: GeminiSession,
    opts: {
        model?: string;
        allowedTools?: string[];
        hookSettingsPath?: string;
    }
): Promise<'switch' | 'exit'> {
    let exitReason: 'switch' | 'exit' | null = null;
    const processAbortController = new AbortController();
    const exitFuture = new Future<void>();

    let scanner: GeminiScannerHandle | null = null;

    const handleTranscriptMessage = (message: { type?: string; content?: string }) => {
        if (message.type === 'user' && typeof message.content === 'string') {
            session.sendUserMessage(message.content);
            return;
        }
        if (message.type === 'gemini' && typeof message.content === 'string') {
            session.sendCodexMessage({
                type: 'message',
                message: message.content,
                id: randomUUID()
            });
        }
    };

    const ensureScanner = async (transcriptPath: string): Promise<void> => {
        if (scanner) {
            scanner.onNewSession(transcriptPath);
            return;
        }
        scanner = await createGeminiSessionScanner({
            transcriptPath,
            onMessage: handleTranscriptMessage,
            onSessionId: (sessionId) => session.onSessionFound(sessionId)
        });
    };

    const handleTranscriptPath = (transcriptPath: string) => {
        void ensureScanner(transcriptPath);
    };

    const hadTranscriptPath = Boolean(session.transcriptPath);
    if (hadTranscriptPath && session.transcriptPath) {
        await ensureScanner(session.transcriptPath);
    } else {
        session.addTranscriptPathCallback(handleTranscriptPath);
    }

    try {
        const abortProcess = async () => {
            if (!processAbortController.signal.aborted) {
                processAbortController.abort();
            }
            await exitFuture.promise;
        };

        const doAbort = async () => {
            logger.debug('[gemini-local]: abort requested');
            if (!exitReason) {
                exitReason = 'switch';
            }
            session.queue.reset();
            await abortProcess();
        };

        const doSwitch = async () => {
            logger.debug('[gemini-local]: switch requested');
            if (!exitReason) {
                exitReason = 'switch';
            }
            await abortProcess();
        };

        session.client.rpcHandlerManager.registerHandler('abort', doAbort);
        session.client.rpcHandlerManager.registerHandler('switch', doSwitch);
        session.queue.setOnMessage(() => {
            void doSwitch();
        });

        if (session.queue.size() > 0) {
            return 'switch';
        }

        while (true) {
            if (exitReason) {
                return exitReason;
            }

            logger.debug('[gemini-local]: launch');
            try {
                await geminiLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    resumeSessionId: session.resumeSessionId,
                    abort: processAbortController.signal,
                    model: opts.model,
                    approvalMode: mapApprovalMode(session.getPermissionMode() as PermissionMode | undefined),
                    allowedTools: opts.allowedTools,
                    hookSettingsPath: opts.hookSettingsPath
                });

                if (!exitReason) {
                    exitReason = 'exit';
                    break;
                }
            } catch (error) {
                logger.debug('[gemini-local]: launch error', error);
                const message = error instanceof Error ? error.message : String(error);
                session.sendSessionEvent({
                    type: 'message',
                    message: `Local Gemini process failed: ${message}`
                });
                const failureExitReason = exitReason ?? getLocalLaunchExitReason({
                    startedBy: session.startedBy,
                    startingMode: session.startingMode
                });
                session.recordLocalLaunchFailure(message, failureExitReason);
                if (!exitReason) {
                    exitReason = failureExitReason;
                }
                if (failureExitReason === 'exit') {
                    logger.warn(`[gemini-local]: Local Gemini process failed: ${message}`);
                }
                break;
            }
        }
    } finally {
        exitFuture.resolve(undefined);
        session.client.rpcHandlerManager.registerHandler('abort', async () => {});
        session.client.rpcHandlerManager.registerHandler('switch', async () => {});
        session.queue.setOnMessage(null);

        if (!hadTranscriptPath) {
            session.removeTranscriptPathCallback(handleTranscriptPath);
        }

        if (scanner !== null) {
            await (scanner as GeminiScannerHandle).cleanup();
        }
    }

    return exitReason || 'exit';
}
