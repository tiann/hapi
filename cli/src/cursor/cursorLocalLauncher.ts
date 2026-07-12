import { logger } from '@/ui/logger';
import { cursorLocal } from './cursorLocal';
import { CursorSession } from './session';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { convertAgentMessage } from '@/agent/messageConverter';

function permissionModeToCursorArgs(mode?: string): {
    mode?: 'plan' | 'ask' | 'debug';
    yolo?: boolean;
    autoReview?: boolean;
} {
    if (mode === 'plan') {
        return { mode: 'plan' };
    }
    if (mode === 'ask') {
        return { mode: 'ask' };
    }
    if (mode === 'debug') {
        return { mode: 'debug' };
    }
    if (mode === 'yolo') {
        return { yolo: true };
    }
    if (mode === 'autoReview') {
        return { autoReview: true };
    }
    return {};
}

export async function cursorLocalLauncher(session: CursorSession): Promise<'switch' | 'exit'> {
    const resumeChatId = session.sessionId;
    if (resumeChatId) {
        session.onSessionFound(resumeChatId);
    }
    const { mode, yolo, autoReview } = permissionModeToCursorArgs(session.getPermissionMode() as string);

    const launcher = new BaseLocalLauncher({
        label: 'cursor-local',
        failureLabel: 'Local Cursor Agent process failed',
        queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager,
        startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (abortSignal) => {
            await cursorLocal({
                path: session.path,
                chatId: resumeChatId,
                abort: abortSignal,
                cursorArgs: session.cursorArgs,
                model: session.model,
                mode,
                yolo,
                autoReview,
                worktree: session.cursorWorktree,
                addDirs: session.cursorAddDirs,
                onChatFound: (chatId) => session.onSessionFound(chatId)
            });
        },
        sendFailureMessage: (message) => {
            const converted = convertAgentMessage({ type: 'error', message });
            if (converted) {
                session.sendAgentMessage(converted);
            }
        },
        recordLocalLaunchFailure: (message, exitReason) => {
            session.recordLocalLaunchFailure(message, exitReason);
        },
        abortLogMessage: 'doAbort',
        switchLogMessage: 'doSwitch'
    });

    const result = await launcher.run();
    return result === 'exit' ? 'exit' : 'switch';
}
