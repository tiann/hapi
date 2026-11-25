import { InvalidateSync } from "@/utils/sync";
import { startFileWatcher } from "@/modules/watcher/startFileWatcher";

export type SessionFileScanEntry<TEvent> = {
    event: TEvent;
    lineIndex?: number;
};

export type SessionFileScanResult<TEvent> = {
    events: SessionFileScanEntry<TEvent>[];
    nextCursor: number;
};

export type SessionFileScanStats<TEvent> = {
    filePath: string;
    events: TEvent[];
    parsedCount: number;
    newCount: number;
    skippedCount: number;
    cursor: number;
    nextCursor: number;
};

type BaseSessionScannerOptions = {
    intervalMs: number;
};

export abstract class BaseSessionScanner<TEvent> {
    private readonly sync: InvalidateSync;
    private readonly watchers = new Map<string, ReturnType<typeof startFileWatcher>>();
    private readonly healthyWatchers = new Set<string>();
    private pollMs = 0;
    private allFilesSelected = false;
    private readonly processedEventKeys = new Set<string>();
    private readonly fileCursors = new Map<string, number>();
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private trailingScan: ReturnType<typeof setTimeout> | undefined;
    private cleanupPromise: Promise<void> | null = null;
    private scanPromise: Promise<void> | null = null;

    protected constructor(private readonly options: BaseSessionScannerOptions) {
        this.sync = new InvalidateSync(() => this.scan());
    }

    protected abstract findSessionFiles(): Promise<string[]>;
    protected abstract parseSessionFile(filePath: string, cursor: number): Promise<SessionFileScanResult<TEvent>>;
    protected abstract generateEventKey(event: TEvent, context: { filePath: string; lineIndex?: number }): string;

    protected async handleFileScan(_stats: SessionFileScanStats<TEvent>): Promise<void> {
    }

    protected async initialize(): Promise<void> {
    }

    protected async beforeScan(): Promise<void> {
    }

    protected async afterScan(): Promise<void> {
    }

    protected shouldScan(): boolean {
        return true;
    }

    protected shouldWatchFile?(filePath: string): boolean;

    private onFileChange = (): void => {
        if (this.cleanupPromise) return;
        this.sync.invalidate();
        if (this.pollMs <= this.options.intervalMs) return;
        clearTimeout(this.trailingScan);
        this.trailingScan = setTimeout(() => this.sync.invalidate(), this.options.intervalMs);
    };

    protected ensureWatcher(filePath: string): void {
        if (this.cleanupPromise || this.watchers.has(filePath)) {
            return;
        }
        this.watchers.set(filePath, startFileWatcher(filePath, this.onFileChange, (healthy) => {
            if (healthy) {
                this.healthyWatchers.add(filePath);
                if (this.watchers.has(filePath)) this.invalidate();
            } else {
                this.healthyWatchers.delete(filePath);
            }
            if (this.watchers.has(filePath) && this.pollMs) this.updatePoll();
        }));
        if (this.pollMs) this.updatePoll();
    }

    protected invalidate(): void {
        this.sync.invalidate();
    }

    protected getCursor(filePath: string): number {
        return this.fileCursors.get(filePath) ?? 0;
    }

    protected setCursor(filePath: string, cursor: number): void {
        this.fileCursors.set(filePath, cursor);
    }

    protected seedProcessedKeys(keys: Iterable<string>): void {
        for (const key of keys) {
            this.recordProcessedKey(key);
        }
    }

    protected getWatchedFiles(): string[] {
        return [...this.watchers.keys()];
    }

    protected pruneWatchers(keepFiles: Iterable<string>): void {
        const keep = new Set(keepFiles);
        for (const [filePath, stop] of this.watchers.entries()) {
            if (keep.has(filePath)) {
                continue;
            }
            stop();
            this.watchers.delete(filePath);
            this.healthyWatchers.delete(filePath);
        }
        if (this.pollMs) this.updatePoll();
    }

    public async start(): Promise<void> {
        await this.initialize();
        await this.sync.invalidateAndAwait();
        this.updatePoll();
    }

    private updatePoll(): void {
        if (this.cleanupPromise) return;
        const healthy = this.allFilesSelected && this.watchers.size > 0 && this.healthyWatchers.size === this.watchers.size;
        const intervalMs = healthy ? Math.max(30_000, this.options.intervalMs) : this.options.intervalMs;
        if (this.pollMs === intervalMs) return;
        this.pollMs = intervalMs;
        if (this.intervalId) clearInterval(this.intervalId);
        this.intervalId = setInterval(() => {
            if (healthy) for (const watcher of this.watchers.values()) watcher.verifyIdentity();
            this.sync.invalidate();
        }, intervalMs);
    }

    public async flush(): Promise<void> {
        if (this.cleanupPromise) return this.cleanupPromise;
        await this.sync.invalidateAndAwait();
    }

    public cleanup(): Promise<void> {
        return this.cleanupPromise ??= this.drain();
    }

    private async drain(): Promise<void> {
        this.sync.stop();
        clearTimeout(this.trailingScan);
        if (this.intervalId) clearInterval(this.intervalId);
        for (const stop of this.watchers.values()) {
            stop();
        }
        try {
            await this.scanPromise?.catch(() => {});
            await this.runScan();
        } finally {
            this.watchers.clear();
            this.healthyWatchers.clear();
        }
    }

    private async scan(): Promise<void> {
        if (!this.shouldScan()) {
            return;
        }
        if (this.scanPromise) {
            return this.scanPromise;
        }
        this.scanPromise = this.runScan();
        try {
            await this.scanPromise;
        } finally {
            this.scanPromise = null;
        }
    }

    private async runScan(): Promise<void> {
        if (!this.shouldScan()) {
            return;
        }
        await this.beforeScan();
        const files = await this.findSessionFiles();
        this.allFilesSelected = files.length > 0 && files.every(path => this.shouldWatchFile?.(path) === true);
        if (this.pollMs) this.updatePoll();
        for (const filePath of files) {
            if (!this.shouldScan()) {
                return;
            }
            if (this.shouldWatchFile?.(filePath) ?? true) {
                this.ensureWatcher(filePath);
            }
            const cursor = this.getCursor(filePath);
            const { events, nextCursor } = await this.parseSessionFile(filePath, cursor);
            const newEvents: TEvent[] = [];
            const newKeys: string[] = [];
            for (const entry of events) {
                const key = this.generateEventKey(entry.event, { filePath, lineIndex: entry.lineIndex });
                if (this.processedEventKeys.has(key)) {
                    this.recordProcessedKey(key);
                    continue;
                }
                newKeys.push(key);
                newEvents.push(entry.event);
            }
            await this.handleFileScan({
                filePath,
                events: newEvents,
                parsedCount: events.length,
                newCount: newEvents.length,
                skippedCount: events.length - newEvents.length,
                cursor,
                nextCursor
            });
            this.setCursor(filePath, nextCursor);
            for (const key of newKeys) {
                this.recordProcessedKey(key);
            }
        }
        await this.afterScan();
    }

    private recordProcessedKey(key: string): void {
        this.processedEventKeys.add(key);
    }
}
