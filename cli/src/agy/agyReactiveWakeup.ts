import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentMessage } from '@/agent/types';
import { AGY_BACKGROUND_COMMAND_RESULT } from './agyToolCards';

type UsageMessage = Extract<AgentMessage, { type: 'usage' }>;

function addOptional(a: number | undefined, b: number | undefined): number | undefined {
    return a === undefined && b === undefined ? undefined : (a ?? 0) + (b ?? 0);
}

/** Sums token counters across multiple model steps in a turn or wakeup. */
export function addAgyUsage(total: UsageMessage | null, next: UsageMessage): UsageMessage {
    if (!total) return next;
    return {
        type: 'usage',
        inputTokens: total.inputTokens + next.inputTokens,
        outputTokens: total.outputTokens + next.outputTokens,
        totalTokens: addOptional(total.totalTokens, next.totalTokens),
        thoughtTokens: addOptional(total.thoughtTokens, next.thoughtTokens),
        cacheReadTokens: addOptional(total.cacheReadTokens, next.cacheReadTokens),
        cacheCreationTokens: addOptional(total.cacheCreationTokens, next.cacheCreationTokens)
    };
}

export interface AgyTranscriptToolCall {
    name: string;
    args: Record<string, unknown>;
}

export interface AgyTranscriptStep {
    step_index: number;
    source?: string;
    type?: string;
    status?: string;
    created_at?: string;
    content?: string;
    thinking?: string;
    tool_calls?: AgyTranscriptToolCall[];
    input_tokens?: number;
    output_tokens?: number;
    cache_read_tokens?: number;
    thought_tokens?: number;
    truncated_fields?: string[];
}

export interface AgyReactiveTimingConfig {
    /** Quiet period before treating a no-tool PLANNER_RESPONSE or ask_question as settled. */
    settleMs: number;
    /** Grace window before treating a gated tool call in PLANNER_RESPONSE as parked on ACP approval. */
    toolParkMs: number;
    /** Longer grace window for non-gated / external network tools before assuming a stall. */
    slowToolParkMs: number;
    /** Safety bound if agy stops writing mid-wakeup without a final PLANNER_RESPONSE. */
    maxIdleMs: number;
}

export type AgyReactiveInspection =
    | { state: 'none' }
    | { state: 'running'; latestStepIndex: number }
    | { state: 'completed'; steps: AgyTranscriptStep[]; latestStepIndex: number }
    | { state: 'parked_on_tool'; latestStepIndex: number }
    | { state: 'timed_out'; steps: AgyTranscriptStep[]; latestStepIndex: number };

/** Internal prompt sent when a reactive wakeup parks on a tool approval or question. */
export const AGY_WAKEUP_CONTINUE_PROMPT =
    '[System note: background wakeup reattached — continue your in-progress response to the background notification above without mentioning this note.]';

/** Tools executed internally by agy without ACP permission prompts. */
const AGY_INTERNAL_TOOLS = new Set([
    'manage_subagents',
    'manage_task',
    'send_message',
    'schedule',
    'invoke_subagent',
    'define_subagent',
    'swarm'
]);

/** Tools that commonly park in `SetPendingToolPermission` when no `session/prompt` is open. */
const AGY_GATED_TOOLS = new Set([
    'run_command',
    'edit_file',
    'write_file',
    'call_mcp_tool'
]);

export function defaultAgyBrainDir(): string {
    return join(homedir(), '.gemini', 'antigravity-cli', 'brain');
}

function isSafeSessionSegment(sessionId: string): boolean {
    return sessionId.length > 0
        && !sessionId.includes('/')
        && !sessionId.includes('\\')
        && !sessionId.includes('..')
        && !sessionId.includes('\0');
}

export function agyTranscriptPaths(brainDir: string, sessionId: string): {
    logsDir: string;
    compactPath: string;
    fullPath: string;
} | null {
    if (!isSafeSessionSegment(sessionId)) return null;
    const logsDir = join(brainDir, sessionId, '.system_generated', 'logs');
    return {
        logsDir,
        compactPath: join(logsDir, 'transcript.jsonl'),
        fullPath: join(logsDir, 'transcript_full.jsonl')
    };
}

/**
 * Parses only newline-terminated JSONL lines so a partial line written
 * mid-flush is ignored until its trailing newline lands.
 */
function readCompleteJsonlSteps(filePath: string): AgyTranscriptStep[] {
    let raw: string;
    try {
        raw = readFileSync(filePath, 'utf8');
    } catch {
        return [];
    }
    const lastNewline = raw.lastIndexOf('\n');
    if (lastNewline < 0) return [];
    const completeChunk = raw.slice(0, lastNewline);
    const steps: AgyTranscriptStep[] = [];
    for (const line of completeChunk.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as Partial<AgyTranscriptStep>;
            if (parsed && typeof parsed === 'object' && typeof parsed.step_index === 'number') {
                steps.push(parsed as AgyTranscriptStep);
            }
        } catch {
            // Ignore malformed lines.
        }
    }
    return steps;
}

/** Reads the highest `step_index` currently persisted in `transcript.jsonl` (-1 when absent). */
export function readLatestAgyTranscriptStepIndex(brainDir: string, sessionId: string): number {
    const paths = agyTranscriptPaths(brainDir, sessionId);
    if (!paths) return -1;
    const steps = readCompleteJsonlSteps(paths.compactPath);
    let maxStep = -1;
    for (const step of steps) {
        if (step.step_index > maxStep) maxStep = step.step_index;
    }
    return maxStep;
}

/**
 * Reads steps with `step_index > afterStepIndex`, upgrading any truncated rows
 * from `transcript_full.jsonl` so long messages and tool outputs stay intact.
 */
export function readAgyTranscriptStepsAfter(
    brainDir: string,
    sessionId: string,
    afterStepIndex: number
): AgyTranscriptStep[] {
    const paths = agyTranscriptPaths(brainDir, sessionId);
    if (!paths) return [];
    const compactSteps = readCompleteJsonlSteps(paths.compactPath)
        .filter((step) => step.step_index > afterStepIndex);
    if (compactSteps.length === 0) return [];

    const needsFull = compactSteps.some(
        (step) => Array.isArray(step.truncated_fields) && step.truncated_fields.length > 0
    );
    if (!needsFull) return compactSteps;

    const fullSteps = readCompleteJsonlSteps(paths.fullPath);
    if (fullSteps.length === 0) return compactSteps;
    const fullByIndex = new Map<number, AgyTranscriptStep>();
    for (const step of fullSteps) {
        if (step.step_index > afterStepIndex) {
            fullByIndex.set(step.step_index, step);
        }
    }
    return compactSteps.map((step) => fullByIndex.get(step.step_index) ?? step);
}

function isOutsideWorkspace(filePath: unknown, workspacePath: string): boolean {
    if (typeof filePath !== 'string' || !filePath || !workspacePath) return false;
    const normalizedRoot = workspacePath.endsWith('/') ? workspacePath : `${workspacePath}/`;
    return filePath !== workspacePath && !filePath.startsWith(normalizedRoot);
}

/**
 * Decodes `tool_calls[].args` from `transcript.jsonl`, where agy stores each
 * argument value as a JSON-serialized string (`"\"/a/b\""`, `"250"`, `"false"`).
 */
export function decodeAgyTranscriptArgs(rawArgs: Record<string, unknown> | undefined): Record<string, unknown> {
    if (!rawArgs || typeof rawArgs !== 'object') return {};
    const decoded: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(rawArgs)) {
        if (typeof value !== 'string') {
            decoded[key] = value;
            continue;
        }
        const trimmed = value.trim();
        const looksJsonEncoded =
            (trimmed.startsWith('"') && trimmed.endsWith('"'))
            || (trimmed.startsWith('{') && trimmed.endsWith('}'))
            || (trimmed.startsWith('[') && trimmed.endsWith(']'))
            || trimmed === 'true'
            || trimmed === 'false'
            || trimmed === 'null'
            || /^-?\d+(?:\.\d+)?$/.test(trimmed);
        if (!looksJsonEncoded) {
            decoded[key] = value;
            continue;
        }
        try {
            decoded[key] = JSON.parse(trimmed);
        } catch {
            decoded[key] = value;
        }
    }
    return decoded;
}

function requiredParkMsForToolCalls(
    toolCalls: AgyTranscriptToolCall[],
    workspacePath: string,
    timings: AgyReactiveTimingConfig
): number | null {
    let waitMs: number | null = null;
    const lowerBound = (candidate: number) => {
        waitMs = waitMs === null ? candidate : Math.min(waitMs, candidate);
    };

    for (const call of toolCalls) {
        const name = call.name;
        if (name === 'ask_question') {
            lowerBound(timings.settleMs);
            continue;
        }
        if (AGY_GATED_TOOLS.has(name)) {
            lowerBound(timings.toolParkMs);
            continue;
        }
        if (name === 'read_file') {
            const args = decodeAgyTranscriptArgs(call.args);
            if (isOutsideWorkspace(args.Path, workspacePath)) {
                lowerBound(timings.toolParkMs);
            } else {
                lowerBound(timings.slowToolParkMs);
            }
            continue;
        }
        if (!AGY_INTERNAL_TOOLS.has(name)) {
            lowerBound(timings.slowToolParkMs);
        }
    }
    return waitMs;
}

/**
 * Classifies new transcript steps written after a user turn finished.
 * Only autonomous `SYSTEM_MESSAGE` entries start a reactive wakeup.
 */
export function inspectAgyReactiveSteps(
    stepsAfterTurn: AgyTranscriptStep[],
    workspacePath: string,
    nowMs: number,
    lastProgressAtMs: number,
    timings: AgyReactiveTimingConfig
): AgyReactiveInspection {
    const firstSystemIdx = stepsAfterTurn.findIndex(
        (step) => step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE'
    );
    if (firstSystemIdx < 0) return { state: 'none' };

    const reactiveSteps = stepsAfterTurn.slice(firstSystemIdx);
    const last = reactiveSteps[reactiveSteps.length - 1]!;
    const idleForMs = Math.max(0, nowMs - lastProgressAtMs);

    if (last.source === 'MODEL' && last.type === 'PLANNER_RESPONSE' && last.status === 'DONE') {
        const toolCalls = Array.isArray(last.tool_calls) ? last.tool_calls : [];
        if (toolCalls.length === 0) {
            if (idleForMs >= timings.settleMs) {
                return { state: 'completed', steps: reactiveSteps, latestStepIndex: last.step_index };
            }
            return { state: 'running', latestStepIndex: last.step_index };
        }

        const parkMs = requiredParkMsForToolCalls(toolCalls, workspacePath, timings);
        if (parkMs !== null && idleForMs >= parkMs) {
            return { state: 'parked_on_tool', latestStepIndex: last.step_index };
        }
    }

    if (idleForMs >= timings.maxIdleMs) {
        return { state: 'timed_out', steps: reactiveSteps, latestStepIndex: last.step_index };
    }

    return { state: 'running', latestStepIndex: last.step_index };
}

function stripAgyStepTimestamps(content: string): string {
    return content.replace(/^(?:Created At: [^\n]*\n(?:Completed At: [^\n]*\n)?)+/, '');
}

function parseCompletedBackgroundTask(
    systemMessageContent: string | undefined,
    sessionId: string
): { body: string; exitCode?: number } | null {
    if (!systemMessageContent) return null;
    const escapedSession = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `Task id "${escapedSession}/task-\\d+" finished with result:\\n([\\s\\S]*?)(?:\\nLog: file:\\/\\/\\/[^\\n]*)?\\s*<\\/SYSTEM_MESSAGE>`
    );
    const match = systemMessageContent.match(pattern);
    if (!match) return null;
    const body = match[1]!.trimEnd();
    const exitMatch = body.match(/^Command exited with code (-?\d+)\./);
    const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
    return { body, ...(Number.isFinite(exitCode) ? { exitCode } : {}) };
}

function buildGenericToolOutput(
    toolName: string,
    step: AgyTranscriptStep
): { output: unknown; status: 'completed' | 'failed'; backgrounded: boolean } {
    const raw = stripAgyStepTimestamps(step.content ?? '');
    if (toolName === 'run_command' && step.status === 'RUNNING') {
        return {
            output: AGY_BACKGROUND_COMMAND_RESULT,
            status: 'completed',
            backgrounded: true
        };
    }
    if (toolName === 'run_command') {
        const exitMatch = raw.match(/^Command exited with code (-?\d+)\./);
        const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
        const failed = step.status === 'ERROR' || (exitCode !== undefined && exitCode !== 0);
        return {
            output: {
                output: raw,
                ...(exitCode !== undefined ? { exit_code: exitCode } : {})
            },
            status: failed ? 'failed' : 'completed',
            backgrounded: false
        };
    }
    return {
        output: raw,
        status: step.status === 'ERROR' ? 'failed' : 'completed',
        backgrounded: false
    };
}

/**
 * Converts a completed reactive wakeup transcript slice into canonical
 * `AgentMessage` events and aggregated token usage.
 */
export function convertAgyReactiveSteps(
    sessionId: string,
    steps: AgyTranscriptStep[],
    openBackgroundCommandIds: string[]
): {
    messages: AgentMessage[];
    usage: UsageMessage | null;
    durationMs: number | null;
} {
    const messages: AgentMessage[] = [];
    let usage: UsageMessage | null = null;
    let firstTimestampMs: number | null = null;
    let lastTimestampMs: number | null = null;

    for (const step of steps) {
        if (step.created_at) {
            const parsed = Date.parse(step.created_at);
            if (Number.isFinite(parsed)) {
                firstTimestampMs = firstTimestampMs === null ? parsed : Math.min(firstTimestampMs, parsed);
                lastTimestampMs = lastTimestampMs === null ? parsed : Math.max(lastTimestampMs, parsed);
            }
        }
    }

    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i]!;
        if (step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE') {
            const completedBg = parseCompletedBackgroundTask(step.content, sessionId);
            if (completedBg && openBackgroundCommandIds.length > 0) {
                const callId = openBackgroundCommandIds.shift()!;
                const failed = completedBg.exitCode !== undefined && completedBg.exitCode !== 0;
                messages.push({
                    type: 'tool_result',
                    id: callId,
                    status: failed ? 'failed' : 'completed',
                    output: {
                        output: completedBg.body,
                        ...(completedBg.exitCode !== undefined ? { exit_code: completedBg.exitCode } : {})
                    }
                });
            }
            continue;
        }

        if (step.source !== 'MODEL' || step.type !== 'PLANNER_RESPONSE') {
            continue;
        }

        if (typeof step.input_tokens === 'number' || typeof step.output_tokens === 'number') {
            const inputTokens = step.input_tokens ?? 0;
            const outputTokens = step.output_tokens ?? 0;
            const thoughtTokens = step.thought_tokens;
            const cacheReadTokens = step.cache_read_tokens;
            const totalTokens = inputTokens + outputTokens + (thoughtTokens ?? 0) + (cacheReadTokens ?? 0);
            usage = addAgyUsage(usage, {
                type: 'usage',
                inputTokens,
                outputTokens,
                totalTokens,
                ...(thoughtTokens !== undefined ? { thoughtTokens } : {}),
                ...(cacheReadTokens !== undefined ? { cacheReadTokens } : {})
            });
        }

        const thinking = step.thinking?.trim();
        if (thinking) {
            messages.push({ type: 'reasoning', text: thinking });
        }

        const content = step.content?.trim();
        if (content) {
            messages.push({ type: 'text', text: step.content! });
        }

        const toolCalls = Array.isArray(step.tool_calls) ? step.tool_calls : [];
        if (toolCalls.length === 0) continue;

        const actionSteps: AgyTranscriptStep[] = [];
        let cursor = i + 1;
        while (
            cursor < steps.length
            && actionSteps.length < toolCalls.length
            && steps[cursor]!.source === 'MODEL'
            && steps[cursor]!.type !== 'PLANNER_RESPONSE'
        ) {
            actionSteps.push(steps[cursor]!);
            cursor += 1;
        }
        i = cursor - 1;

        for (let callIdx = 0; callIdx < toolCalls.length; callIdx += 1) {
            const call = toolCalls[callIdx]!;
            const action = actionSteps[callIdx];
            const decodedArgs = decodeAgyTranscriptArgs(call.args);
            const id = `agy-wakeup-${sessionId}-${step.step_index}-${callIdx}`;
            const resultInfo = action
                ? buildGenericToolOutput(call.name, action)
                : { output: '', status: 'completed' as const, backgrounded: false };
            messages.push({
                type: 'tool_call',
                id,
                name: call.name,
                input: decodedArgs,
                status: resultInfo.status,
                title: call.name,
                nativeName: call.name,
                nativeArgs: decodedArgs
            });
            if (action) {
                messages.push({
                    type: 'tool_result',
                    id,
                    output: resultInfo.output,
                    status: resultInfo.status
                });
                if (resultInfo.backgrounded) {
                    openBackgroundCommandIds.push(id);
                }
            }
        }
    }

    const durationMs = firstTimestampMs !== null && lastTimestampMs !== null
        ? Math.max(0, lastTimestampMs - firstTimestampMs)
        : null;

    return { messages, usage, durationMs };
}
