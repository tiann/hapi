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
    onRecoveryStartupFailure: () => void;
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

export class MissingAcpWriterCapture extends Error {
    constructor(readonly finishSession: () => Promise<void>) {
        super('The previous ACP writer was not captured');
    }
}

export class UnverifiedAcpWriter extends Error {
    constructor(
        message: string,
        readonly switchRequested: boolean,
        readonly verify: () => Promise<boolean>,
        readonly notifyParked: () => void
    ) { super(message); }
}

interface RecoveryAdapter {
    readonly queueClosed: AbortSignal;
    readonly sessionExit: AbortSignal;
    hasInput(): boolean;
    waitForInput(signal: AbortSignal): Promise<boolean>;
    create(hooks: AcpRecoveryHooks): {
        launch(): Promise<RemoteLauncherExitReason>;
        readonly shouldRecoverUnexpectedChildExit: boolean;
        readonly hasCompletedPrompt: boolean;
        readonly hasCleanupFailure: boolean;
        readonly startsNewConversation?: boolean;
    };
    installHandlers(stop: () => void): void;
    exhausted(cause: Error): Error;
}

export async function runWithAcpChildRecovery(options: AcpRecoveryOptions, adapter: RecoveryAdapter): Promise<RemoteLauncherExitReason> {
    const recoveryBackoffsMs = options.recoveryBackoffsMs ?? [1_000, 5_000, 15_000];
    let recoveryAttempt = 0;
    let recoveryStarted = false;
    let recoveryController = new AbortController();
    let stopped = false;
    let lastRecoveryError: unknown = null;
    const attempts: number[] = [];
    const recoveryWindowMs = options.recoveryWindowMs ?? 5 * 60_000;
    const recoveryMaxAttemptsInWindow = options.recoveryMaxAttemptsPerWindow ?? recoveryBackoffsMs.length;

    const stopRecovery = () => {
        if (!recoveryStarted) return;
        stopped = true;
        recoveryController.abort();
    };

    const installRecoveryHandlers = () => {
        recoveryStarted = true;
        adapter.installHandlers(stopRecovery);
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

    // Poll only while input is waiting for the original writer to stop.
    const waitForWriter = async (writer: UnverifiedAcpWriter): Promise<boolean> => {
        if (adapter.sessionExit.aborted) return false;
        installRecoveryHandlers();
        writer.notifyParked();
        const end = AbortSignal.any([adapter.sessionExit, adapter.queueClosed]);
        const check = new AcpRecoveryAttempt(end);
        for (;;) {
            if (end.aborted) return false;
            if (recoveryController.signal.aborted) recoveryController = new AbortController();
            const wait = AbortSignal.any([end, recoveryController.signal]);
            if (!adapter.hasInput()) await adapter.waitForInput(wait);
            if (wait.aborted) continue;
            if (adapter.hasInput()) {
                try {
                    // Drain this one passive probe before starting another.
                    // Stop invalidates its result even when the old writer has since exited.
                    const verified = await check.startup(writer.verify);
                    if (wait.aborted) continue;
                    if (verified && adapter.hasInput()) return true;
                } catch (error) {
                    if (wait.aborted) continue;
                    throw error;
                }
            }
            if (adapter.hasInput()) await waitForRecoveryDelay(1_000, wait);
        }
    };

    for (;;) {
        if (adapter.sessionExit.aborted) return 'exit';
        const isRecoveryAttempt = recoveryStarted;
        const launchStartedAt = performance.now();
        let recoveryLaunchReady = false;
        let startupFailedBeforeStop = false;
        const launcher = adapter.create({
            isRecoveryAttempt,
            recoverySignal: AbortSignal.any([recoveryController.signal, adapter.sessionExit]),
            onRecoveryStart: installRecoveryHandlers,
            onRecoveryStartupFailure: () => {
                if (!stopped && !recoveryLaunchReady) startupFailedBeforeStop = true;
            },
            onRecoveryHandlersCleared: installRecoveryHandlers,
            onRecoveryReady: () => {
                recoveryLaunchReady = true;
                if (isRecoveryAttempt) {
                    // Startup errors after this point are ordinary launcher
                    // errors, not continuation failures of the replacement.
                    // Keep the child-exit counter until a prompt completes so
                    // a repeatedly dying child still reaches its bound.
                    recoveryStarted = false;
                    if (stopped) {
                        stopped = false;
                        recoveryController = new AbortController();
                    }
                }
            }
        });
        let result: RemoteLauncherExitReason;
        let launchError: unknown = null;
        let resumeAfterFence = false;
        try {
            result = await launcher.launch();
        } catch (error) {
            launchError = error;
            if (error instanceof MissingAcpWriterCapture) {
                if (!adapter.sessionExit.aborted) await error.finishSession();
                return 'exit';
            }
            if (error instanceof UnverifiedAcpWriter && adapter.sessionExit.aborted) return 'exit';
            if (error instanceof UnverifiedAcpWriter && (stopped || error.switchRequested)) {
                if (!await waitForWriter(error)) return 'exit';
                recoveryController = new AbortController();
                resumeAfterFence = true;
                launchError = null;
            } else if (launcher.hasCleanupFailure) {
                throw error;
            }
            result = 'exit';
        }
        if (launcher.startsNewConversation) {
            if (launchError !== null) throw launchError;
            return 'exit';
        }
        if (adapter.sessionExit.aborted) return 'exit';
        const needsRecovery = resumeAfterFence || launcher.shouldRecoverUnexpectedChildExit
            || (isRecoveryAttempt && !recoveryLaunchReady && (stopped || launchError !== null));
        if (!needsRecovery) {
            if (launchError !== null) throw launchError;
            return result;
        }
        installRecoveryHandlers();
        // A Stop during cleanup can arrive after the startup already failed.
        const cancelledStartup = isRecoveryAttempt && !recoveryLaunchReady && stopped && !startupFailedBeforeStop;
        if (isRecoveryAttempt && !cancelledStartup) {
            recoveryAttempt++;
            attempts.push(launchStartedAt);
        }
        if (launcher.hasCompletedPrompt) {
            recoveryAttempt = 0;
            lastRecoveryError = null;
        }
        if (launchError !== null && !cancelledStartup) lastRecoveryError = launchError;
        const queueClosed = AbortSignal.any([adapter.queueClosed, adapter.sessionExit]);
        if (queueClosed.aborted) return 'exit';
        // Stop cancels the lost turn and any replacement startup. Keep the
        // session available for the same queued input without acknowledging it.
        let demandRequired = false;
        for (;;) {
            if (stopped) {
                demandRequired = true;
                stopped = false;
                recoveryController = new AbortController();
            }
            if (demandRequired && !adapter.hasInput()) {
                const hasInput = await adapter.waitForInput(AbortSignal.any([recoveryController.signal, queueClosed]));
                if (queueClosed.aborted) return 'exit';
                if (!hasInput || stopped) continue;
            }
            const now = performance.now();
            while (attempts.length && now - attempts[0]! >= recoveryWindowMs) attempts.shift();
            if (recoveryAttempt >= recoveryBackoffsMs.length || attempts.length >= recoveryMaxAttemptsInWindow) {
                const error = lastRecoveryError instanceof Error
                    ? lastRecoveryError
                    : new Error('ACP child exited repeatedly');
                throw adapter.exhausted(error);
            }
            const delayMs = recoveryBackoffsMs[recoveryAttempt]!;
            const wait = AbortSignal.any([recoveryController.signal, queueClosed]);
            await waitForRecoveryDelay(delayMs, wait);
            if (queueClosed.aborted) return 'exit';
            if (stopped || (demandRequired && !adapter.hasInput())) continue;
            break;
        }
    }
}
