import { record, string } from './gateway';

export function codexPlanProposalId(threadId: string, turnId: string, itemId: string): string {
    return `codex-proposed-plan:${threadId}:${turnId}:${itemId}`;
}

export function planProposalForItem(threadId: string, turnId: string, item: unknown): string | undefined {
    const value = record(item);
    const itemId = string(value.id);
    return value.type === 'plan' && itemId && typeof value.text === 'string' && value.text.trim()
        ? codexPlanProposalId(threadId, turnId, itemId) : undefined;
}

export function planProposalForTurn(threadId: string, turn: Record<string, unknown>): string | undefined {
    const turnId = string(turn.id);
    if (!turnId || !Array.isArray(turn.items)) return undefined;
    return turn.items.map(item => planProposalForItem(threadId, turnId, item)).filter(Boolean).at(-1);
}

export function planImplementationMessageId(planId: string, attempt = 1): string {
    const base = `${planId}:implement`;
    return attempt === 1 ? base : `${base}:${attempt}`;
}

export function planImplementationAttempt(planId: string, messageId: string): number | undefined {
    const base = `${planId}:implement`;
    if (messageId === base) return 1;
    if (!messageId.startsWith(`${base}:`)) return undefined;
    const attempt = Number(messageId.slice(base.length + 1));
    return Number.isSafeInteger(attempt) && attempt > 1 ? attempt : undefined;
}
