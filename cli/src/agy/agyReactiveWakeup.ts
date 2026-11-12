import { closeSync, openSync, readSync, statSync } from 'node:fs';
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

export interface AgyOpenBackgroundCommand {
    callId: string;
    taskId?: string;
    afterStepIndex?: number;
    ordinalInTurn?: number;
    maxStepIndex?: number;
    stepIndex?: number;
    synthetic?: boolean;
    commandLine?: string;
    nativeArgs?: Record<string, unknown>;
}

export interface AgyLiveBackgroundCompletionLookup {
    liveCallId?: string;
    commandLine?: string;
    nativeArgs?: Record<string, unknown>;
    callStatus?: 'pending' | 'in_progress' | 'completed' | 'failed';
    resultOutput?: unknown;
    resultStatus?: 'completed' | 'failed';
}

export type AgySyntheticCommandMatch =
    | { kind: 'matched'; entry: AgyOpenBackgroundCommand }
    | { kind: 'ambiguous' }
    | { kind: 'none' };

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

interface JsonlCacheEntry {
    ino: number;
    mtimeMs: number;
    size: number;
    parsedOffset: number;
    head: Buffer;
    steps: AgyTranscriptStep[];
}

const JSONL_CACHE_LIMIT = 8;
const JSONL_HEAD_CHECK_BYTES = 128;
const jsonlFileCache = new Map<string, JsonlCacheEntry>();

function parseJsonlChunk(raw: string, out: AgyTranscriptStep[]): void {
    for (const line of raw.split('\n')) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const parsed = JSON.parse(trimmed) as Partial<AgyTranscriptStep>;
            if (parsed && typeof parsed === 'object' && typeof parsed.step_index === 'number') {
                out.push(parsed as AgyTranscriptStep);
            }
        } catch {
            // Ignore malformed lines.
        }
    }
}

/**
 * Incrementally reads newline-terminated JSONL steps from `filePath`.
 * Unchanged files cost a single `statSync` (0 bytes read); appended turns read
 * and parse only the newly written tail bytes.
 */
function readCompleteJsonlSteps(filePath: string): AgyTranscriptStep[] {
    let stat: ReturnType<typeof statSync>;
    try {
        stat = statSync(filePath);
    } catch {
        jsonlFileCache.delete(filePath);
        return [];
    }
    if (stat.size === 0) {
        jsonlFileCache.delete(filePath);
        return [];
    }

    const cached = jsonlFileCache.get(filePath);
    if (cached && cached.ino === stat.ino && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) {
        return cached.steps;
    }

    let fd: number;
    try {
        fd = openSync(filePath, 'r');
    } catch {
        return cached?.steps ?? [];
    }

    try {
        let canAppend = false;
        if (cached && cached.ino === stat.ino && stat.size >= cached.parsedOffset && cached.head.length > 0) {
            const checkBuf = Buffer.allocUnsafe(cached.head.length);
            const bytes = readSync(fd, checkBuf, 0, cached.head.length, 0);
            canAppend = bytes === cached.head.length && checkBuf.equals(cached.head);
        }

        const startOffset = canAppend && cached ? cached.parsedOffset : 0;
        const steps = canAppend && cached ? [...cached.steps] : [];
        const remaining = stat.size - startOffset;

        let parsedOffset = startOffset;
        if (remaining > 0) {
            const tailBuf = Buffer.allocUnsafe(remaining);
            const bytesRead = readSync(fd, tailBuf, 0, remaining, startOffset);
            if (bytesRead > 0) {
                const slice = tailBuf.subarray(0, bytesRead);
                const lastNewline = slice.lastIndexOf(0x0a);
                if (lastNewline >= 0) {
                    const completeBytes = slice.subarray(0, lastNewline);
                    parseJsonlChunk(completeBytes.toString('utf8'), steps);
                    parsedOffset = startOffset + lastNewline + 1;
                }
            }
        }

        let head = canAppend && cached ? cached.head : Buffer.alloc(0);
        if (head.length === 0 && parsedOffset > 0) {
            const headLen = Math.min(JSONL_HEAD_CHECK_BYTES, parsedOffset);
            head = Buffer.allocUnsafe(headLen);
            const headRead = readSync(fd, head, 0, headLen, 0);
            head = head.subarray(0, headRead);
        }

        if (!jsonlFileCache.has(filePath) && jsonlFileCache.size >= JSONL_CACHE_LIMIT) {
            const oldestKey = jsonlFileCache.keys().next().value;
            if (oldestKey !== undefined) jsonlFileCache.delete(oldestKey);
        }
        jsonlFileCache.set(filePath, {
            ino: stat.ino,
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            parsedOffset,
            head,
            steps
        });
        return steps;
    } finally {
        closeSync(fd);
    }
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

    let lastSystemIdx = -1;
    let lastPlannerIdx = -1;
    for (let idx = 0; idx < reactiveSteps.length; idx += 1) {
        const step = reactiveSteps[idx]!;
        if (step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE') {
            lastSystemIdx = idx;
        } else if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE') {
            lastPlannerIdx = idx;
        }
    }

    if (lastPlannerIdx > lastSystemIdx) {
        const planner = reactiveSteps[lastPlannerIdx]!;
        if (planner.status === 'DONE') {
            const toolCalls = Array.isArray(planner.tool_calls) ? planner.tool_calls : [];
            if (toolCalls.length === 0 && lastPlannerIdx === reactiveSteps.length - 1) {
                if (idleForMs >= timings.settleMs) {
                    return { state: 'completed', steps: reactiveSteps, latestStepIndex: last.step_index };
                }
                return { state: 'running', latestStepIndex: last.step_index };
            }

            if (toolCalls.length > 0) {
                const trailingActions = reactiveSteps
                    .slice(lastPlannerIdx + 1)
                    .filter((step) => step.source === 'MODEL' && step.type !== 'PLANNER_RESPONSE');

                const outstandingCalls: AgyTranscriptToolCall[] = [];
                for (let callIdx = 0; callIdx < toolCalls.length; callIdx += 1) {
                    const call = toolCalls[callIdx]!;
                    const action = trailingActions[callIdx];
                    if (
                        !action
                        || action.status === 'PENDING'
                        || action.status === 'WAITING'
                        || (call.name === 'ask_question' && action.status !== 'DONE' && action.status !== 'ERROR')
                    ) {
                        outstandingCalls.push(call);
                    }
                }

                if (outstandingCalls.length > 0) {
                    const parkMs = requiredParkMsForToolCalls(outstandingCalls, workspacePath, timings);
                    if (parkMs !== null && idleForMs >= parkMs) {
                        return { state: 'parked_on_tool', latestStepIndex: last.step_index };
                    }
                }
            }
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

export function extractAgyBackgroundTaskId(content: string | undefined): string | undefined {
    if (!content) return undefined;
    const match = content.match(/Tool is running as a background task with task id:\s*([^\s"'<>]+\/task-\d+)/);
    return match?.[1];
}

/**
 * Extracts `taskId` (or `undefined` for non-backgrounded / not-yet-flushed rows)
 * for every `run_command` tool call in `steps` in call-ordinal order, so an
 * earlier command completing during a steer does not shift later ordinals.
 */
export function extractAgyBackgroundTaskIds(steps: AgyTranscriptStep[]): Array<string | undefined> {
    const ids: Array<string | undefined> = [];
    for (let i = 0; i < steps.length; i += 1) {
        const step = steps[i]!;
        if (step.source !== 'MODEL' || step.type !== 'PLANNER_RESPONSE') continue;
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
            if (toolCalls[callIdx]!.name === 'run_command') {
                ids.push(extractAgyBackgroundTaskId(actionSteps[callIdx]?.content));
            }
        }
    }
    return ids;
}

/**
 * Resolves `taskId` for any open background commands whose `RUN_COMMAND` step
 * had not flushed to `transcript.jsonl` yet when the turn closed.
 */
export function resolveAgyBackgroundTaskIds(
    brainDir: string,
    sessionId: string,
    openBackgroundCommands: AgyOpenBackgroundCommand[],
    upperStepIndex?: number
): void {
    const unresolved = openBackgroundCommands.filter((entry) => !entry.taskId);
    if (unresolved.length === 0) return;

    const taskIdsByWindow = new Map<string, Array<string | undefined>>();
    for (const entry of unresolved) {
        if (entry.stepIndex !== undefined) {
            const steps = readAgyTranscriptStepsAfter(brainDir, sessionId, entry.stepIndex - 1);
            const exactStep = steps.find((step) => step.step_index === entry.stepIndex);
            const taskId = extractAgyBackgroundTaskId(exactStep?.content);
            if (taskId) entry.taskId = taskId;
            continue;
        }
        if (entry.afterStepIndex === undefined || entry.ordinalInTurn === undefined) {
            continue;
        }
        const maxStep = entry.maxStepIndex !== undefined && upperStepIndex !== undefined
            ? Math.min(entry.maxStepIndex, upperStepIndex)
            : (entry.maxStepIndex ?? upperStepIndex);
        const key = `${entry.afterStepIndex}:${maxStep ?? 'inf'}`;
        let taskIds = taskIdsByWindow.get(key);
        if (!taskIds) {
            let steps = readAgyTranscriptStepsAfter(brainDir, sessionId, entry.afterStepIndex);
            if (maxStep !== undefined) {
                steps = steps.filter((step) => step.step_index <= maxStep);
            }
            taskIds = extractAgyBackgroundTaskIds(steps);
            taskIdsByWindow.set(key, taskIds);
        }
        const resolved = taskIds[entry.ordinalInTurn];
        if (resolved) {
            entry.taskId = resolved;
        }
    }
}

/**
 * Advances the transcript cursor at the end of a prompt turn while preserving
 * any autonomous `SYSTEM_MESSAGE` wakeup slice written after `agy` closed its
 * prompt turn (before Node finished draining and settling the turn).
 */
export function advanceAgyTurnTranscriptCursor(
    stepsAfterStart: AgyTranscriptStep[],
    currentCursor: number,
    streamedTextCounts: ReadonlyMap<string, number>
): number {
    let cursor = currentCursor;
    const remainingTexts = new Map(streamedTextCounts);

    const isTerminalPlanner = (step: AgyTranscriptStep): boolean =>
        step.source === 'MODEL'
        && step.type === 'PLANNER_RESPONSE'
        && step.status === 'DONE'
        && (!Array.isArray(step.tool_calls) || step.tool_calls.length === 0);

    let lastUserInputIdx = -1;
    for (let i = 0; i < stepsAfterStart.length; i += 1) {
        const step = stepsAfterStart[i]!;
        if (step.source === 'USER_EXPLICIT' && step.type === 'USER_INPUT') {
            lastUserInputIdx = i;
        }
    }

    let startIdx = 0;
    if (lastUserInputIdx >= 0) {
        for (let i = 0; i <= lastUserInputIdx; i += 1) {
            const step = stepsAfterStart[i]!;
            if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && step.status === 'DONE') {
                const text = step.content?.trim();
                if (text) {
                    const available = remainingTexts.get(text) ?? 0;
                    if (available > 0) remainingTexts.set(text, available - 1);
                }
            }
            if (step.step_index > cursor) cursor = step.step_index;
        }
        startIdx = lastUserInputIdx + 1;
    }

    let sawTerminalPlanner = false;
    for (let i = startIdx; i < stepsAfterStart.length; i += 1) {
        const step = stepsAfterStart[i]!;
        if (step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE') {
            if (sawTerminalPlanner) break;

            let terminalIdx = -1;
            let unstreamed = false;
            const probeTexts = new Map(remainingTexts);
            for (let j = i + 1; j < stepsAfterStart.length; j += 1) {
                const ahead = stepsAfterStart[j]!;
                if (ahead.source === 'MODEL' && ahead.type === 'PLANNER_RESPONSE') {
                    if (ahead.status !== 'DONE') {
                        unstreamed = true;
                        break;
                    }
                    const text = ahead.content?.trim();
                    if (text) {
                        const available = probeTexts.get(text) ?? 0;
                        if (available <= 0) {
                            unstreamed = true;
                            break;
                        }
                        probeTexts.set(text, available - 1);
                    }
                    if (isTerminalPlanner(ahead)) {
                        terminalIdx = j;
                        break;
                    }
                }
            }

            if (unstreamed || terminalIdx < 0) {
                break;
            }
            if (step.step_index > cursor) cursor = step.step_index;
            continue;
        }

        if (step.source === 'MODEL' && step.type === 'PLANNER_RESPONSE' && step.status === 'DONE') {
            const text = step.content?.trim();
            if (text) {
                const available = remainingTexts.get(text) ?? 0;
                if (available > 0) remainingTexts.set(text, available - 1);
            }
            if (isTerminalPlanner(step)) {
                sawTerminalPlanner = true;
            }
        }

        if (step.step_index > cursor) {
            cursor = step.step_index;
        }
    }

    return cursor;
}

function parseCompletedBackgroundTask(
    systemMessageContent: string | undefined,
    sessionId: string
): { taskId: string; body: string; exitCode?: number } | null {
    if (!systemMessageContent) return null;
    const escapedSession = sessionId.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const pattern = new RegExp(
        `Task id "(${escapedSession}\\/task-\\d+)" finished with result:\\n([\\s\\S]*?)(?:\\nLog: file:\\/\\/\\/[^\\n]*)?\\s*<\\/SYSTEM_MESSAGE>`
    );
    const match = systemMessageContent.match(pattern);
    if (!match) return null;
    const taskId = match[1]!;
    const body = match[2]!.trimEnd();
    const exitMatch = body.match(/^Command exited with code (-?\d+)\./);
    const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
    return { taskId, body, ...(Number.isFinite(exitCode) ? { exitCode } : {}) };
}

function normalizeAgyCommandBody(text: string): { stdout: string; exitCode?: number } {
    const normalized = text.replace(/\r\n/g, '\n');
    const exitMatch = normalized.match(/^Command exited with code (-?\d+)\./);
    const exitCode = exitMatch ? Number(exitMatch[1]) : undefined;
    const stdout = normalized
        .replace(/^Command exited with code -?\d+\.\s*\n\s*Command output:\n?/, '')
        .trimEnd();
    return {
        stdout,
        ...(exitCode !== undefined && Number.isFinite(exitCode) ? { exitCode } : {})
    };
}

function parseLiveCommandCompletionResult(
    resultOutput: unknown
): { stdout?: string; exitCode?: number } | null {
    if (typeof resultOutput === 'string') {
        return normalizeAgyCommandBody(resultOutput);
    }
    if (!resultOutput || typeof resultOutput !== 'object') return null;
    const record = resultOutput as Record<string, unknown>;
    const rawExitCode = typeof record.exit_code === 'number' && Number.isFinite(record.exit_code)
        ? record.exit_code
        : undefined;
    if (typeof record.output === 'string') {
        const parsed = normalizeAgyCommandBody(record.output);
        const exitCode = rawExitCode ?? parsed.exitCode;
        return {
            stdout: parsed.stdout,
            ...(exitCode !== undefined ? { exitCode } : {})
        };
    }
    if (typeof record.stdout === 'string') {
        return {
            stdout: record.stdout.replace(/\r\n/g, '\n').trimEnd(),
            ...(rawExitCode !== undefined ? { exitCode: rawExitCode } : {})
        };
    }
    return rawExitCode !== undefined ? { exitCode: rawExitCode } : null;
}

function areCommandArgsCompatible(
    candidate: AgyOpenBackgroundCommand,
    liveArgs: Record<string, unknown> | undefined,
    liveCommandLine: string | undefined
): boolean {
    if (
        liveCommandLine !== undefined
        && candidate.commandLine !== undefined
        && candidate.commandLine !== liveCommandLine
    ) {
        return false;
    }
    if (liveArgs && candidate.nativeArgs) {
        for (const [key, val] of Object.entries(liveArgs)) {
            if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
                continue;
            }
            const stored = candidate.nativeArgs[key];
            if (stored !== undefined && stored !== val) {
                return false;
            }
        }
    }
    return true;
}

/**
 * Inspects whether a live ACP background-command update during a subsequent
 * prompt turn uniquely maps to an open synthetic `agy-wakeup-*` command entry,
 * is still ambiguous (requiring `tool_result` output to disambiguate), or does
 * not match any synthetic entry.
 */
export function inspectSyntheticBackgroundCommandMatch(
    brainDir: string,
    sessionId: string,
    openBackgroundCommands: AgyOpenBackgroundCommand[],
    turnStartStepIndex: number,
    lookupOrCommandLine?: string | AgyLiveBackgroundCompletionLookup
): AgySyntheticCommandMatch {
    const candidates = openBackgroundCommands.filter((entry) => entry.synthetic === true);
    if (candidates.length === 0) return { kind: 'none' };

    resolveAgyBackgroundTaskIds(brainDir, sessionId, candidates);

    const lookup: AgyLiveBackgroundCompletionLookup = typeof lookupOrCommandLine === 'string'
        ? { commandLine: lookupOrCommandLine }
        : (lookupOrCommandLine ?? {});
    const liveArgs = lookup.nativeArgs;
    const liveCommandLine = lookup.commandLine
        ?? (typeof liveArgs?.CommandLine === 'string' ? liveArgs.CommandLine : undefined);

    if (lookup.liveCallId) {
        const exactById = candidates.filter((entry) => {
            if (!entry.taskId) return false;
            const shortTask = entry.taskId.includes('/')
                ? entry.taskId.slice(entry.taskId.lastIndexOf('/') + 1)
                : entry.taskId;
            return lookup.liveCallId === entry.taskId || lookup.liveCallId === shortTask;
        });
        if (exactById.length === 1) return { kind: 'matched', entry: exactById[0]! };
    }

    const compatible = candidates.filter((entry) =>
        areCommandArgsCompatible(entry, liveArgs, liveCommandLine)
    );
    if (compatible.length === 0) return { kind: 'none' };

    let earliestStep = turnStartStepIndex;
    for (const entry of compatible) {
        if (entry.stepIndex !== undefined && entry.stepIndex < earliestStep) {
            earliestStep = entry.stepIndex;
        }
    }
    const recentSteps = readAgyTranscriptStepsAfter(brainDir, sessionId, Math.max(-1, earliestStep - 1));
    const completedTasks = new Map<string, { stdout: string; exitCode?: number }>();
    for (const step of recentSteps) {
        if (step.source === 'SYSTEM' && step.type === 'SYSTEM_MESSAGE') {
            const parsed = parseCompletedBackgroundTask(step.content, sessionId);
            if (parsed) {
                const normalized = normalizeAgyCommandBody(parsed.body);
                const exitCode = parsed.exitCode ?? normalized.exitCode;
                completedTasks.set(parsed.taskId, {
                    stdout: normalized.stdout,
                    ...(exitCode !== undefined ? { exitCode } : {})
                });
            }
        }
    }

    const liveResult = lookup.resultOutput !== undefined
        ? parseLiveCommandCompletionResult(lookup.resultOutput)
        : null;
    const hasResultSignal = liveResult !== null || lookup.resultStatus !== undefined;

    const completedCandidates = compatible.filter(
        (entry) => entry.taskId !== undefined && completedTasks.has(entry.taskId)
    );
    const unpersistedCompatible = compatible.filter(
        (entry) => entry.taskId === undefined || !completedTasks.has(entry.taskId)
    );

    const turnPlannedCompatibleCommand = recentSteps.some((step) => {
        if (step.step_index <= turnStartStepIndex) return false;
        if (step.source !== 'MODEL' || step.type !== 'PLANNER_RESPONSE') return false;
        return (step.tool_calls ?? []).some((call) => {
            if (call.name !== 'run_command') return false;
            const args = decodeAgyTranscriptArgs(call.args);
            const plannedCmd = typeof args.CommandLine === 'string' ? args.CommandLine : undefined;
            if (liveCommandLine !== undefined && plannedCmd !== liveCommandLine) return false;
            if (liveArgs) {
                for (const [key, val] of Object.entries(liveArgs)) {
                    if (typeof val !== 'string' && typeof val !== 'number' && typeof val !== 'boolean') {
                        continue;
                    }
                    if (args[key] !== undefined && args[key] !== val) return false;
                }
            }
            return true;
        });
    });

    // Argument compatibility alone never establishes a synthetic alias:
    // without `tool_result` evidence, hold compatible calls provisionally
    // unless the current turn has already persisted a matching planned command
    // with no completed synthetic candidates.
    if (!hasResultSignal) {
        if (
            completedCandidates.length > 0
            || (!turnPlannedCompatibleCommand && unpersistedCompatible.length > 0)
            || lookup.callStatus === 'completed'
            || lookup.callStatus === 'failed'
        ) {
            return { kind: 'ambiguous' };
        }
        return { kind: 'none' };
    }

    if (completedCandidates.length > 0) {
        const filteredByResult = completedCandidates.filter((entry) => {
            const taskResult = completedTasks.get(entry.taskId!)!;
            if (
                liveResult?.exitCode !== undefined
                && taskResult.exitCode !== undefined
                && liveResult.exitCode !== taskResult.exitCode
            ) {
                return false;
            }
            if (lookup.resultStatus === 'failed' && taskResult.exitCode === 0) {
                return false;
            }
            if (
                lookup.resultStatus === 'completed'
                && taskResult.exitCode !== undefined
                && taskResult.exitCode !== 0
            ) {
                return false;
            }
            if (liveResult?.stdout !== undefined && liveResult.stdout !== taskResult.stdout) {
                return false;
            }
            return true;
        });

        if (filteredByResult.length === 1) {
            const established = completedTasks.get(filteredByResult[0]!.taskId!)!;
            if (
                liveResult?.stdout !== undefined
                && (unpersistedCompatible.length === 0 || established.exitCode !== undefined)
            ) {
                return { kind: 'matched', entry: filteredByResult[0]! };
            }
            return { kind: 'ambiguous' };
        }
        if (filteredByResult.length > 1) {
            if (unpersistedCompatible.length === 0 && liveResult?.stdout !== undefined) {
                const first = completedTasks.get(filteredByResult[0]!.taskId!)!;
                const allIdentical = filteredByResult.every((entry) => {
                    const current = completedTasks.get(entry.taskId!)!;
                    return current.stdout === first.stdout && current.exitCode === first.exitCode;
                });
                if (allIdentical) {
                    return { kind: 'matched', entry: filteredByResult[0]! };
                }
            }
            return { kind: 'ambiguous' };
        }
        if (!turnPlannedCompatibleCommand && unpersistedCompatible.length > 0) {
            return { kind: 'ambiguous' };
        }
        return { kind: 'none' };
    }

    if (turnPlannedCompatibleCommand) {
        return { kind: 'none' };
    }
    if (unpersistedCompatible.length > 0) {
        return { kind: 'ambiguous' };
    }
    return { kind: 'none' };
}

/**
 * Matches a live ACP background-command update during a subsequent prompt turn
 * back to an open synthetic `agy-wakeup-*` command entry so the real result
 * replaces the original wakeup placeholder instead of opening a duplicate card.
 */
export function findCompletedSyntheticBackgroundCommand(
    brainDir: string,
    sessionId: string,
    openBackgroundCommands: AgyOpenBackgroundCommand[],
    turnStartStepIndex: number,
    lookupOrCommandLine?: string | AgyLiveBackgroundCompletionLookup
): AgyOpenBackgroundCommand | undefined {
    const match = inspectSyntheticBackgroundCommandMatch(
        brainDir,
        sessionId,
        openBackgroundCommands,
        turnStartStepIndex,
        lookupOrCommandLine
    );
    return match.kind === 'matched' ? match.entry : undefined;
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
    openBackgroundCommands: AgyOpenBackgroundCommand[]
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
            if (completedBg && openBackgroundCommands.length > 0) {
                const matchIdx = openBackgroundCommands.findIndex(
                    (entry) => entry.taskId !== undefined && entry.taskId === completedBg.taskId
                );
                if (matchIdx >= 0) {
                    const matched = openBackgroundCommands.splice(matchIdx, 1)[0]!;
                    const failed = completedBg.exitCode !== undefined && completedBg.exitCode !== 0;
                    messages.push({
                        type: 'tool_result',
                        id: matched.callId,
                        status: failed ? 'failed' : 'completed',
                        output: {
                            output: completedBg.body,
                            ...(completedBg.exitCode !== undefined ? { exit_code: completedBg.exitCode } : {})
                        }
                    });
                }
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
                    const taskId = extractAgyBackgroundTaskId(action.content);
                    const commandLine = typeof decodedArgs.CommandLine === 'string'
                        ? decodedArgs.CommandLine
                        : undefined;
                    openBackgroundCommands.push({
                        callId: id,
                        stepIndex: action.step_index,
                        synthetic: true,
                        nativeArgs: decodedArgs,
                        ...(commandLine !== undefined ? { commandLine } : {}),
                        ...(taskId ? { taskId } : {})
                    });
                }
            }
        }
    }

    const durationMs = firstTimestampMs !== null && lastTimestampMs !== null
        ? Math.max(0, lastTimestampMs - firstTimestampMs)
        : null;

    return { messages, usage, durationMs };
}
