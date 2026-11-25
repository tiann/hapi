import type { AgentMessage } from './types';

/** A span of the round not spent generating: a tool run or a wait for the user. */
export type GenerationIdleWindow = {
    start: number;
    end: number | null;
};

/**
 * Generation time is the round minus the spans spent running tools or waiting
 * for the user. Spans are clipped to the round and merged, so overlaps count
 * once; an open span ends with the round.
 */
export function generationTimeMs(
    sentAt: number | null,
    answeredAt: number | null,
    windows: GenerationIdleWindow[]
): number | null {
    if (sentAt === null || answeredAt === null || answeredAt <= sentAt) return null;
    const clipped = windows
        .map(({ start, end }) => ({ start: Math.max(start, sentAt), end: Math.min(end ?? answeredAt, answeredAt) }))
        .filter(({ start, end }) => end > start)
        .sort((a, b) => a.start - b.start);
    let excluded = 0;
    let coveredUntil = sentAt;
    for (const { start, end } of clipped) {
        const from = Math.max(start, coveredUntil);
        if (end > from) excluded += end - from;
        coveredUntil = Math.max(coveredUntil, end);
    }
    return answeredAt - sentAt - excluded;
}

/**
 * Event-fed generation clock for one ACP turn. Agent output
 * (`agent_message_chunk` / `agent_thought_chunk` and every other session
 * update except usage reports and the turn boundary) marks the turn as
 * generating; tool calls (`tool_call` until its `tool_call_update` reports
 * completed/failed) and waits for the user become idle windows that are
 * subtracted from the round.
 */
export class GenerationClock {
    private readonly idleWindows: GenerationIdleWindow[] = [];
    private readonly toolWindows = new Map<string, GenerationIdleWindow>();
    private sawOutput = false;

    constructor(private readonly now: () => number = Date.now) {}

    /** Feeds one ACP session/update-derived agent message. */
    observe(message: AgentMessage): void {
        if (message.type === 'usage' || message.type === 'turn_complete' || message.type === 'round_summary') return;
        this.sawOutput = true;
        if (message.type === 'tool_call' || message.type === 'tool_result') this.trackToolWindow(message);
    }

    /**
     * Opens a wait-for-the-user span (the permission handler's `onUserWait`
     * hook); the returned callback closes it once the user answered.
     */
    beginUserWait(): () => void {
        const window: GenerationIdleWindow = { start: this.now(), end: null };
        this.idleWindows.push(window);
        return () => { window.end ??= this.now(); };
    }

    /** Null when the turn produced no output the clock saw. */
    generationMs(sentAt: number | null, answeredAt: number | null): number | null {
        if (!this.sawOutput) return null;
        return generationTimeMs(sentAt, answeredAt, this.idleWindows);
    }

    // A tool's span starts at its first report — including one still waiting
    // for approval — and ends when a completed/failed update or its result
    // arrives, mirroring the window bookkeeping the agy launcher has always
    // used for this clock's inputs.
    private trackToolWindow(message: Extract<AgentMessage, { type: 'tool_call' }> | Extract<AgentMessage, { type: 'tool_result' }>): void {
        const now = this.now();
        let window = this.toolWindows.get(message.id);
        if (!window) {
            window = { start: now, end: null };
            this.toolWindows.set(message.id, window);
            this.idleWindows.push(window);
        }
        if (message.status === 'completed' || message.status === 'failed') window.end ??= now;
    }
}