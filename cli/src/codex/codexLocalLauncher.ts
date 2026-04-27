import { logger } from '@/ui/logger';
import { startHookServer } from '@/claude/utils/startHookServer';
import { codexLocal } from './codexLocal';
import type { ReasoningEffort } from './appServerTypes';
import { CodexSession } from './session';
import { createCodexSessionScanner, type CodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { stripCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexPermissionModeCliArgs } from './utils/permissionModeConfig';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    let scanner: CodexSessionScanner | null = null;
    let hookReady = false;
    let shuttingDown = false;
    let pendingScannerSetup: Promise<void> | null = null;
    const permissionMode = session.getPermissionMode();
    const managedPermissionMode = permissionMode === 'read-only' || permissionMode === 'safe-yolo' || permissionMode === 'yolo'
        ? permissionMode
        : null;
    const codexArgs = managedPermissionMode
        ? [
            ...buildCodexPermissionModeCliArgs(managedPermissionMode),
            ...stripCodexCliOverrides(session.codexArgs)
        ]
        : session.codexArgs;

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            if (shuttingDown) {
                return;
            }
            session.onSessionFound(sessionId);
            if (typeof data.transcript_path === 'string' && data.transcript_path.length > 0) {
                hookReady = true;
                session.onTranscriptPathFound(data.transcript_path);
            }
        }
    });
    logger.debug(`[codex-local]: Started Codex SessionStart hook server on port ${hookServer.port}`);

    const reportTranscriptSyncFailure = (transcriptPath: string, error: unknown): void => {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `Codex transcript sync failed for ${transcriptPath}: ${detail}`;
        logger.warn(`[codex-local]: ${message}`);
        session.sendSessionEvent({
            type: 'message',
            message: `${message} Keeping local Codex running; remote transcript sync is unavailable for this launch.`
        });
    };

    const handleSessionFound = (sessionId: string) => {
        session.onSessionFound(sessionId);
    };

    const processTranscriptPath = async (transcriptPath: string): Promise<void> => {
        hookReady = true;
        if (shuttingDown) {
            return;
        }
        if (scanner) {
            await scanner.setTranscriptPath(transcriptPath);
            return;
        }
        const createdScanner = await createCodexSessionScanner({
            transcriptPath,
            onSessionId: (sessionId) => {
                session.onSessionFound(sessionId);
            },
            onEvent: (event) => {
                const converted = convertCodexEvent(event);
                if (converted?.sessionId) {
                    session.onSessionFound(converted.sessionId);
                }
                if (converted?.userMessage) {
                    session.sendUserMessage(converted.userMessage);
                }
                if (converted?.message) {
                    session.sendAgentMessage(converted.message);
                }
            }
        });
        if (shuttingDown) {
            await createdScanner.cleanup();
            return;
        }
        scanner = createdScanner;
    };

    const handleTranscriptPath = (transcriptPath: string): Promise<void> => {
        const setupTask = (pendingScannerSetup ?? Promise.resolve()).then(() => processTranscriptPath(transcriptPath));
        const observedTask = setupTask.catch((error) => {
            if (!shuttingDown) {
                reportTranscriptSyncFailure(transcriptPath, error);
            }
        });
        pendingScannerSetup = observedTask.finally(() => {
            if (pendingScannerSetup === observedTask) {
                pendingScannerSetup = null;
            }
        });
        return pendingScannerSetup;
    };

    const launcher = new BaseLocalLauncher({
        label: 'codex-local',
        failureLabel: 'Local Codex process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await codexLocal({
                path: session.path,
                sessionId: resumeSessionId,
                modelReasoningEffort: (session.getModelReasoningEffort() ?? undefined) as ReasoningEffort | undefined,
                onSessionFound: handleSessionFound,
                abort: abortSignal,
                codexArgs,
                mcpServers,
                sessionHook: {
                    port: hookServer.port,
                    token: hookServer.token
                }
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

    session.resetTranscriptPath();
    const handleTranscriptPathCallback = (transcriptPath: string) => {
        void handleTranscriptPath(transcriptPath);
    };
    session.addTranscriptPathCallback(handleTranscriptPathCallback);

    try {
        return await launcher.run();
    } finally {
        shuttingDown = true;
        session.removeTranscriptPathCallback(handleTranscriptPathCallback);
        hookServer.stop();
        if (pendingScannerSetup) {
            await pendingScannerSetup;
        }
        const activeScanner = scanner as CodexSessionScanner | null;
        if (activeScanner) {
            await activeScanner.cleanup();
        }
        happyServer.stop();
        if (!hookReady) {
            logger.debug('[codex-local]: SessionStart hook did not provide transcript path before shutdown');
        }
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}
