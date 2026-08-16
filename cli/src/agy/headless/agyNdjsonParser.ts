import type { AgyTranscriptEntry, AgyToolCall } from '../utils/agyTranscriptTypes';

/**
 * agy `--output-format stream-json` NDJSON protocol (measured on agy 1.1.13).
 *
 * Lines (one JSON object per line, keyed by an `event` discriminator):
 *   {"event":"init","conversation_id":"...","init":{"cwd":"...","tools":[...],"permission_mode":"request-review"}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":0,"state":"DONE","step_type":"user_input"}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":2,"state":"ACTIVE","step_type":"agent_response","text_delta":"..."}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":2,"state":"DONE","step_type":"agent_response","text_delta":"\n","duration_seconds":2.4,"usage":{...}}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":3,"state":"ACTIVE","step_type":"tool","tool_name":"run_command","tool_info":{"name":"run_command","parameters":{"CommandLine":"echo hi"}}}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":3,"state":"DONE","step_type":"tool","tool_name":"run_command","duration_seconds":0.2,"tool_info":{"name":"run_command","parameters":{...},"output":"hi\r\n"}}}
 *   {"event":"step_update","step_update":{"conversation_id":"...","step_index":4,"state":"DONE","step_type":"checkpoint","duration_seconds":0.7,"usage":{...}}}
 *   {"event":"result","result":{"conversation_id":"...","status":"SUCCESS","response":"OK\n","duration_seconds":3.4,"num_turns":1,"usage":{...}}}
 *
 * Mapping to the existing transcript-entry channel (sendAgySessionMessage):
 *   - init        → conversation id becomes known immediately (no hook needed)
 *   - user_input  → delivery confirmation (emitMessagesConsumed); no re-emit,
 *                   the web already rendered the user's own message
 *   - agent_response text_delta → accumulates per step_index, flushed once the
 *                   step reaches DONE (matches the scanner's whole-entry emit)
 *   - tool        → action entry with the invocation paired directly from the
 *                   step itself (stream-json carries name+parameters; no FIFO)
 *   - checkpoint  → internal compaction noise, skipped
 *   - result      → turn completion + authoritative conversation id
 */

export type AgyStreamEvent =
    | { kind: 'init'; conversationId: string }
    | { kind: 'user-input'; stepIndex: number; conversationId?: string }
    | { kind: 'planner-delta'; stepIndex: number; delta: string; isDone: boolean; conversationId?: string }
    | { kind: 'tool'; entry: AgyTranscriptEntry; toolCall: AgyToolCall; isDone: boolean; conversationId?: string }
    | { kind: 'checkpoint'; stepIndex: number; conversationId?: string }
    | { kind: 'result'; conversationId: string; status: string; response: string | null }
    | { kind: 'ignored'; reason: string };

type StepUpdate = {
    conversation_id?: string;
    step_index?: number;
    state?: string;
    step_type?: string;
    text_delta?: string;
    tool_name?: string;
    tool_info?: {
        name?: string;
        parameters?: Record<string, unknown>;
        output?: string;
    };
};

type ResultEnvelope = {
    conversation_id?: string;
    status?: string;
    response?: string;
};

/** agy tool ids are snake_case (run_command, view_file, …); transcript entry types are SCREAMING_SNAKE (RUN_COMMAND, VIEW_FILE, …). */
export function toolNameToEntryType(toolName: string): string {
    return toolName.toUpperCase();
}

/**
 * Parse one NDJSON line into a stream event. Pure; tolerates malformed lines
 * (returns an `ignored` event instead of throwing).
 */
export function parseAgyNdjsonLine(rawLine: string): AgyStreamEvent {
    const trimmed = rawLine.trim();
    if (!trimmed) return { kind: 'ignored', reason: 'empty line' };

    let parsed: unknown;
    try {
        parsed = JSON.parse(trimmed);
    } catch {
        return { kind: 'ignored', reason: 'not json' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
        return { kind: 'ignored', reason: 'not an object' };
    }
    const event = (parsed as { event?: unknown }).event;

    if (event === 'init') {
        const conversationId = (parsed as { conversation_id?: unknown }).conversation_id;
        if (typeof conversationId === 'string' && conversationId) {
            return { kind: 'init', conversationId };
        }
        return { kind: 'ignored', reason: 'init without conversation_id' };
    }

    if (event === 'result') {
        const rawResult = (parsed as { result?: unknown }).result;
        if (!rawResult || typeof rawResult !== 'object') {
            return { kind: 'ignored', reason: 'result without payload' };
        }
        const result = rawResult as ResultEnvelope;
        // A status-less envelope is malformed/format-drifted: treat it as ignored
        // so the driver does NOT acknowledge the delivery or suppress retry.
        if (typeof result.status !== 'string' || !result.status) {
            return { kind: 'ignored', reason: 'result without status' };
        }
        return {
            kind: 'result',
            conversationId: typeof result.conversation_id === 'string' ? result.conversation_id : '',
            status: result.status,
            response: typeof result.response === 'string' ? result.response : null,
        };
    }

    if (event === 'step_update') {
        const step = (parsed as { step_update?: unknown }).step_update as StepUpdate | undefined;
        if (!step || typeof step !== 'object') return { kind: 'ignored', reason: 'step_update without payload' };
        const stepIndex = typeof step.step_index === 'number' ? step.step_index : -1;
        const state = step.state ?? '';
        const stepType = step.step_type ?? '';
        // Every step_update carries the authoritative conversation_id (measured
        // protocol); exposed so the driver can adopt it even when the init line
        // was absent/malformed and the process crashes before a result envelope.
        const stepConversationId = typeof step.conversation_id === 'string' && step.conversation_id
            ? step.conversation_id
            : undefined;

        if (stepType === 'user_input') {
            return { kind: 'user-input', stepIndex, conversationId: stepConversationId };
        }

        if (stepType === 'agent_response') {
            // text_delta arrives on ACTIVE and DONE lines alike; DONE also carries
            // usage. A DONE line WITHOUT a trailing delta still closes the step:
            // forward it (empty delta) so the accumulator flushes any text from
            // earlier ACTIVE lines of the same step.
            const delta = typeof step.text_delta === 'string' ? step.text_delta : '';
            if (delta || state === 'DONE') {
                return {
                    kind: 'planner-delta',
                    stepIndex,
                    delta,
                    isDone: state === 'DONE',
                    conversationId: stepConversationId,
                };
            }
            return { kind: 'ignored', reason: 'agent_response without text_delta' };
        }

        if (stepType === 'tool') {
            const toolName = step.tool_name ?? step.tool_info?.name;
            if (typeof toolName !== 'string' || !toolName) {
                return { kind: 'ignored', reason: 'tool step without tool_name' };
            }
            const parameters = step.tool_info?.parameters ?? {};
            const output = step.tool_info?.output;
            const entry: AgyTranscriptEntry = {
                step_index: stepIndex,
                source: 'MODEL',
                type: toolNameToEntryType(toolName),
                status: 'DONE',
                created_at: '',
                content: output ?? '',
            };
            return { kind: 'tool', entry, toolCall: { name: toolName, args: parameters }, isDone: state === 'DONE', conversationId: stepConversationId };
        }

        if (stepType === 'checkpoint') {
            return { kind: 'checkpoint', stepIndex, conversationId: stepConversationId };
        }

        return { kind: 'ignored', reason: `unhandled step_type ${stepType} (state ${state})` };
    }

    return { kind: 'ignored', reason: `unknown event ${String(event)}` };
}

/**
 * Accumulates text deltas per step_index and emits whole PLANNER_RESPONSE
 * entries once the step reaches DONE. Stateful, so the driver can feed lines
 * as they stream in and flush complete entries at the right boundary.
 */
export class AgyPlannerAccumulator {
    private readonly deltas = new Map<number, string>();
    private readonly doneSteps = new Set<number>();

    /**
     * Feed a delta for a step. Returns the completed entry when the step
     * transitions to DONE (and had text), null otherwise.
     */
    feedDelta(stepIndex: number, delta: string, isDone: boolean): AgyTranscriptEntry | null {
        const accumulated = (this.deltas.get(stepIndex) ?? '') + delta;
        this.deltas.set(stepIndex, accumulated);
        if (!isDone) return null;
        this.doneSteps.add(stepIndex);
        return this.flush(stepIndex);
    }

    /**
     * Mark a step DONE without a trailing delta (the DONE line may carry only
     * usage). Flushes any text accumulated from earlier ACTIVE lines.
     */
    feedDone(stepIndex: number): AgyTranscriptEntry | null {
        this.doneSteps.add(stepIndex);
        return this.flush(stepIndex);
    }

    /** Force-flush a step's accumulated text (e.g. at result time). */
    flush(stepIndex: number): AgyTranscriptEntry | null {
        const content = this.deltas.get(stepIndex);
        this.deltas.delete(stepIndex);
        if (!content || content.length === 0) return null;
        return {
            step_index: stepIndex,
            source: 'MODEL',
            type: 'PLANNER_RESPONSE',
            status: 'DONE',
            created_at: '',
            content,
        };
    }

    /** True when a step has any accumulated text (used to decide forced flushes). */
    hasPending(stepIndex: number): boolean {
        return (this.deltas.get(stepIndex)?.length ?? 0) > 0;
    }

    /** Flush every step with pending text (e.g. at the result envelope or turn close). */
    flushAll(): AgyTranscriptEntry[] {
        const entries: AgyTranscriptEntry[] = [];
        const pending = [...this.deltas.keys()].sort((a, b) => a - b);
        for (const stepIndex of pending) {
            const entry = this.flush(stepIndex);
            if (entry) entries.push(entry);
        }
        return entries;
    }

    isDone(stepIndex: number): boolean {
        return this.doneSteps.has(stepIndex);
    }
}
