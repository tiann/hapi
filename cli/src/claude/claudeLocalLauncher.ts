import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { createSessionScanner } from "./utils/sessionScanner";
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import { buildClaudeContextDetails, publishContextDetails } from '@/agent/contextDetails';

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {
    let lastSystemModel = session.getModel();

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
            const rawMessage = message as unknown as Record<string, unknown>;
            const isSidechain = rawMessage.isSidechain === true;
            if (!isSidechain) {
                if (rawMessage.type === 'system' && typeof rawMessage.model === 'string') {
                    lastSystemModel = rawMessage.model;
                }
                if (rawMessage.type === 'assistant' || rawMessage.type === 'system' || rawMessage.type === 'result') {
                    const details = buildClaudeContextDetails({
                        contextUsage: rawMessage.context_usage,
                        system: rawMessage.type === 'system' ? rawMessage : undefined,
                        result: rawMessage.type === 'result' ? rawMessage : undefined,
                        messageUsage: (rawMessage.message as Record<string, unknown> | undefined)?.usage ?? rawMessage.usage,
                        model: typeof rawMessage.model === 'string' ? rawMessage.model : lastSystemModel
                    });
                    if (details) {
                        publishContextDetails(session.client, details);
                    }
                }
            }

            session.localPermissionBridge.onTranscript(message);
            // Preserve the AI-generated title emitted by Claude Code's native
            // interactive CLI. It is metadata, not a visible chat message.
            if (message.type === 'ai-title') {
                applySessionTitleFallback(session.client, message.aiTitle)
                return
            }
            // Claude Code writes its native session title as a summary. Use it as
            // a fallback for older transcript formats.
            if (message.type === 'summary') {
                applySessionTitleFallback(session.client, message.summary)
                return
            }
            // Filter out internal meta messages (e.g. skill injections) and
            // compact summaries to avoid them appearing in the web UI
            if (message.isMeta || message.isCompactSummary) {
                return
            }
            // Filter out invisible system messages (e.g. init, stop_hook_summary)
            // to avoid them showing as raw JSON in the web UI
            if (!isClaudeChatVisibleMessage(message)) {
                return
            }
            if (message.type === 'assistant') {
                const { context_usage: _contextUsage, ...outboundMessage } = message
                session.client.sendClaudeSessionMessage(outboundMessage)
                return
            }
            session.client.sendClaudeSessionMessage(message)
        }
    });

    const handleSessionFound = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);


    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local Claude process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            session.localPermissionBridge.start(session.sessionId);
            abortSignal.addEventListener('abort', session.localPermissionBridge.stop, { once: true });
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    abort: abortSignal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    model: session.getModel(),
                    mcpServers: session.mcpServers,
                    allowedTools: session.allowedTools,
                    hookSettingsPath: session.localHookSettingsPath,
                });
            } finally {
                abortSignal.removeEventListener('abort', session.localPermissionBridge.stop);
                session.localPermissionBridge.stop();
            }
        },
        onLaunchSuccess: () => {
            session.consumeOneTimeFlags();
        },
        sendFailureMessage: (message) => {
            session.client.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });
    try {
        return await launcher.run();
    } finally {
        // Cleanup
        session.localPermissionBridge.stop();
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
