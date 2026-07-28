import { readFile } from 'node:fs/promises';

const DEFAULT_TITLE_WATCH_INTERVAL_MS = 500;

export type KimiSessionTitleWatcher = {
    cleanup: () => Promise<void>;
};

type KimiSessionTitleWatcherOptions = {
    statePath: string;
    onTitle: (title: string) => void;
    intervalMs?: number;
};

/** Polls Kimi's authoritative state.json title, including atomic replacements. */
export async function createKimiSessionTitleWatcher(
    options: KimiSessionTitleWatcherOptions
): Promise<KimiSessionTitleWatcher> {
    const watcher = new KimiSessionTitleWatcherImpl(options);
    await watcher.start();
    return {
        cleanup: async () => {
            await watcher.cleanup();
        }
    };
}

class KimiSessionTitleWatcherImpl {
    private readonly statePath: string;
    private readonly onTitle: KimiSessionTitleWatcherOptions['onTitle'];
    private readonly intervalMs: number;
    private interval: ReturnType<typeof setInterval> | null = null;
    private scanPromise: Promise<void> | null = null;
    private lastTitle: string | null = null;
    private stopped = false;

    constructor(options: KimiSessionTitleWatcherOptions) {
        this.statePath = options.statePath;
        this.onTitle = options.onTitle;
        this.intervalMs = options.intervalMs ?? DEFAULT_TITLE_WATCH_INTERVAL_MS;
    }

    async start(): Promise<void> {
        await this.scan();
        if (this.stopped) {
            return;
        }
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
        this.scanPromise = this.readTitle();
        try {
            await this.scanPromise;
        } finally {
            this.scanPromise = null;
        }
    }

    private async readTitle(): Promise<void> {
        try {
            const raw = await readFile(this.statePath, 'utf8');
            const parsed = JSON.parse(raw) as unknown;
            if (!isRecord(parsed) || typeof parsed.title !== 'string' || parsed.title === this.lastTitle) {
                return;
            }
            this.lastTitle = parsed.title;
            if (!this.stopped) {
                this.onTitle(parsed.title);
            }
        } catch {
            // state.json can be absent or temporarily invalid while Kimi writes it.
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
