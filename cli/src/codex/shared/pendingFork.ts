import type { Metadata } from '@/api/types';

export function pendingForkParams(request: NonNullable<Metadata['codexForkRequest']>, source: string | undefined): Record<string, unknown> {
    if (!request.sourceThreadId || request.sourceThreadId !== source) throw new Error('Codex fork source mismatch');
    if (request.lastTurnId !== undefined && request.beforeTurnId !== undefined) throw new Error('Codex fork has conflicting turn boundaries');
    if (request.lastTurnId === '' || request.beforeTurnId === '') throw new Error('Codex fork has an empty turn boundary');
    return { threadId: request.sourceThreadId,
        ...(request.lastTurnId !== undefined ? { lastTurnId: request.lastTurnId } : {}),
        ...(request.beforeTurnId !== undefined ? { beforeTurnId: request.beforeTurnId } : {}), deferGoalContinuation: true };
}
