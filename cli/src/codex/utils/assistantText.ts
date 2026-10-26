import { stripNotifySummaryFooter } from '@hapi/protocol/messages';

/** Keep turn summaries out of explicitly intermediate Codex output. */
export function codexAssistantText(text: string, phase: unknown): string {
    if (phase === 'commentary' || phase === 'partial_answer') {
        return stripNotifySummaryFooter(text);
    }
    // Missing/unknown phases provide no evidence that a message is interim.
    return text;
}
