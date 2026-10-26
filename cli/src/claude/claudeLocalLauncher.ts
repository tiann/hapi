import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { createSessionScanner } from "./utils/sessionScanner";
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import { resolveClaudeLaunchModel } from './utils/claudeSettings';
import type { RawJSONLines } from './types';

// Local transcripts carry bare model ids and no context_window, so the web
// guesses 200k. When the TUI runs a "[1m]" model, stamp 1M on messages from
// that model only (subagents differ). Aliases ("opus[1m]") match "claude-opus-*".
function stampContextWindow(message: RawJSONLines, contextModel: string | null): void {
    if (message.type !== 'assistant' || !message.message?.usage || !contextModel || !/\[1m\]$/i.test(contextModel)) return;
    const base = contextModel.slice(0, -'[1m]'.length);
    const model = message.message.model;
    if (model === base || (!base.includes('-') && model?.startsWith(`claude-${base}-`))) {
        message.message.usage.context_window ??= 1_000_000;
    }
}

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
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
            stampContextWindow(message, session.localContextModel)
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
            session.localContextModel = resolveClaudeLaunchModel({
                model: session.getModel(),
                cwd: session.path,
                env: session.claudeEnvVars,
                args: session.claudeArgs
            });
            try {
                await claudeLocal({
                    path: session.path,
                    sessionId: session.sessionId,
                    abort: abortSignal,
                    claudeEnvVars: session.claudeEnvVars,
                    claudeArgs: session.claudeArgs,
                    model: session.getModel(),
                    permissionMode: session.getPermissionMode(),
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
