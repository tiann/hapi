import { logger } from '@/ui/logger';
import type { RemoteLauncherExitReason } from './RemoteLauncherBase';

export interface AcpRecoveryOptions {
    recoveryBackoffsMs?: readonly number[];
    recoveryWindowMs?: number;
    recoveryMaxAttemptsPerWindow?: number;
}

export interface AcpRecoveryHooks {
    onRecoveryStart: () => void;
    onRecoveryHandlersCleared: () => void;
    onRecoveryReady: () => void;
    onRecoverySwitchRequested: () => void;
    isRecoveryAttempt: boolean;
    recoverySignal: AbortSignal;
}

export class AcpRecoveryAttempt {
    private readonly lost = new AbortController();
    private readonly startupSignal: AbortSignal;
    constructor(private readonly recoverySignal?: AbortSignal) {
        this.startupSignal = recoverySignal ? AbortSignal.any([recoverySignal, this.lost.signal]) : this.lost.signal;
    }

    loss: Error | null = null;
    childExited = false;

    /** The first loss closes admission. Later evidence can confirm death without starting another attempt. */
    observeLoss(error: Error, childExited: boolean): boolean {
        const first = this.loss === null;
        if (first || childExited) this.loss = error;
        this.childExited ||= childExited;
        if (first) this.lost.abort(error);
        return first;
    }

    async startup<T>(operation: () => Promise<T>, disposeLate?: (value?: T) => void): Promise<T> {
        if (!this.recoverySignal && !this.canResume) return operation();
        const signal = this.startupSignal;
        signal.throwIfAborted();
        return new Promise<T>((resolve, reject) => {
            const abort = () => reject(signal.reason);
            signal.addEventListener('abort', abort, { once: true });
            Promise.resolve().then(() => {
                signal.throwIfAborted();
                return operation();
            }).then(
                value => {
                    if (signal.aborted) disposeLate?.(value);
                    else resolve(value);
                },
                error => {
                    if (signal.aborted) disposeLate?.();
                    else reject(error);
                }
            ).catch(error => logger.warn('[ACP] Late recovery resource cleanup failed', error))
                .finally(() => signal.removeEventListener('abort', abort));
        });
    }

    canResume = false;
    ready = false;
    markSessionLoaded(): void { this.canResume = true; }
    markReady(): void {
        this.ready = true;
        this.canResume = true;
    }
}

export class AcpRecoveryBatch {
    settled = false;
    constructor(private readonly callbacks: { commit(): void; requeue(): boolean; release(): void }) {}
    commit(): void {
        if (this.settled) return;
        this.settled = true;
        this.callbacks.commit();
    }
    requeue(): void {
        if (!this.settled) this.settled = this.callbacks.requeue();
    }
    finish(recovering: boolean): void {
        if (recovering) this.requeue();
        if (!this.settled) {
            this.settled = true;
            this.callbacks.release();
        }
    }
}

interface RecoveryAdapter {
    readonly queueClosed: AbortSignal;
    create(hooks: AcpRecoveryHooks): {
        launch(): Promise<RemoteLauncherExitReason>;
        readonly shouldRecoverUnexpectedChildExit: boolean;
        readonly hasCompletedPrompt: boolean;
        readonly hasCleanupFailure: boolean;
    };
    installHandlers(cancel: (reason: RemoteLauncherExitReason) => void): void;
    exhausted(cause: Error): Error;
}

export async function runWithAcpChildRecovery(options: AcpRecoveryOptions, adapter: RecoveryAdapter): Promise<RemoteLauncherExitReason> {
    const recoveryBackoffsMs = options.recoveryBackoffsMs ?? [1_000, 5_000, 15_000];
    let recoveryAttempt = 0;
    let recoveryStarted = false;
    let recoveryExitReason: RemoteLauncherExitReason | null = null;
    const recoveryController = new AbortController();
    let lastRecoveryError: unknown = null;
    const attempts: number[] = [];
    const recoveryWindowMs = options.recoveryWindowMs ?? 5 * 60_000;
    const recoveryMaxAttemptsInWindow = options.recoveryMaxAttemptsPerWindow ?? recoveryBackoffsMs.length;

    const cancelRecovery = (reason: RemoteLauncherExitReason) => {
        if (!recoveryStarted || recoveryExitReason) return;
        recoveryExitReason = reason;
        recoveryController.abort();
    };

    const installRecoveryHandlers = () => {
        recoveryStarted = true;
        adapter.installHandlers(cancelRecovery);
    };

    const waitForRecoveryDelay = async (delayMs: number, signal: AbortSignal): Promise<void> => {
        if (signal.aborted) return;
        await new Promise<void>((resolve) => {
            const timer = setTimeout(() => {
                signal.removeEventListener('abort', onAbort);
                resolve();
            }, delayMs);
            const onAbort = () => {
                clearTimeout(timer);
                resolve();
            };
            signal.addEventListener('abort', onAbort, { once: true });
        });
    };

    for (;;) {
        const isRecoveryAttempt = recoveryStarted;
        let recoveryLaunchReady = false;
        const launcher = adapter.create({
            isRecoveryAttempt,
            recoverySignal: recoveryController.signal,
            onRecoveryStart: installRecoveryHandlers,
            onRecoveryHandlersCleared: installRecoveryHandlers,
            onRecoverySwitchRequested: () => cancelRecovery('switch'),
            onRecoveryReady: () => {
                recoveryLaunchReady = true;
                if (isRecoveryAttempt) {
                    // Startup errors after this point are ordinary launcher
                    // errors, not continuation failures of the replacement.
                    // Keep the child-exit counter until a prompt completes so
                    // a repeatedly dying child still reaches its bound.
                    recoveryStarted = false;
                }
            }
        });
        let result: RemoteLauncherExitReason;
        let launchError: unknown = null;
        try {
            result = await launcher.launch();
        } catch (error) {
            launchError = error;
            if (launcher.hasCleanupFailure) {
                throw error;
            }
            result = 'exit';
        }
        if (recoveryExitReason) {
            return recoveryExitReason;
        }
        const needsRecovery = launcher.shouldRecoverUnexpectedChildExit
            || (isRecoveryAttempt && !recoveryLaunchReady && launchError !== null);
        if (!needsRecovery) {
            if (launchError !== null) throw launchError;
            return result;
        }
        installRecoveryHandlers();
        if (launcher.hasCompletedPrompt) {
            recoveryAttempt = 0;
            lastRecoveryError = null;
        }
        if (launchError !== null) lastRecoveryError = launchError;
        const queueClosed = adapter.queueClosed;
        if (queueClosed.aborted) return 'exit';
        const now = performance.now();
        while (attempts.length && now - attempts[0]! >= recoveryWindowMs) attempts.shift();
        if (recoveryAttempt >= recoveryBackoffsMs.length || attempts.length >= recoveryMaxAttemptsInWindow) {
            const error = lastRecoveryError instanceof Error
                ? lastRecoveryError
                : new Error('ACP child exited repeatedly');
            throw adapter.exhausted(error);
        }
        const delayMs = recoveryBackoffsMs[recoveryAttempt++]!;
        await waitForRecoveryDelay(delayMs, AbortSignal.any([recoveryController.signal, queueClosed]));
        if (recoveryExitReason) {
            return recoveryExitReason;
        }
        if (queueClosed.aborted) return 'exit';
        attempts.push(performance.now());
    }
}
