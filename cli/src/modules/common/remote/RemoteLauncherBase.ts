import { render } from 'ink';
import type { ReactElement } from 'react';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { restoreTerminalState } from '@/ui/terminalState';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export type RemoteLauncherExitReason = 'switch' | 'exit';

export type LaunchOutcome = {
    reachedReady: boolean;
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
        onLaunchStart: (isNewSession: boolean) => void;
        launchOnce: (signal: AbortSignal) => Promise<LaunchOutcome>;
        onLaunchSuccess?: () => void;
        onLaunchFailure?: (error: Error) => void;
    }): Promise<void> {
        const maxImmediateFailures = opts.maxImmediateFailures ?? 3;
        const respawnBackoffMs = opts.respawnBackoffMs ?? 1000;

        let consecutiveImmediateFailures = 0;
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

                if (reachedReady) {
                    consecutiveImmediateFailures = 0;
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
                this.ptyAbortController = null;
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

    protected async requestExit(
        reason: RemoteLauncherExitReason,
        handler: () => void | Promise<void>
    ): Promise<void> {
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
            await this.cleanup();
            this.finalizeTerminal();
        }

        return this.exitReason || 'exit';
    }
}
