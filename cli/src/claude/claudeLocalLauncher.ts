import { claudeLocal } from "./claudeLocal";
import { deriveSpawnArgs, isSessionMaterialized } from './conversationHistory';
import { Session } from "./session";
import { createSessionScanner } from "./utils/sessionScanner";
import { isImportableClaudeEntry } from "./utils/transcriptEntry";
import { BaseLocalLauncher } from "@/modules/common/launcher/BaseLocalLauncher";
import { applySessionTitleFallback } from './utils/sessionTitleFallback';
import { resolveClaudeLaunchModel } from './utils/claudeSettings';
import type { RawJSONLines } from './types';
import { ClaudeToolResultImages } from './utils/toolResultImages';

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
import { buildClaudeContextDetails, publishContextDetails, sameClaudeModelID } from '@/agent/contextDetails';

function isInterruptMarker(message: RawJSONLines): boolean {
    if (message.type !== 'user' || message.isSidechain) return false;
    const content = message.message.content;
    const blocks = typeof content === 'string' ? [{ type: 'text', text: content }] : content;
    return Array.isArray(blocks) && blocks.some((block) =>
        block.type === 'text' && typeof block.text === 'string' && block.text.startsWith('[Request interrupted by user'));
}

export async function claudeLocalLauncher(session: Session): Promise<'switch' | 'exit'> {
    let lastSystemModel = session.getModel();
    let publishedLocalPreset: string | null | undefined;
    const toolResultImages = new ClaudeToolResultImages();

    // Create scanner
    const scanner = await createSessionScanner({
        sessionId: session.sessionId,
        workingDirectory: session.path,
        onMessage: ({ context_usage: contextUsage, ...message }) => {
            const rawMessage = message as unknown as Record<string, unknown>;
            stampContextWindow(message, session.localContextModel)
            const isSidechain = rawMessage.isSidechain === true;
            if (!isSidechain) {
                if (rawMessage.type === 'system' && typeof rawMessage.model === 'string') {
                    lastSystemModel = rawMessage.model;
                }
                const isSyntheticApiError = rawMessage.type === 'assistant' && rawMessage.isApiErrorMessage === true;
                if (!isSyntheticApiError && (rawMessage.type === 'assistant' || rawMessage.type === 'system' || rawMessage.type === 'result')) {
                    const nestedMessage = rawMessage.message as Record<string, unknown> | undefined;
                    const nestedModel = typeof nestedMessage?.model === 'string' ? nestedMessage.model : undefined;
                    const details = buildClaudeContextDetails({
                        contextUsage,
                        system: rawMessage.type === 'system' ? rawMessage : undefined,
                        result: rawMessage.type === 'result' ? rawMessage : undefined,
                        messageUsage: nestedMessage?.usage ?? rawMessage.usage,
                        model: nestedModel ?? (typeof rawMessage.model === 'string' ? rawMessage.model : lastSystemModel)
                    });
                    if (details) {
                        if (details.model) {
                            lastSystemModel = details.model;
                        }
                        const preset = session.localContextModel;
                        const presetChanged = publishedLocalPreset !== undefined && publishedLocalPreset !== preset;
                        const saved = publishedLocalPreset === undefined ? session.client.getMetadata()?.contextDetails : undefined;
                        // A resumed local transcript may keep the same bare model ID
                        // even when the selected preset no longer requests 1M.
                        const resumedWithPlainPreset = Boolean(preset && !/\[1m\]$/i.test(preset)
                            && saved?.provider === 'claude' && saved.contextWindow === 1_000_000
                            && saved.model && details.model && sameClaudeModelID(saved.model, details.model));
                        publishedLocalPreset = preset;
                        publishContextDetails(session.client, details, { clearContextSample: presetChanged || resumedWithPlainPreset });
                    }
                }
            }

            session.localPermissionBridge.onTranscript(message);
            // Esc-interrupted turns fire no Stop hook; Claude Code only
            // writes this marker to the transcript. The scanner can deliver it
            // after the next prompt's hook, so skip markers older than that turn.
            if (session.thinking && isInterruptMarker(message)
                && !(Date.parse(message.timestamp ?? '') < session.localTurnStartedAt)) {
                session.onThinkingChange(false);
            }
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
            // Filter out internal meta messages (e.g. skill injections), compact
            // summaries, and invisible system messages (e.g. init,
            // stop_hook_summary) to avoid them appearing in the web UI
            if (!isImportableClaudeEntry(message)) {
                return
            }
            const processed = toolResultImages.process(message)
            session.client.sendClaudeSessionMessage(processed.message)
            for (const image of processed.images) session.client.sendAgentMessage(image)
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
            if (session.beforeLocalLaunch && !await session.beforeLocalLaunch()) {
                throw new Error('Could not verify pending rewind state with hub; please retry');
            }
            if (abortSignal.aborted) {
                return;
            }
            session.localPermissionBridge.start(session.sessionId);
            abortSignal.addEventListener('abort', session.localPermissionBridge.stop, { once: true });
            // Spawn-time boundary derivation (see deriveSpawnArgs): the
            // rewind boundary comes from the durable intent, never from a
            // mutated claudeArgs buffer.
            const { args: spawnArgs } = deriveSpawnArgs({
                claudeArgs: session.claudeArgs,
                sessionId: session.sessionId,
                intent: session.client.getMetadata()?.claudeRewind,
                workingDirectory: session.path,
                startupBoundary: session.startupResumeSessionAt
            });
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
                    claudeArgs: spawnArgs,
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
            // Consume only once the launched session actually materialized on
            // disk. Launch success fires before the SessionStart hook binds
            // the id; consuming then would wipe --resume/--fork-session while
            // the child transcript does not exist, and a switch or crash in
            // that window could not resume or re-fork the source. The
            // spawn-time derivation also strips --fork-session once
            // materialized, so a later respawn cannot re-fork either way.
            if (isSessionMaterialized(session.sessionId, session.path)) {
                session.consumeOneTimeFlags();
            }
            session.consumeStartupResumeSessionAt?.();
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
        session.onThinkingChange(false);
        session.localPermissionBridge.stop();
        session.removeSessionFoundCallback(handleSessionFound);
        await scanner.cleanup();
    }
}
