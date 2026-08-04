import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { logger } from '@/ui/logger';
import { copilotLocal } from './copilotLocal';
import type { CopilotSession } from './session';
import type { PermissionMode } from './types';
import { createCopilotSessionLocator } from './utils/copilotSessionLocator';

/** Only full `yolo` maps to `--allow-all`. `safe-yolo` stays interactive/local defaults. */
export function mapCopilotLocalApprovalMode(mode: PermissionMode | undefined): { yolo: boolean } {
    if (mode === 'yolo') {
        return { yolo: true };
    }
    return { yolo: false };
}

export async function copilotLocalLauncher(
    session: CopilotSession,
    opts: {
        model?: string;
    }
): Promise<'switch' | 'exit'> {
    const startupTimestampMs = Date.now();
    let shuttingDown = false;

    const locator = createCopilotSessionLocator({
        cwd: session.path,
        startupTimestampMs,
        resumeSessionId: session.sessionId,
        onLocated: ({ sessionId }) => {
            if (shuttingDown) {
                return;
            }
            session.onSessionFound(sessionId);
        },
        onAmbiguous: (sessionIds) => {
            logger.warn(
                `[copilot-local]: Multiple fresh Copilot sessions found (${sessionIds.join(', ')}); session id sync disabled for this launch`
            );
        }
    });

    const launcher = new BaseLocalLauncher({
        label: 'copilot-local',
        failureLabel: 'Local Copilot process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await locator.ready;
            const approval = mapCopilotLocalApprovalMode(session.getPermissionMode() as PermissionMode | undefined);
            await copilotLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                model: opts.model,
                yolo: approval.yolo,
                agentMode: session.getAgentMode()
            });
        },
        sendFailureMessage: (message) => {
            session.sendSessionEvent({ type: 'message', message });
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        }
    });

    try {
        return await launcher.run();
    } finally {
        shuttingDown = true;
        await locator.cleanup();
    }
}
