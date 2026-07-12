import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { open, readdir, stat } from 'node:fs/promises';
import { logger } from '@/ui/logger';
import { convertCodexEvent, type CodexSessionEvent } from './codexEventConverter';

export type LocatedCodexTranscript = {
    sessionId: string;
    transcriptPath: string;
};

export type CodexTranscriptLocator = {
    ready: Promise<void>;
    cleanup: () => Promise<void>;
};

type TranscriptState = {
    offset: number;
    size: number;
    mtimeMs: number;
    ino: number;
    sessionId: string | null;
    cwd: string | null;
};

type CodexTranscriptLocatorOptions = {
    cwd: string;
    startupTimestampMs: number;
    resumeSessionId?: string | null;
    intervalMs?: number;
    settlementMs?: number;
    onLocated: (located: LocatedCodexTranscript) => void;
    onAmbiguous?: (paths: string[]) => void;
};

const DEFAULT_LOCATOR_INTERVAL_MS = 500;

export function createCodexTranscriptLocator(options: CodexTranscriptLocatorOptions): CodexTranscriptLocator {
    const locator = new CodexTranscriptLocatorImpl(options);
    const ready = locator.start().catch((error) => {
        logger.debug('[codex-transcript-locator] Failed to initialize transcript fallback', error);
    });
    return {
        ready,
        cleanup: async () => {
            await locator.cleanup();
            await ready;
        }
    };
}

class CodexTranscriptLocatorImpl {
    private readonly sessionsRoot: string;
    private readonly targetCwd: string;
    private readonly startupTimestampMs: number;
    private readonly resumeSessionId: string | null;
    private readonly intervalMs: number;
    private readonly settlementMs: number;
    private readonly onLocated: CodexTranscriptLocatorOptions['onLocated'];
    private readonly onAmbiguous?: CodexTranscriptLocatorOptions['onAmbiguous'];
    private readonly states = new Map<string, TranscriptState>();
    private readonly initialFreshPaths = new Set<string>();
    private readonly pendingCandidates = new Map<string, LocatedCodexTranscript>();
    private resumeTranscriptPaths: string[] | null = null;
    private firstCandidateTimestampMs: number | null = null;
    private interval: ReturnType<typeof setInterval> | null = null;
    private scanPromise: Promise<void> | null = null;
    private stopped = false;

    constructor(options: CodexTranscriptLocatorOptions) {
        const codexHome = process.env.CODEX_HOME || join(homedir(), '.codex');
        this.sessionsRoot = join(codexHome, 'sessions');
        this.targetCwd = normalizePath(options.cwd);
        this.startupTimestampMs = options.startupTimestampMs;
        this.resumeSessionId = options.resumeSessionId ?? null;
        this.intervalMs = options.intervalMs ?? DEFAULT_LOCATOR_INTERVAL_MS;
        this.settlementMs = options.settlementMs ?? this.intervalMs;
        this.onLocated = options.onLocated;
        this.onAmbiguous = options.onAmbiguous;
    }

    async start(): Promise<void> {
        if (!this.resumeSessionId) {
            const existingPaths = await this.listNearbyTranscriptFiles();
            for (const transcriptPath of existingPaths) {
                this.initialFreshPaths.add(transcriptPath);
            }
        }
        if (this.stopped) return;

        void this.scan();
        this.interval = setInterval(() => void this.scan(), this.intervalMs);
        this.interval.unref?.();
    }

    async cleanup(): Promise<void> {
        this.stopped = true;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
        await this.scanPromise?.catch(() => {});
    }

    private async scan(): Promise<void> {
        if (this.stopped || this.scanPromise) {
            return this.scanPromise ?? Promise.resolve();
        }

        this.scanPromise = this.runScan();
        try {
            await this.scanPromise;
        } finally {
            this.scanPromise = null;
        }
    }

    private async runScan(): Promise<void> {
        const files = await this.listCandidateFiles();
        for (const transcriptPath of files) {
            if (this.stopped) return;
            const candidate = await this.scanFile(transcriptPath);
            if (candidate) {
                this.pendingCandidates.set(candidate.transcriptPath, candidate);
            }
        }

        if (this.stopped || this.pendingCandidates.size === 0) {
            return;
        }

        if (this.pendingCandidates.size > 1) {
            const paths = [...this.pendingCandidates.keys()];
            logger.warn('[codex-transcript-locator] Ambiguous Codex transcript activity; refusing fallback attachment', paths);
            this.stopPolling();
            this.onAmbiguous?.(paths);
            return;
        }

        const [located] = this.pendingCandidates.values();
        if (!located) return;

        if (!this.resumeSessionId) {
            if (this.firstCandidateTimestampMs === null) {
                this.firstCandidateTimestampMs = Date.now();
            }
            if (Date.now() - this.firstCandidateTimestampMs < this.settlementMs) {
                return;
            }
        }

        logger.debug(`[codex-transcript-locator] Located ${located.sessionId} at ${located.transcriptPath}`);
        this.stopPolling();
        this.onLocated(located);
    }

    private async scanFile(transcriptPath: string): Promise<LocatedCodexTranscript | null> {
        let fileStats: Awaited<ReturnType<typeof stat>>;
        try {
            fileStats = await stat(transcriptPath);
        } catch {
            return null;
        }
        if (!fileStats.isFile()) return null;

        const previous = this.states.get(transcriptPath);
        let state: TranscriptState = previous ?? {
            offset: 0,
            size: 0,
            mtimeMs: 0,
            ino: fileStats.ino,
            sessionId: null,
            cwd: null
        };

        const replaced = previous && previous.ino !== fileStats.ino;
        const truncated = previous && fileStats.size < previous.offset;
        const rewrittenAtSameSize = previous
            && fileStats.size === previous.size
            && fileStats.mtimeMs !== previous.mtimeMs
            && previous.offset === previous.size;
        if (replaced || truncated || rewrittenAtSameSize) {
            state = {
                offset: 0,
                size: 0,
                mtimeMs: 0,
                ino: fileStats.ino,
                sessionId: null,
                cwd: null
            };
        } else if (previous
            && fileStats.size === previous.size
            && fileStats.mtimeMs === previous.mtimeMs) {
            return null;
        }

        if (fileStats.size <= state.offset) {
            state.size = fileStats.size;
            state.mtimeMs = fileStats.mtimeMs;
            state.ino = fileStats.ino;
            this.states.set(transcriptPath, state);
            return null;
        }

        let content: Buffer;
        try {
            content = await readBytes(transcriptPath, state.offset, fileStats.size - state.offset);
        } catch {
            return null;
        }

        const startOffset = state.offset;
        const text = content.toString('utf8');
        const lines = text.split('\n');
        let consumedBytes = 0;
        let sawFreshUserActivity = false;

        for (let index = 0; index < lines.length; index += 1) {
            const line = lines[index] ?? '';
            const terminated = index < lines.length - 1;
            const recordBytes = Buffer.byteLength(line) + (terminated ? 1 : 0);

            if (!line.trim()) {
                if (terminated) consumedBytes += recordBytes;
                continue;
            }

            let event: CodexSessionEvent;
            try {
                event = JSON.parse(line) as CodexSessionEvent;
            } catch {
                if (terminated) consumedBytes += recordBytes;
                continue;
            }

            if (event.type === 'session_meta') {
                const metadata = asRecord(event.payload);
                state.sessionId = asString(metadata?.id) ?? state.sessionId;
                const eventCwd = asString(metadata?.cwd);
                state.cwd = eventCwd ? normalizePath(eventCwd) : state.cwd;
            }

            if (convertCodexEvent(event)?.userActivity) {
                const eventTimestamp = parseTimestamp(event.timestamp);
                if (eventTimestamp !== null && eventTimestamp >= this.startupTimestampMs) {
                    sawFreshUserActivity = true;
                }
            }

            consumedBytes += recordBytes;
        }

        state.offset = startOffset + consumedBytes;
        state.size = startOffset + content.length;
        state.mtimeMs = fileStats.mtimeMs;
        state.ino = fileStats.ino;
        this.states.set(transcriptPath, state);

        if (!sawFreshUserActivity || !state.sessionId) {
            return null;
        }
        if (this.resumeSessionId) {
            if (state.sessionId !== this.resumeSessionId) {
                return null;
            }
        } else if (state.cwd !== this.targetCwd) {
            return null;
        }

        return { sessionId: state.sessionId, transcriptPath };
    }

    private async listCandidateFiles(): Promise<string[]> {
        if (this.resumeSessionId) {
            if (this.resumeTranscriptPaths) {
                return this.resumeTranscriptPaths;
            }
            const suffix = `-${this.resumeSessionId}.jsonl`;
            const matches = await listJsonlFiles(this.sessionsRoot, (name) => name.endsWith(suffix));
            if (matches.length > 0) {
                this.resumeTranscriptPaths = matches;
            }
            return matches;
        }

        const files = await this.listNearbyTranscriptFiles();
        return files.filter((transcriptPath) => !this.initialFreshPaths.has(transcriptPath));
    }

    private async listNearbyTranscriptFiles(): Promise<string[]> {
        const roots = getNearbyDateRoots(this.sessionsRoot, this.startupTimestampMs);
        const groups = await Promise.all(roots.map((root) => listJsonlFiles(root)));
        return groups.flat();
    }

    private stopPolling(): void {
        this.stopped = true;
        if (this.interval) {
            clearInterval(this.interval);
            this.interval = null;
        }
    }
}

async function readBytes(filePath: string, offset: number, length: number): Promise<Buffer> {
    const handle = await open(filePath, 'r');
    try {
        const buffer = Buffer.alloc(length);
        let totalBytesRead = 0;
        while (totalBytesRead < length) {
            const { bytesRead } = await handle.read(
                buffer,
                totalBytesRead,
                length - totalBytesRead,
                offset + totalBytesRead
            );
            if (bytesRead === 0) break;
            totalBytesRead += bytesRead;
        }
        return buffer.subarray(0, totalBytesRead);
    } finally {
        await handle.close();
    }
}

async function listJsonlFiles(
    directory: string,
    matchesName: (name: string) => boolean = () => true
): Promise<string[]> {
    try {
        const entries = await readdir(directory, { withFileTypes: true });
        const groups = await Promise.all(entries.map(async (entry) => {
            const fullPath = join(directory, entry.name);
            if (entry.isDirectory()) {
                return await listJsonlFiles(fullPath, matchesName);
            }
            return entry.isFile() && entry.name.endsWith('.jsonl') && matchesName(entry.name)
                ? [fullPath]
                : [];
        }));
        return groups.flat();
    } catch {
        return [];
    }
}

function getNearbyDateRoots(sessionsRoot: string, timestampMs: number): string[] {
    const roots: string[] = [];
    for (const offsetDays of [-1, 0, 1]) {
        const date = new Date(timestampMs + offsetDays * 24 * 60 * 60 * 1000);
        roots.push(join(
            sessionsRoot,
            String(date.getUTCFullYear()),
            String(date.getUTCMonth() + 1).padStart(2, '0'),
            String(date.getUTCDate()).padStart(2, '0')
        ));
    }
    return roots;
}

function asRecord(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
        ? value as Record<string, unknown>
        : null;
}

function asString(value: unknown): string | null {
    return typeof value === 'string' && value.length > 0 ? value : null;
}

function parseTimestamp(value: unknown): number | null {
    if (typeof value !== 'string') return null;
    const parsed = Date.parse(value);
    return Number.isNaN(parsed) ? null : parsed;
}

function normalizePath(value: string): string {
    const normalized = resolve(value);
    return process.platform === 'win32' ? normalized.toLowerCase() : normalized;
}
