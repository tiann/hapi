/**
 * Late-continuation watcher for agy ACP sessions.
 *
 * Workaround for google-antigravity/antigravity-cli#1461 (root cause analysis
 * in google-antigravity/antigravity-cli#1484): when an agy turn ends with a command moved to the background, the
 * harness-mandated end_turn closes the ACP stream fence, and the "reactive
 * wakeup" that runs once the background task finishes is written to agy's
 * conversation DB and brain transcript but never emitted as `session/update`
 * frames — the steps sit silently until the next `session/prompt` (or vanish
 * on a worker restart). While that stands, this watcher polls agy's own
 * records and hands new steps to the launcher so the user sees the wakeup
 * live. Delete this module when agy delivers idle-period updates again.
 *
 * Two sources, split by what each is good at:
 * - `conversations/<sessionId>.db` (plain columns): the newest step idx and
 *   the PLANNER_RESPONSE count. The step content there is protobuf, so it is
 *   NOT read for text.
 * - `brain/<sessionId>/.system_generated/logs/chunks/transcript_full/*.jsonl`:
 *   the step content (text, tool calls), keyed by the same step idx.
 *
 * The model-call count also feeds the round footer's turn count
 * (google-antigravity/antigravity-cli#1045: agy ACP reports no num_turns).
 */
import { homedir } from 'node:os';
import { join } from 'node:path';
import { readAgyStepActivity } from '@/agy/legacyStreamJson/agyConversationModel';
import { AgyTranscriptChunkReader, type AgyTranscriptStep } from '@/agy/legacyStreamJson/agyTranscript';

export const WAKE_WATCHER_DEFAULTS = {
    pollMs: 1_000,
    quietMs: 10_000,
    capMs: 180_000,
    advanceMs: 3_000
} as const;

/** Read-only view of agy's own records for one session. */
export type AgyTranscriptSource = {
    /** Steps appended to the brain transcript since the previous call. */
    readNewSteps(): Promise<AgyTranscriptStep[]>
    /** Newest conversation step idx (DB first, transcript fallback). */
    latestStepIdx(): Promise<number | null>
    /** PLANNER_RESPONSE count above the watermark (google-antigravity/antigravity-cli#1045 model-call count). */
    countPlannerSteps(sinceIdxExclusive: number): Promise<number | null>
}

const AGY_DIR = join(homedir(), '.gemini', 'antigravity-cli');

export function createAgyTranscriptSource(
    sessionId: string,
    dirs: { conversationsDir?: string; brainDir?: string } = {}
): AgyTranscriptSource {
    const conversationsDir = dirs.conversationsDir ?? join(AGY_DIR, 'conversations');
    const brainDir = dirs.brainDir ?? join(AGY_DIR, 'brain');
    const transcriptDir = join(brainDir, sessionId, '.system_generated', 'logs', 'chunks', 'transcript_full');
    const reader = new AgyTranscriptChunkReader(transcriptDir);
    let transcriptMaxIdx: number | null = null;

    return {
        async readNewSteps(): Promise<AgyTranscriptStep[]> {
            const steps = await reader.readNew();
            for (const step of steps) {
                if (transcriptMaxIdx === null || step.idx > transcriptMaxIdx) transcriptMaxIdx = step.idx;
            }
            return steps;
        },
        async latestStepIdx(): Promise<number | null> {
            const activity = await readAgyStepActivity(sessionId, -1, join(conversationsDir, `${sessionId}.db`));
            const dbIdx = activity.latestIdx;
            if (dbIdx !== null && (transcriptMaxIdx === null || dbIdx > transcriptMaxIdx)) return dbIdx;
            return transcriptMaxIdx;
        },
        async countPlannerSteps(sinceIdxExclusive: number): Promise<number | null> {
            return (await readAgyStepActivity(sessionId, sinceIdxExclusive, join(conversationsDir, `${sessionId}.db`))).plannerCount;
        }
    };
}

export type WakeWatcherCloseReason = 'quiet' | 'cap' | 'next-prompt' | 'disabled' | 'error';

export type WakeWatcherClose = {
    reason: WakeWatcherCloseReason
    /** Highest step idx handed to onStep. */
    surfacedThroughIdx: number | null
    /** Highest step idx known from any source at close time. */
    latestSeenIdx: number | null
    /** True when quiet close saw every step the sources know about. */
    surfacedFully: boolean
    /** Number of steps handed to onStep. */
    steps: number
}

/**
 * Parses a background-task completion out of agy's wakeup SYSTEM_MESSAGE body:
 *
 *   [Message] timestamp=... sender=<session>/task-3 priority=... content=Task id "<session>/task-3" finished with result:
 *   Command exited with code 0.
 *
 *   Command output:
 *   BG-DONE-7731
 */
export function parseAgyTaskCompletion(content: string): { exitCode: number; output: string } | null {
    const marker = 'finished with result:';
    const markerAt = content.indexOf(marker);
    if (markerAt < 0) return null;
    const body = content.slice(markerAt + marker.length);
    const exit = /Command exited with code (-?\d+)/.exec(body);
    if (!exit) return null;
    const outputMarker = 'Command output:';
    const outputAt = body.indexOf(outputMarker);
    let output = '';
    if (outputAt >= 0) {
        output = body.slice(outputAt + outputMarker.length).trim();
        // Trailing agy metadata ("Log: ..." line, closing tag) is not output.
        output = output.replace(/\n?Log: [^\n]*/, '').replace(/\n?<\/SYSTEM_MESSAGE>\s*$/, '').trim();
    }
    return { exitCode: Number(exit[1]), output };
}

export type WakeWatcherOptions = {
    source: AgyTranscriptSource
    /** Surface only steps with idx > baseline (the prompt turn's own steps already went over ACP). */
    baselineIdx: number
    pollMs?: number
    quietMs?: number
    capMs?: number
    advanceMs?: number
    onStep?: (step: AgyTranscriptStep) => void
    /** Fires once, when the first step is surfaced. */
    onActivity?: () => void
}

/**
 * Polls the transcript/DB while agy's post-end_turn continuation runs and
 * stops on quiet (no new step for quietMs), the cap, an explicit stop, or
 * repeated read errors. Quiet requires at least one surfaced step: while the
 * background task has not finished, the watcher keeps polling (bounded by the
 * cap) because the wakeup is still expected.
 */
export class AgyWakeWatcher {
    private readonly pollMs: number;
    private readonly quietMs: number;
    private readonly capMs: number;
    private readonly advanceMs: number;
    private readonly source: AgyTranscriptSource;
    private readonly baselineIdx: number;
    private readonly onStep: (step: AgyTranscriptStep) => void;
    private readonly onActivity: () => void;

    private loop: Promise<void> | null = null;
    private stopped = false;
    private close: WakeWatcherClose | null = null;
    private readonly waiters: Array<(close: WakeWatcherClose) => void> = [];
    private lastStepAt: number | null = null;
    private surfacedThroughIdx: number | null = null;
    private latestSeenIdx: number | null = null;
    private surfaced = 0;
    private activityFired = false;
    private consecutiveErrors = 0;

    constructor(opts: WakeWatcherOptions) {
        this.source = opts.source;
        this.baselineIdx = opts.baselineIdx;
        this.pollMs = opts.pollMs ?? WAKE_WATCHER_DEFAULTS.pollMs;
        this.quietMs = opts.quietMs ?? WAKE_WATCHER_DEFAULTS.quietMs;
        this.capMs = opts.capMs ?? WAKE_WATCHER_DEFAULTS.capMs;
        this.advanceMs = opts.advanceMs ?? WAKE_WATCHER_DEFAULTS.advanceMs;
        this.onStep = opts.onStep ?? (() => {});
        this.onActivity = opts.onActivity ?? (() => {});
    }

    start(): void {
        if (this.loop || this.stopped) return;
        const startedAt = Date.now();
        this.loop = (async () => {
            while (!this.stopped) {
                try {
                    const steps = await this.source.readNewSteps();
                    for (const step of steps) {
                        if (step.idx <= this.baselineIdx) continue;
                        // Every post-baseline step counts as brain activity (it
                        // restarts the quiet timer), but only planner/tool/system
                        // steps are surfaced — user_input means agy already moved
                        // to a new prompt, ephemeral entries are its per-round
                        // reminder noise.
                        if (this.latestSeenIdx === null || step.idx > this.latestSeenIdx) this.latestSeenIdx = step.idx;
                        this.lastStepAt = Date.now();
                        if (step.kind === 'user_input' || step.kind === 'ephemeral' || step.kind === 'other') continue;
                        this.surface(step);
                    }
                    this.consecutiveErrors = 0;
                } catch {
                    // A transient read error (file rotation, sqlite lock) is not
                    // fatal; give up only after several polls in a row.
                    this.consecutiveErrors += 1;
                    if (this.consecutiveErrors >= 5) {
                        this.finish('error');
                        return;
                    }
                }
                const dbLatest = await this.source.latestStepIdx().catch(() => null);
                if (dbLatest !== null && (this.latestSeenIdx === null || dbLatest > this.latestSeenIdx)) {
                    this.latestSeenIdx = dbLatest;
                }
                const now = Date.now();
                if (this.lastStepAt !== null && now - this.lastStepAt >= this.quietMs) {
                    this.finish('quiet');
                    return;
                }
                if (now - startedAt >= this.capMs) {
                    this.finish('cap');
                    return;
                }
                await new Promise((resolve) => setTimeout(resolve, this.pollMs));
            }
        })();
    }

    private surface(step: AgyTranscriptStep): void {
        if (!this.activityFired) {
            this.activityFired = true;
            this.onActivity();
        }
        this.surfacedThroughIdx = step.idx;
        this.surfaced += 1;
        this.onStep(step);
    }

    private finish(reason: WakeWatcherCloseReason): WakeWatcherClose {
        if (this.close) return this.close;
        this.stopped = true;
        this.close = {
            reason,
            surfacedThroughIdx: this.surfacedThroughIdx,
            latestSeenIdx: this.latestSeenIdx,
            surfacedFully: this.surfacedThroughIdx !== null
                && this.latestSeenIdx !== null
                && this.surfacedThroughIdx >= this.latestSeenIdx,
            steps: this.surfaced
        };
        for (const waiter of this.waiters.splice(0)) waiter(this.close);
        return this.close;
    }

    /** True when a step was surfaced within the last `advanceMs`. */
    isAdvancing(): boolean {
        return this.lastStepAt !== null && Date.now() - this.lastStepAt < this.advanceMs;
    }

    /**
     * Resolves when the watcher closes: quiet or cap on its own, or early via
     * stop()/abort (reported as `next-prompt`). Resolves immediately once closed.
     */
    waitForSettle(signal?: AbortSignal): Promise<WakeWatcherClose> {
        if (this.close) return Promise.resolve(this.close);
        return new Promise<WakeWatcherClose>((resolve) => {
            const onAbort = () => {
                signal?.removeEventListener('abort', onAbort);
                resolve(this.stop('next-prompt'));
            };
            if (signal) {
                if (signal.aborted) {
                    resolve(this.stop('next-prompt'));
                    return;
                }
                signal.addEventListener('abort', onAbort, { once: true });
            }
            this.waiters.push((close) => {
                signal?.removeEventListener('abort', onAbort);
                resolve(close);
            });
        });
    }

    /** Closes the watcher early; idempotent, returns the close record. */
    stop(reason: 'next-prompt' | 'disabled'): Promise<WakeWatcherClose> {
        return Promise.resolve(this.finish(reason));
    }
}