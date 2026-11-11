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
import { watch as nodeWatch } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { openAgyStepActivityReader, readAgyStepActivity, type AgyStepActivityReader } from '@/agy/legacyStreamJson/agyConversationModel';
import { AgyTranscriptChunkReader, type AgyTranscriptStep } from '@/agy/legacyStreamJson/agyTranscript';

export type { AgyTranscriptStep };

export const WAKE_WATCHER_DEFAULTS = {
    /** Fallback poll interval at backoff start; doubles up to maxPollMs. */
    pollMs: 2_000,
    maxPollMs: 10_000,
    quietMs: 8_000,
    /** Safety cap for a background task that never reports (~30 min). */
    capMs: 1_800_000
} as const;

/** Read-only view of agy's own records for one session. */
export type AgyTranscriptSource = {
    /** Steps appended to the brain transcript since the previous call. */
    readNewSteps(): Promise<AgyTranscriptStep[]>
    /** Non-destructive transcript scan for steps above a watermark. */
    readStepsSince(sinceIdxExclusive: number): Promise<AgyTranscriptStep[]>
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
        async readStepsSince(sinceIdxExclusive: number): Promise<AgyTranscriptStep[]> {
            // Stateless whole-file read: the window-start backlog scan must not
            // consume the incremental stream the watcher loop feeds on.
            const scanReader = new AgyTranscriptChunkReader(transcriptDir);
            const all = await scanReader.readNew();
            return all.filter((step) => step.idx > sinceIdxExclusive);
        },
        async latestStepIdx(): Promise<number | null> {
            const activity = await readAgyStepActivity(sessionId, -1, join(conversationsDir, `${sessionId}.db`));
            const dbIdx = activity.latestIdx;
            if (dbIdx !== null && (transcriptMaxIdx === null || dbIdx > transcriptMaxIdx)) return dbIdx;
            return transcriptMaxIdx;
        },
        async countPlannerSteps(sinceIdxExclusive: number): Promise<number | null> {
            return (await readAgyStepActivity(sessionId, sinceIdxExclusive, join(conversationsDir, `${sessionId}.db`))).plannerCount;
        },
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
export function parseAgyTaskCompletion(content: string): { exitCode: number; output: string; taskId: string | null } | null {
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
    const taskId = /Task id "([^"]+)"/.exec(content)?.[1] ?? null;
    return { exitCode: Number(exit[1]), output, taskId };
}

const BACKGROUND_TASK_ID = /\btask id:\s*([^\s"]+)/i;
// The description is the record's last field and may span lines (a multiline
// command): capture the remainder, not just the first line.
const BACKGROUND_TASK_DESCRIPTION = /\bTask Description:\s*([\s\S]+)$/;

/**
 * Parses agy's own backgrounding record out of a transcript step: GENERIC tool
 * steps announce "task id: <native id>" with the command text as the task
 * description (multiline commands verbatim), letting a later completion pair
 * with the original ACP call by task id instead of launch order. The quoted
 * `Task id "..."` of a completion message does not match (its id is quoted).
 */
export function parseAgyBackgroundStart(content: string): { taskId: string; description: string } | null {
    const id = BACKGROUND_TASK_ID.exec(content)?.[1];
    if (!id) return null;
    const description = BACKGROUND_TASK_DESCRIPTION.exec(content)?.[1]?.trim() ?? '';
    return { taskId: id, description };
}

export type WakeWatcherOptions = {
    source: AgyTranscriptSource
    /** Surface only steps with idx > baseline (the prompt turn's own steps already went over ACP). */
    baselineIdx: number
    /** Fallback poll interval at backoff start; doubles up to maxPollMs. */
    pollMs?: number
    maxPollMs?: number
    quietMs?: number
    capMs?: number
    /**
     * Resolves before the timeout when agy's records changed (fs.watch on the
     * conversations DB) — resolving `true` for an event wake, `false` for a
     * timeout (fallback poll). Default: plain sleep, i.e. pure backoff
     * polling.
     */
    waitForChange?: (timeoutMs: number) => Promise<boolean>
    /**
     * While true (background completions still unseen) quiet never fires and
     * the watcher stays armed for the slow task; the safety cap bounds one
     * that never reports.
     */
    hasOpenBackgroundCommands?: () => boolean
    onStep?: (step: AgyTranscriptStep) => void
    /** Fires once, when the first step is surfaced. */
    onActivity?: () => void
    /**
     * Consulted for a step the baseline would skip: return true to surface it
     * anyway (a background completion that never went over ACP must surface
     * whenever its transcript line lands). Unconsulted when absent.
     */
    shouldSurfaceLateStep?: (step: AgyTranscriptStep) => boolean
}

/**
 * Watches the transcript/DB while agy's post-end_turn continuation runs and
 * stops on quiet (no new step for quietMs), the safety cap, an explicit stop,
 * or repeated read errors. Reads are event-driven when the conversations DB
 * can be watched (fs.watch) and fall back to a 2s→10s backoff poll otherwise.
 *
 * Lifetime: while background completions are still unseen the watcher stays
 * armed regardless of quiet — a slow task must not end the window — bounded
 * by the safety cap, after which the launcher falls back to the labeled
 * continuation. Once completions are seen (or there are none), quiet ends an
 * active wakeup; with zero surfaced steps quiet counts from the window start
 * (a bounded hold).
 */
export class AgyWakeWatcher {
    private readonly pollMs: number;
    private readonly maxPollMs: number;
    private readonly quietMs: number;
    private readonly capMs: number;
    private readonly waitForChange: (timeoutMs: number) => Promise<boolean>;
    private readonly hasOpenBackgroundCommands: () => boolean;
    private readonly source: AgyTranscriptSource;
    private readonly baselineIdx: number;
    private readonly onStep: (step: AgyTranscriptStep) => void;
    private readonly onActivity: () => void;
    private readonly shouldSurfaceLateStep?: (step: AgyTranscriptStep) => boolean;

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
        this.maxPollMs = opts.maxPollMs ?? WAKE_WATCHER_DEFAULTS.maxPollMs;
        this.quietMs = opts.quietMs ?? WAKE_WATCHER_DEFAULTS.quietMs;
        this.capMs = opts.capMs ?? WAKE_WATCHER_DEFAULTS.capMs;
        this.waitForChange = opts.waitForChange
            ?? ((timeoutMs: number) => new Promise<boolean>((resolve) => setTimeout(() => resolve(false), timeoutMs)));
        this.hasOpenBackgroundCommands = opts.hasOpenBackgroundCommands ?? (() => false);
        this.onStep = opts.onStep ?? (() => {});
        this.onActivity = opts.onActivity ?? (() => {});
        this.shouldSurfaceLateStep = opts.shouldSurfaceLateStep;
    }

    start(): void {
        if (this.loop || this.stopped) return;
        const startedAt = Date.now();
        let backoffMs = this.pollMs;
        this.loop = (async () => {
            while (!this.stopped) {
                try {
                    const steps = await this.source.readNewSteps();
                    let progressed = false;
                    for (const step of steps) {
                        if (step.idx <= this.baselineIdx && !(this.shouldSurfaceLateStep?.(step) ?? false)) continue;
                        // Every post-baseline step counts as brain activity (it
                        // restarts the quiet timer), but only planner/tool/system
                        // steps are surfaced — user_input means agy already moved
                        // to a new prompt, ephemeral entries are its per-round
                        // reminder noise.
                        if (this.latestSeenIdx === null || step.idx > this.latestSeenIdx) this.latestSeenIdx = step.idx;
                        this.lastStepAt = Date.now();
                        progressed = true;
                        if (step.kind === 'user_input' || step.kind === 'ephemeral' || step.kind === 'other') continue;
                        this.surface(step);
                    }
                    this.consecutiveErrors = 0;
                    if (progressed) backoffMs = this.pollMs;
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
                const bgOpen = this.hasOpenBackgroundCommands();
                if (!bgOpen) {
                    // No background completion pending: quiet ends the window —
                    // counted from the last surfaced step or, with zero steps,
                    // from the window start (a bounded hold).
                    const activeAt = this.lastStepAt ?? startedAt;
                    if (now - activeAt >= this.quietMs) {
                        this.finish('quiet');
                        return;
                    }
                }
                // While background completions are unseen the watcher stays
                // armed regardless of quiet; the safety cap bounds a task that
                // never reports.
                if (now - startedAt >= this.capMs) {
                    this.finish('cap');
                    return;
                }
                const woke = await this.waitForChange(backoffMs);
                // Backoff grows over quiet stretches; an event wake (or fresh
                // steps, checked above) restarts the short interval.
                backoffMs = woke ? this.pollMs : Math.min(backoffMs * 2, this.maxPollMs);
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

/**
 * Minimal structural view of `fs.watch`'s return value, so tests can inject a
 * fake and production passes node's FSWatcher.
 */
export type AgyFsWatchHandle = {
    on(event: string, listener: () => void): unknown
    close(): void
};

export type AgyFsWatchFn = (
    dir: string,
    listener: (event: string, filename: string | Buffer | null) => void
) => AgyFsWatchHandle;

/**
 * One fs.watch per conversations directory per CLI process, fanning out to
 * per-session listeners. Watch limits are machine-wide and routinely tight
 * (inotify instances), so acquiring the watch is best effort: any throw or
 * late 'error' (EMFILE/ENOSPC/...) marks the hub failed and every consumer
 * silently falls back to its backoff poll — never a crash, never a blocked
 * turn. The watch closes when the last listener cancels.
 */
class AgyConversationsWatchHub {
    private watcher: AgyFsWatchHandle | null = null;
    private failed = false;
    private readonly listeners = new Map<string, Set<() => void>>();

    constructor(private readonly dir: string, private readonly watchFn: AgyFsWatchFn) {}

    watch(sessionId: string, onChange: () => void): { cancel(): void } {
        this.acquire();
        let set = this.listeners.get(sessionId);
        if (!set) {
            set = new Set();
            this.listeners.set(sessionId, set);
        }
        set.add(onChange);
        return {
            cancel: () => {
                const current = this.listeners.get(sessionId);
                if (!current) return;
                current.delete(onChange);
                if (current.size === 0) this.listeners.delete(sessionId);
                if (this.listeners.size === 0) this.closeWatcher();
            }
        };
    }

    private acquire(): void {
        if (this.watcher || this.failed) return;
        try {
            this.watcher = this.watchFn(this.dir, (_event, filename) => this.onEvent(filename));
            this.watcher.on('error', () => {
                this.closeWatcher();
                this.failed = true;
            });
        } catch {
            this.failed = true;
        }
    }

    private onEvent(filename: string | Buffer | null): void {
        const name = typeof filename === 'string' ? filename : filename?.toString('utf8') ?? null;
        if (!name) return;
        for (const [sessionId, callbacks] of this.listeners) {
            // The session's DB plus its WAL/SHM sidecars share the name prefix.
            if (!name.startsWith(`${sessionId}.db`)) continue;
            for (const onChange of [...callbacks]) onChange();
        }
    }

    private closeWatcher(): void {
        this.watcher?.close();
        this.watcher = null;
    }
}

const watchHubs = new Map<string, AgyConversationsWatchHub>();

function conversationsWatchHub(dir: string, watchFn?: AgyFsWatchFn): AgyConversationsWatchHub {
    let hub = watchHubs.get(dir);
    if (!hub) {
        hub = new AgyConversationsWatchHub(dir, watchFn ?? (nodeWatch as unknown as AgyFsWatchFn));
        watchHubs.set(dir, hub);
    }
    return hub;
}

/**
 * A window-scoped lease over agy's records for one wake window: a persistent
 * readonly connection to the conversations DB (journal_mode=wal, so a
 * readonly reader never blocks agy's writer) for cheap progress probes, and
 * an event wait that resolves as soon as the DB reports a write — fs.watch on
 * the conversations directory, one watcher per process, with the watcher's
 * backoff poll as the standing fallback. Everything closes with the lease.
 */
export type AgyWakeLease = {
    latestStepIdx(): Promise<number | null>
    /** Resolves `true` when the DB reports a write, `false` at the timeout. */
    waitForChange(timeoutMs: number): Promise<boolean>
    close(): void
};

export function createAgyWakeWatch(
    sessionId: string,
    dirs: { conversationsDir?: string } = {},
    opts: { watchFn?: AgyFsWatchFn } = {}
): AgyWakeLease {
    const conversationsDir = dirs.conversationsDir ?? join(AGY_DIR, 'conversations');
    const dbPath = join(conversationsDir, `${sessionId}.db`);
    let dbReader: AgyStepActivityReader | null = null;
    void openAgyStepActivityReader(dbPath)
        .then((reader) => {
            dbReader = reader;
        })
        .catch(() => {});
    const pending = new Set<() => void>();
    const registration = conversationsWatchHub(conversationsDir, opts.watchFn).watch(sessionId, () => {
        for (const release of [...pending]) release();
    });
    return {
        async latestStepIdx(): Promise<number | null> {
            if (dbReader) {
                try {
                    return (await dbReader.read(-1)).latestIdx;
                } catch {
                    // Fall through to the one-shot probe.
                }
            }
            return (await readAgyStepActivity(sessionId, -1, dbPath)).latestIdx;
        },
        waitForChange(timeoutMs: number): Promise<boolean> {
            return new Promise((resolve) => {
                const release = (woke: boolean) => {
                    clearTimeout(timer);
                    pending.delete(releaseWrapper);
                    resolve(woke);
                };
                const releaseWrapper = () => release(true);
                const timer = setTimeout(() => release(false), timeoutMs);
                pending.add(releaseWrapper);
            });
        },
        close(): void {
            registration.cancel();
            dbReader?.close();
            dbReader = null;
            for (const release of [...pending]) release();
        }
    };
}