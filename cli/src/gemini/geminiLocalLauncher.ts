import { geminiLocal } from './geminiLocal';
import { GeminiSession } from './session';
import { createGeminiSessionScanner } from './utils/sessionScanner';
import type { PermissionMode } from './types';
import { randomUUID } from 'node:crypto';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

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
    const launcher = new BaseLocalLauncher({
        label: 'gemini-local',
        failureLabel: 'Local Gemini process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await geminiLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                model: opts.model,
                approvalMode: mapApprovalMode(session.getPermissionMode() as PermissionMode | undefined),
                allowedTools: opts.allowedTools,
                hookSettingsPath: opts.hookSettingsPath
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    let scanner: GeminiScannerHandle | null = null;

    const handleTranscriptMessage = (message: { type?: string; content?: string }) => {
        if (message.type === 'user' && typeof message.content === 'string') {
            session.sendUserMessage(message.content, { sentFrom: 'scanner' });
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
        return await launcher.run();
    } finally {
        if (!hadTranscriptPath) {
            session.removeTranscriptPathCallback(handleTranscriptPath);
        }

        if (scanner !== null) {
            await (scanner as GeminiScannerHandle).cleanup();
        }
    }
}
