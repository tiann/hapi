import { statSync, watch, type FSWatcher } from 'node:fs';
import { logger } from '@/ui/logger';

export function startFileWatcher(file: string, onFileChange: (file: string) => void, onHealth?: (healthy: boolean) => void) {
    let watcher: FSWatcher | null = null;
    let retry: ReturnType<typeof setTimeout> | undefined;
    let backoffMs = 1_000;
    let identity: { dev: bigint; ino: bigint } | undefined;
    let attachedAt = 0;
    let stopped = false;

    const restart = () => {
        const previous = watcher;
        watcher = null;
        previous?.close();
        if (stopped || retry) return;
        if (previous && performance.now() - attachedAt >= 30_000) backoffMs = 1_000;
        onHealth?.(false);
        retry = setTimeout(() => {
            retry = undefined;
            attach();
        }, backoffMs);
        backoffMs = Math.min(30_000, backoffMs * 2);
    };

    const verifyIdentity = () => {
        if (!watcher || !identity) return;
        try {
            const current = statSync(file, { bigint: true });
            if (current.dev === identity.dev && current.ino === identity.ino) return;
        } catch {
        }
        restart();
    };

    const attach = () => {
        try {
            identity = statSync(file, { bigint: true });
            const current = watch(file, (event) => {
                if (watcher !== current) return;
                backoffMs = 1_000;
                if (event === 'rename') restart();
                else verifyIdentity();
                onFileChange(file);
            });
            watcher = current;
            attachedAt = performance.now();
            current.once('error', () => { if (watcher === current) restart(); });
            current.once('close', () => { if (watcher === current) restart(); });
            onHealth?.(true);
        } catch (error) {
            logger.debug(`[FILE_WATCHER] Could not watch ${file}, retrying in ${backoffMs} ms: ${error}`);
            restart();
        }
    };

    attach();
    return Object.assign(() => {
        stopped = true;
        clearTimeout(retry);
        const current = watcher;
        watcher = null;
        current?.close();
    }, { verifyIdentity });
}
