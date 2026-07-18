import { randomUUID } from 'node:crypto';
import { BaseLocalLauncher } from '@/modules/common/launcher/BaseLocalLauncher';
import { convertAgentMessage } from '@/agent/messageConverter';
import { grokLocal } from './grokLocal';
import type { GrokSession } from './session';
import { createGrokSessionScanner, type GrokSessionScannerHandle } from './utils/grokSessionScanner';
import { getGrokSessionDir } from './utils/grokPaths';
import type { PermissionMode } from './types';

export function resolveGrokLocalSession(
    existingSessionId: string | null,
    createId: () => string = randomUUID
): { sessionId: string; resume: boolean } {
    return existingSessionId
        ? { sessionId: existingSessionId, resume: true }
        : { sessionId: createId(), resume: false };
}

export async function grokLocalLauncher(session: GrokSession): Promise<'switch' | 'exit'> {
    const permissionMode = session.getPermissionMode() as PermissionMode | undefined;
    if (permissionMode === 'read-only' || permissionMode === 'safe-yolo') {
        session.sendSessionEvent({
            type: 'message',
            message: `${permissionMode} is enforced by HAPI remote ACP mode; staying in remote mode.`
        });
        return 'switch';
    }
    const { sessionId, resume } = resolveGrokLocalSession(session.sessionId);
    if (!resume) session.onSessionFound(sessionId);
    let scanner: GrokSessionScannerHandle | null = null;
    const launcher = new BaseLocalLauncher({
        label: 'grok-local', failureLabel: 'Local Grok process failed', queue: session.queue,
        rpcHandlerManager: session.client.rpcHandlerManager, startedBy: session.startedBy,
        startingMode: session.startingMode,
        launch: async (signal) => grokLocal({
            path: session.path, abort: signal, env: { ...process.env }, sessionId,
            resume, permissionMode, model: session.getModel(), effort: session.getEffort()
        }),
        sendFailureMessage: (message) => session.sendSessionEvent({ type: 'message', message }),
        recordLocalLaunchFailure: session.recordLocalLaunchFailure
    });
    try {
        scanner = await createGrokSessionScanner({
            sessionDir: getGrokSessionDir({ cwd: session.path, sessionId }),
            skipExisting: resume,
            onEvent: (event) => {
                if (event.type === 'agent') {
                    if (event.message.type === 'user_message') session.sendUserMessage(event.message.text);
                    else {
                        const converted = convertAgentMessage(event.message);
                        if (converted) session.sendAgentMessage(converted);
                    }
                } else if (event.type === 'config') {
                    session.setRuntime({ model: event.model, effort: event.effort });
                } else if (event.type === 'status') {
                    const reason = typeof event.data.reason === 'string' ? `: ${event.data.reason}` : '';
                    session.sendSessionEvent({ type: 'message', message: `Grok ${event.status}${reason}` });
                } else if (event.type === 'mode') {
                    session.sendSessionEvent({ type: 'message', message: `Grok mode changed: ${event.mode}` });
                } else if (event.type === 'interaction') {
                    session.sendSessionEvent({
                        type: 'message',
                        message: `Grok interaction ${event.status}: ${event.kind ?? event.toolCallId}`
                    });
                } else if (event.type === 'unknown') {
                    session.sendAgentMessage({ type: 'grok-extension', method: event.method, params: event.params });
                }
            }
        });
        return await launcher.run();
    } finally {
        await scanner?.cleanup();
    }
}
