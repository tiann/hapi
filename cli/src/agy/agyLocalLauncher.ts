import { agyLocal } from './agyLocal';
import { AgySession } from './session';
import type { PermissionMode } from './types';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { buildAgyAdditionalDirectories, resolveAgyLogFile } from './utils/paths';
import { extractAgyConversationIdFromLog, getAgyLogFileSize, readAgyLogFileFromOffset } from './utils/agyBackend';

export async function agyLocalLauncher(
    session: AgySession,
    opts: { additionalDirectories?: string[]; logFile?: string; model?: string }
): Promise<'switch' | 'exit'> {
    const logFile = resolveAgyLogFile(session.logPath, opts.logFile);
    const persistNativeConversationId = (logStartOffset: number) => {
        const nativeConversationId = extractAgyConversationIdFromLog(
            readAgyLogFileFromOffset(logFile, logStartOffset)
        );
        if (nativeConversationId) {
            session.onSessionFound(nativeConversationId);
        }
    };

    const launcher = new BaseLocalLauncher({
        label: 'agy-local',
        failureLabel: 'Local Antigravity agy process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            const logStartOffset = getAgyLogFileSize(logFile);
            try {
                await agyLocal({
                    additionalDirectories: buildAgyAdditionalDirectories({
                        cwd: session.path,
                        additionalDirectories: opts.additionalDirectories
                    }),
                    logFile,
                    path: session.path,
                    sessionId: session.sessionId,
                    abort: abortSignal,
                    model: opts.model,
                    permissionMode: session.getPermissionMode() as PermissionMode | undefined
                });
            } finally {
                persistNativeConversationId(logStartOffset);
            }
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    return await launcher.run();
}
