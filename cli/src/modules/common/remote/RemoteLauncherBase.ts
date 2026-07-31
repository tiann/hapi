import { render } from 'ink';
import type { ReactElement } from 'react';
import { MessageBuffer } from '@/ui/ink/messageBuffer';
import { resetTerminalInputModes, restoreTerminalState } from '@/ui/terminalState';
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
            resetTerminalInputModes();
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
