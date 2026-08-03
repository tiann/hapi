import { render } from 'ink';
import type { ReactElement } from 'react';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { restoreTerminalState } from '@/ui/terminalState';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export type RemoteLauncherExitReason = 'switch' | 'exit';

export type LaunchOutcome = {
    reachedReady: boolean;
    authFailed?: boolean;
    error?: Error;
};

export type RemoteLauncherDisplayContext = {
    messageBuffer: MessageBuffer;
    logPath?: string;
    onExit: () => void | Promise<void>;
    onSwitchToLocal: () => void | Promise<void>;
};

export type RemoteLauncherTerminalHandlers = {
    onExit: () => void | Promise<void>;
    onSwitchToLocal: () => void | Promise<void>;
};

export type RemoteLauncherAbortHandlers = {
    onAbort: () => void | Promise<void>;
    onSwitch: () => void | Promise<void>;
};

type RpcHandlerManagerLike = {
    registerHandler<TRequest = unknown, TResponse = unknown>(
        method: string,
        handler: (params: TRequest) => Promise<TResponse> | TResponse
    ): void;
};

export abstract class RemoteLauncherBase {
    protected readonly messageBuffer: MessageBuffer;
    protected readonly hasTTY: boolean;
    protected readonly logPath?: string;
    protected exitReason: RemoteLauncherExitReason | null = null;
    protected shouldExit: boolean = false;
    protected ptyAbortController: AbortController | null = null;
    private inkInstance: ReturnType<typeof render> | null = null;

    protected constructor(logPath?: string) {
        this.logPath = logPath;
        this.hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
        this.messageBuffer = new MessageBuffer();
    }

    protected abstract createDisplay(context: RemoteLauncherDisplayContext): ReactElement;

    protected abstract runMainLoop(): Promise<void>;

    protected abstract cleanup(): Promise<void>;

    protected getCurrentSessionId(): string | null {
        return null;
    }

    protected async runRespawnLoop(opts: {
        maxImmediateFailures?: number;
        respawnBackoffMs?: number;
        maxAuthRetries?: number;
        authRetryDelayMs?: number;
        onLaunchStart: (isNewSession: boolean) => void;
        launchOnce: (signal: AbortSignal) => Promise<LaunchOutcome>;
        onLaunchSuccess?: () => void;
        onLaunchFailure?: (error: Error) => void;
    }): Promise<void> {
        const maxImmediateFailures = opts.maxImmediateFailures ?? 3;
        const respawnBackoffMs = opts.respawnBackoffMs ?? 1000;
        const maxAuthRetries = opts.maxAuthRetries ?? 8;
        const authRetryDelayMs = opts.authRetryDelayMs ?? 1500;

        let consecutiveImmediateFailures = 0;
        let authRetries = 0;
        let previousSessionId: string | null = null;

        while (!this.exitReason) {
            const currentSessionId = this.getCurrentSessionId();
            const isNewSession = currentSessionId !== previousSessionId;
            opts.onLaunchStart(isNewSession);
            previousSessionId = currentSessionId;

            const controller = new AbortController();
            this.ptyAbortController = controller;

            let reachedReady = false;
            try {
                const outcome = await opts.launchOnce(controller.signal);
                reachedReady = outcome.reachedReady;

                if (outcome.authFailed) {
                    if (!this.exitReason && !controller.signal.aborted) {
                        authRetries++;
                        if (authRetries > maxAuthRetries) {
                            opts.onLaunchFailure?.(new Error(`Authentication failed after ${maxAuthRetries} attempts`));
                            this.exitReason = 'exit';
                            break;
                        }
                        await new Promise((r) => setTimeout(r, authRetryDelayMs));
                        continue;
                    }
                }

                if (reachedReady) {
                    consecutiveImmediateFailures = 0;
                    authRetries = 0;
                    opts.onLaunchSuccess?.();
                }

                if (outcome.error) {
                    throw outcome.error;
                }
            } catch (e) {
                if (this.exitReason) break;

                const error = e instanceof Error ? e : new Error(String(e));
                opts.onLaunchFailure?.(error);

                if (!reachedReady) {
                    consecutiveImmediateFailures++;
                    if (consecutiveImmediateFailures >= maxImmediateFailures) {
                        opts.onLaunchFailure?.(new Error(`PTY failed to start after ${maxImmediateFailures} attempts; ending session.`));
                        this.exitReason = 'exit';
                        break;
                    }
                    await new Promise((r) => setTimeout(r, respawnBackoffMs));
                }
                continue;
            } finally {
                // launchOnce may have raced PTY exit against an abort-aware queue
                // read. Cancel the losing read before the next launch starts so it
                // cannot steal that launch's first queued message.
                controller.abort();
                if (this.ptyAbortController === controller) {
                    this.ptyAbortController = null;
                }
            }
        }
    }

    protected setupTerminal(handlers: RemoteLauncherTerminalHandlers): void {
        if (this.hasTTY) {
            console.clear();
            this.inkInstance = render(this.createDisplay({
                messageBuffer: this.messageBuffer,
                logPath: this.logPath,
                onExit: handlers.onExit,
                onSwitchToLocal: handlers.onSwitchToLocal
            }), {
                exitOnCtrlC: false,
                patchConsole: false
            });
        }

        if (this.hasTTY) {
            process.stdin.resume();
            if (process.stdin.isTTY) {
                process.stdin.setRawMode(true);
            }
            process.stdin.setEncoding('utf8');
        }
    }

    protected setupAbortHandlers(
        rpcHandlerManager: RpcHandlerManagerLike,
        handlers: RemoteLauncherAbortHandlers
    ): void {
        rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {
            await handlers.onAbort();
        });

        rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async () => {
            await handlers.onSwitch();
        });
    }

    protected clearAbortHandlers(rpcHandlerManager: RpcHandlerManagerLike): void {
        rpcHandlerManager.registerHandler(RPC_METHODS.Abort, async () => {});
        rpcHandlerManager.registerHandler(RPC_METHODS.Switch, async () => {});
    }

    /**
     * Hook for flavor-specific "we are leaving remote mode" bookkeeping.
     * No-op by default — override only if a flavor has state that must stop
     * being valid the instant remote mode starts tearing down (OpenCode's
     * /compact availability flag is the motivating case; see
     * OpencodeRemoteLauncher's override).
     *
     * Called from two places, both intentionally, since neither alone covers
     * every way a launcher can stop being "in remote mode":
     *  1. `requestExit()`, synchronously, as its very first action — before
     *     `shouldExit`/`exitReason` are even set, and long before the
     *     `handler` it's about to await (e.g. OpenCode's `handleAbort()`,
     *     which does real async teardown work like cancelling the ACP
     *     prompt) gets a chance to run. This is what actually closes a race
     *     window: anything gated on flavor state this hook resets can no
     *     longer slip through between "a switch/exit was requested" and
     *     "the async teardown for it finished".
     *  2. `start()`'s `finally` block, unconditionally, as a backstop for
     *     every other way `runMainLoop()` can end — a thrown exception, for
     *     instance, never goes through `requestExit()` at all. Firing here
     *     too is what guarantees the hook always runs by the time this
     *     launcher's promise settles, not just on the two deliberate exit
     *     paths.
     *
     * Must stay synchronous and idempotent — it can run twice per exit (once
     * from each call site above) and must never assume `handler`/`cleanup()`
     * have run yet.
     */
    protected onLeavingRemote(): void {}

    protected async requestExit(
        reason: RemoteLauncherExitReason,
        handler: () => void | Promise<void>
    ): Promise<void> {
        this.onLeavingRemote();
        if (!this.exitReason) {
            this.exitReason = reason;
        }
        this.shouldExit = true;
        await handler();
    }

    protected finalizeTerminal(): void {
        restoreTerminalState();
        if (this.hasTTY) {
            try {
                process.stdin.pause();
            } catch {
            }
        }
        if (this.inkInstance) {
            this.inkInstance.unmount();
        }
        this.messageBuffer.clear();
    }

    protected async start(handlers: RemoteLauncherTerminalHandlers): Promise<RemoteLauncherExitReason> {
        this.setupTerminal(handlers);
        try {
            await this.runMainLoop();
        } finally {
            // Backstop call — see onLeavingRemote()'s doc comment for why
            // this needs to run here too, not just from requestExit().
            this.onLeavingRemote();
            await this.cleanup();
            this.finalizeTerminal();
        }

        return this.exitReason || 'exit';
    }
}
