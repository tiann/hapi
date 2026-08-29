import { claudeLocal } from "./claudeLocal";
import { Session } from "./session";
import { createSessionScanner } from "./utils/sessionScanner";
import { isClaudeChatVisibleMessage } from "./utils/chatVisibility";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import type { LocalLauncherControl } from "@/modules/common/launcher/BaseLocalLauncher";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import { isTerminalLost, waitForTerminalLoss } from '@/agent/terminalLossState';
import { logger } from '@/ui/logger';

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: (message) => {
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
            session.client.sendClaudeSessionMessage(message)
        }
    });

    const handleSessionFound = (sessionId: string) => {
        scanner.onNewSession(sessionId);
    };
    session.addSessionFoundCallback(handleSessionFound);


    // Assigned right after `new BaseLocalLauncher(...)` below,
    // before `launcher.run()` is ever invoked — `launch` only runs inside
    // `run()`, so by the time this closure executes, `control` is set.
    let control: LocalLauncherControl | null = null;

    const requestSwitch = () => {
        if (!control) {
            throw new Error('[claudeLocalLauncher] requestSwitch called before control was assigned');
        }
        control.requestSwitch();
    };

    const launcher = new BaseLocalLauncher({
        label: 'local',
        failureLabel: 'Local Claude process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
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
            } catch (error) {
                // The controlling terminal is gone (SIGHUP already fired):
                // there is no user left who could have typed /exit, so any
                // abnormal local-child death (signal kill / non-zero exit)
                // means "terminal died out from under the child", not
                // "session over". Redirect into the existing local→remote
                // switch path instead of surfacing a failure and ending the
                // session. Known edge: claude mid-generation loses the
                // current unsaved turn; the session resumes from the last
                // save point via --resume, same as any other local→remote
                // handoff.
                //
                // isTerminalLost() alone is a synchronous read of a flag set
                // by the parent's SIGHUP handler — but SIGHUP hits the whole
                // foreground process group at once, so there is no
                // guaranteed ordering between that handler running and this
                // child-exit callback running. If the child's exit callback
                // wins the race, isTerminalLost() reads false even though
                // the terminal is in fact already gone. Falling back to
                // waitForTerminalLoss briefly closes that race by giving the
                // SIGHUP handler a short window to run and mark the flag
                // before we commit to a classification. Accepted tradeoff:
                // every abnormal local-child death now carries up to 100ms
                // of added latency before it is classified.
                if (isTerminalLost() || await waitForTerminalLoss(100)) {
                    logger.debug('[claudeLocalLauncher] Local claude died after terminal loss — switching to remote', error);
                    requestSwitch();
                    return;
                }
                throw error;
            }
            // A real claude child does NOT always die by signal when its
            // PTY disappears — it can observe the closed terminal and exit
            // gracefully with code=0/signal=null, which is exactly the
            // shape spawnWithAbort resolves (not throws) for. So a clean
            // claudeLocal() resolve is NOT sufficient evidence of "user
            // typed /exit": once terminalLost was already set at the moment
            // the child exited, the terminal is gone and no user could have
            // typed anything — redirect to the same local→remote switch
            // path as the abnormal case above, rather than ending the
            // session. (A same-tick race where the user's own /exit lands
            // right as the terminal dies is resolved in favor of the safer
            // side: keep the session alive rather than silently end it.)
            //
            // Same ordering caveat as the catch branch above applies here:
            // a clean exit callback can win the race against the parent's
            // SIGHUP handler, so isTerminalLost() alone is not conclusive.
            // waitForTerminalLoss gives the handler a short window to catch
            // up before this exit is classified as a genuine user /exit.
            // Accepted tradeoff: every clean local-child exit now carries up
            // to 100ms of added latency before it is classified.
            if (isTerminalLost() || await waitForTerminalLoss(100)) {
                logger.debug('[claudeLocalLauncher] Local claude exited cleanly after terminal loss — switching to remote');
                requestSwitch();
                return;
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
    control = launcher.control;
    try {
        return await launcher.run();
    } finally {
        // Cleanup
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
