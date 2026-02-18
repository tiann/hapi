import { logger } from '@/ui/logger';
import { codexLocal } from './codexLocal';
import { CodexSession } from './session';
import { createCodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    const handleSessionFound = (sessionId: string) => {
        session.onSessionFound(sessionId);
        scanner?.onNewSession(sessionId);
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
        sessionId: resumeSessionId,
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
        return await launcher.run();
    } finally {
        await scanner?.cleanup();
        happyServer.stop();
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}
