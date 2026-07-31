import { render } from 'ink';
import type { ReactElement } from 'react';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { restoreTerminalState } from '@/ui/terminalState';
import { RPC_METHODS } from '@hapi/protocol/rpcMethods';

export type RemoteLauncherExitReason = 'switch' | 'exit';

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
    private inkInstance: ReturnType<typeof render> | null = null;

    protected constructor(logPath?: string) {
        this.logPath = logPath;
        this.hasTTY = Boolean(process.stdout.isTTY && process.stdin.isTTY);
        this.messageBuffer = new MessageBuffer();
    }

    protected abstract createDisplay(context: RemoteLauncherDisplayContext): ReactElement;

    protected abstract runMainLoop(): Promise<void>;

    protected abstract cleanup(): Promise<void>;

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
