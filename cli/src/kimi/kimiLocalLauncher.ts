import { kimiLocal } from './kimiLocal';
import { KimiSession } from './session';
import type { PermissionMode } from './types';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';

function mapApprovalMode(mode: PermissionMode | undefined): { yolo: boolean; plan: boolean } {
    if (!mode || mode === 'default' || mode === 'read-only') {
        return { yolo: false, plan: false };
    }
    if (mode === 'yolo' || mode === 'safe-yolo') {
        return { yolo: true, plan: false };
    }
    return { yolo: false, plan: false };
}

export async function kimiLocalLauncher(
    session: KimiSession,
    opts: {
        model?: string;
    }
): Promise<'switch' | 'exit'> {
    const launcher = new BaseLocalLauncher({
        label: 'kimi-local',
        failureLabel: 'Local Kimi process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            const approval = mapApprovalMode(session.getPermissionMode() as PermissionMode | undefined);
            await kimiLocal({
                path: session.path,
                sessionId: session.sessionId,
                abort: abortSignal,
                model: opts.model,
                yolo: approval.yolo,
                plan: approval.plan
            });
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
