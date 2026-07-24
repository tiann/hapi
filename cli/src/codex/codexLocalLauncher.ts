import { logger } from '@/ui/logger';
import { resolve } from 'node:path';
import { startHookServer } from '@/claude/utils/startHookServer';
import { codexLocal } from './codexLocal';
import type { ReasoningEffort } from './appServerTypes';
import { CodexSession } from './session';
import { createCodexSessionScanner, type CodexSessionScanner } from './utils/codexSessionScanner';
import { convertCodexEvent, type CodexMessage } from './utils/codexEventConverter';
import { buildHapiMcpBridge } from './utils/buildHapiMcpBridge';
import { parseCodexCliOverrides, stripCodexCliOverrides } from './utils/codexCliOverrides';
import { buildCodexPermissionModeCliArgs } from './utils/permissionModeConfig';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { createCodexTranscriptLocator, type CodexTranscriptLocator } from './utils/codexTranscriptLocator';
import { CodexToolHookBridge, isCodexToolHookEvent } from './utils/codexToolHookBridge';
import { countHookCoveredExecCalls } from './utils/codexExecWrapper';

type ProposedPlanMessage = Extract<CodexMessage, { type: 'proposed_plan' }>;
type ToolCallMessage = Extract<CodexMessage, { type: 'tool-call' }>;

type PendingExecWrapper = {
    message: ToolCallMessage;
    turnId?: string;
};

export async function codexLocalLauncher(session: CodexSession): Promise<'switch' | 'exit'> {
    const resumeSessionId = session.sessionId;
    let primarySessionId = resumeSessionId;
    let primaryTranscriptPath: string | null = null;
    let scanner: CodexSessionScanner | null = null;
    let hookReady = false;
    let shuttingDown = false;
    let pendingScannerSetup: Promise<void> | null = null;
    let transcriptLocator: CodexTranscriptLocator | null = null;
    let scannerTranscriptPath: string | null = null;
    const pendingPlansByTurnId = new Map<string, ProposedPlanMessage>();
    const pendingExecWrappers = new Map<string, PendingExecWrapper>();
    const toolHookBridge = new CodexToolHookBridge();
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
    const cwdOverride = parseCodexCliOverrides(session.codexArgs).cwd;
    const effectiveCodexCwd = cwdOverride ? resolve(session.path, cwdOverride) : session.path;

    // Start hapi hub for MCP bridge (same as remote mode)
    const { server: happyServer, mcpServers } = await buildHapiMcpBridge(session.client);
    logger.debug(`[codex-local]: Started hapi MCP bridge server at ${happyServer.url}`);

    const reportTranscriptSyncFailure = (transcriptPath: string, error: unknown): void => {
        const detail = error instanceof Error ? error.message : String(error);
        const message = `Codex transcript sync failed for ${transcriptPath}: ${detail}`;
        logger.warn(`[codex-local]: ${message}`);
        session.sendSessionEvent({
            type: 'message',
            message: `${message} Keeping local Codex running; remote transcript sync is unavailable for this launch.`
        });
    };

    const handleSessionFound = (sessionId: string, allowSwitch = false): void => {
        if (primarySessionId && primarySessionId !== sessionId && !allowSwitch) {
            logger.debug(`[codex-local]: Ignoring non-primary Codex session id ${sessionId}; primary is ${primarySessionId}`);
            return;
        }
        primarySessionId = sessionId;
        session.onSessionFound(sessionId);
    };

    const isPrimarySessionId = (sessionId: string): boolean => {
        return primarySessionId === null || primarySessionId === sessionId;
    };

    const sendProposedPlan = (message: ProposedPlanMessage): void => {
        const callId = `codex-proposed-plan:${message.id}`;
        session.sendAgentMessage({
            type: 'tool-call',
            name: 'ExitPlanMode',
            callId,
            input: { plan: message.plan },
            id: message.id
        });
        session.sendAgentMessage({
            type: 'tool-call-result',
            callId,
            output: null,
            id: `${message.id}:result`
        });
    };

    const flushPendingPlan = (turnId: string): void => {
        const message = pendingPlansByTurnId.get(turnId);
        if (!message) {
            return;
        }
        pendingPlansByTurnId.delete(turnId);
        sendProposedPlan(message);
    };

    const flushAllPendingPlans = (): void => {
        for (const turnId of pendingPlansByTurnId.keys()) {
            flushPendingPlan(turnId);
        }
    };

    const flushPendingExecWrapper = (callId: string, result?: CodexMessage): void => {
        const pending = pendingExecWrappers.get(callId);
        if (!pending) return;
        pendingExecWrappers.delete(callId);
        session.sendAgentMessage(pending.message);
        if (result) {
            session.sendAgentMessage(result);
        }
    };

    const flushAllPendingExecWrappers = (): void => {
        for (const [callId, pending] of pendingExecWrappers) {
            session.sendAgentMessage(pending.message);
            session.sendAgentMessage({
                type: 'tool-call-result',
                callId,
                output: { error: 'Codex ended before the exec wrapper returned a result.' },
                is_error: true,
                id: `${pending.message.id}:incomplete`
            });
        }
        pendingExecWrappers.clear();
    };

    const bindPrimarySession = (sessionId: string, transcriptPath: string, allowSwitch = false): void => {
        if (primarySessionId && primarySessionId !== sessionId && !allowSwitch) {
            logger.debug(`[codex-local]: Ignoring non-primary SessionStart hook ${sessionId}; primary is ${primarySessionId}`);
            return;
        }
        primarySessionId = sessionId;
        primaryTranscriptPath = transcriptPath;
        session.onSessionFound(sessionId);
        hookReady = true;
        session.onTranscriptPathFound(transcriptPath);
    };

    const processTranscriptPath = async (transcriptPath: string): Promise<void> => {
        hookReady = true;
        if (shuttingDown) {
            return;
        }
        if (primaryTranscriptPath && transcriptPath !== primaryTranscriptPath) {
            logger.debug(`[codex-local]: Ignoring non-primary transcript path ${transcriptPath}; primary is ${primaryTranscriptPath}`);
            return;
        }
        if (scanner) {
            if (scannerTranscriptPath !== transcriptPath) {
                flushAllPendingPlans();
            }
            await scanner.setTranscriptPath(transcriptPath);
            scannerTranscriptPath = transcriptPath;
            return;
        }
        const createdScanner = await createCodexSessionScanner({
            transcriptPath,
            // 中文注释：导入模式下允许 scanner 首次回放 transcript 全量内容，补齐 Codex 客户端里已有但 Hapi 还未看到的消息。
            replayExistingHistory: session.replayTranscriptHistoryOnStart,
            onSessionId: (sessionId) => {
                if (!isPrimarySessionId(sessionId)) {
                    logger.debug(`[codex-local]: Ignoring transcript session id ${sessionId}; primary is ${primarySessionId}`);
                    return;
                }
                session.onSessionFound(sessionId);
            },
            onEvent: (event) => {
                const converted = convertCodexEvent(event);
                if (converted?.sessionId) {
                    if (!isPrimarySessionId(converted.sessionId)) {
                        logger.debug(`[codex-local]: Ignoring converted session id ${converted.sessionId}; primary is ${primarySessionId}`);
                        return;
                    }
                    session.onSessionFound(converted.sessionId);
                }
                if (converted?.userMessage) {
                    session.sendUserMessage(converted.userMessage);
                } else if (converted?.userActivity) {
                    session.notifyUserActivity();
                }
                for (const message of converted?.messages ?? []) {
                    if (message.type === 'proposed_plan') {
                        // Codex may complete the Plan item before emitting its final text preface.
                        pendingPlansByTurnId.set(message.turnId, message);
                    } else if (message.type === 'tool-call' && message.name === 'exec') {
                        if (countHookCoveredExecCalls(message.input) === null) {
                            session.sendAgentMessage(message);
                        } else {
                            pendingExecWrappers.set(message.callId, {
                                message,
                                ...(converted?.turnId ? { turnId: converted.turnId } : {})
                            });
                        }
                    } else if (message.type === 'tool-call-result' && pendingExecWrappers.has(message.callId)) {
                        const pending = pendingExecWrappers.get(message.callId);
                        const turnId = pending?.turnId ?? converted?.turnId;
                        if (pending && toolHookBridge.hasCompletedAllObservedNestedTools(turnId)) {
                            pendingExecWrappers.delete(message.callId);
                        } else {
                            flushPendingExecWrapper(message.callId, message);
                        }
                    } else {
                        session.sendAgentMessage(message);
                    }
                }
                if (converted?.finishedTurnId) {
                    flushPendingPlan(converted.finishedTurnId);
                    for (const message of toolHookBridge.finishTurn(converted.finishedTurnId)) {
                        session.sendAgentMessage(message);
                    }
                }
            }
        });
        if (shuttingDown) {
            await createdScanner.cleanup();
            return;
        }
        scanner = createdScanner;
        scannerTranscriptPath = transcriptPath;
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

    const handleSessionHook = (sessionId: string, data: Record<string, unknown>): void => {
        if (shuttingDown) {
            return;
        }

        const transcriptPath = typeof data.transcript_path === 'string' && data.transcript_path.length > 0
            ? data.transcript_path
            : null;
        const hookSource = typeof data.source === 'string' ? data.source : null;
        const shouldAllowSessionSwitch = hookSource === 'clear';

        if (transcriptPath) {
            const activeLocator = transcriptLocator;
            transcriptLocator = null;
            void activeLocator?.cleanup();
        }

        if (!transcriptPath) {
            handleSessionFound(sessionId, shouldAllowSessionSwitch);
            return;
        }

        bindPrimarySession(sessionId, transcriptPath, shouldAllowSessionSwitch);
    };

    const hookServer = await startHookServer({
        onSessionHook: (sessionId, data) => {
            if (shuttingDown) {
                return;
            }
            if (isCodexToolHookEvent(data)) {
                if (primarySessionId && primarySessionId !== sessionId) {
                    return;
                }
                for (const message of toolHookBridge.handle(data)) {
                    session.sendAgentMessage(message);
                }
                return;
            }
            handleSessionHook(sessionId, data);
        }
    });
    logger.debug(`[codex-local]: Started Codex SessionStart hook server on port ${hookServer.port}`);

    if (session.client.isPending()) {
        const createdLocator = createCodexTranscriptLocator({
            cwd: effectiveCodexCwd,
            startupTimestampMs: Date.now(),
            resumeSessionId,
            onLocated: ({ sessionId, transcriptPath }) => {
                if (shuttingDown || hookReady || primaryTranscriptPath) {
                    return;
                }
                transcriptLocator = null;
                bindPrimarySession(sessionId, transcriptPath);
            },
            onAmbiguous: (paths) => {
                transcriptLocator = null;
                logger.warn(`[codex-local]: Transcript fallback was ambiguous (${paths.length} active candidates)`);
            }
        });
        transcriptLocator = createdLocator;
        await createdLocator.ready;
    }

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
        const activeLocator = transcriptLocator;
        transcriptLocator = null;
        void activeLocator?.cleanup();
        if (pendingScannerSetup) {
            await pendingScannerSetup;
        }
        const activeScanner = scanner as CodexSessionScanner | null;
        if (activeScanner) {
            await activeScanner.cleanup();
        }
        flushAllPendingExecWrappers();
        for (const message of toolHookBridge.finish()) {
            session.sendAgentMessage(message);
        }
        flushAllPendingPlans();
        happyServer.stop();
        if (!hookReady) {
            logger.debug('[codex-local]: SessionStart hook did not provide transcript path before shutdown');
        }
        logger.debug('[codex-local]: Stopped hapi MCP bridge server');
    }
}
