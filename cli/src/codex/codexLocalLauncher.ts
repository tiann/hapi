import { logger } from '@/ui/logger';
import { codexLocal } from './codexLocal';
import type { ReasoningEffort, ServiceTier } from './appServerTypes';
import { CodexSession } from './session';
import { createCodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { stripCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexPermissionModeCliArgs } from './utils/permissionModeConfig';
import { createCodexThreadTitlePoller, syncCodexThreadTitleToMetadata } from './utils/codexThreadTitle';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    let scanner: Awaited<ReturnType<typeof createCodexSessionScanner>> | null = null;
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
    let currentCodexThreadId: string | null = resumeSessionId;

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    const handleSessionFound = (sessionId: string) => {
        currentCodexThreadId = sessionId;
        session.onSessionFound(sessionId);
        void syncCodexThreadTitleToMetadata(session.client, sessionId);
        scanner?.onNewSession(sessionId);
    };

    const titlePoller = createCodexThreadTitlePoller({
        client: session.client,
        getThreadId: () => currentCodexThreadId
    });

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
                serviceTier: (session.getServiceTier() ?? undefined) as ServiceTier | undefined,
                onSessionFound: handleSessionFound,
                abort: abortSignal,
                codexArgs,
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
        session.sendSessionEvent({
            type: 'message',
            message: `${message} Keeping local Codex running; remote transcript sync may be unavailable for this launch.`
        });
    };

    scanner = await createCodexSessionScanner({
        sessionId: resumeSessionId,
        cwd: session.path,
        startupTimestampMs: Date.now(),
        onSessionMatchFailed: handleSessionMatchFailed,
        onSessionFound: (sessionId) => {
            handleSessionFound(sessionId);
        },
        onEvent: (event) => {
            const converted = convertCodexEvent(event);
            if (converted?.sessionId) {
                handleSessionFound(converted.sessionId);
            }
            if (converted?.userMessage) {
                session.sendUserMessage(converted.userMessage);
            }
            if (converted?.message) {
                session.sendAgentMessage(converted.message);
            }
        }
    });

    try {
        return await launcher.run();
    } finally {
        titlePoller.stop();
        await scanner?.cleanup();
        happyServer.stop();
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}
