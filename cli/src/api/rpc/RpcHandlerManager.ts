/**
 * Generic RPC handler manager for session and machine clients
 * Manages RPC method registration and handler execution (no encryption).
 */

import { logger as defaultLogger } from '@/ui/logger'
import type { RpcHandler, RpcHandlerConfig, RpcHandlerMap, RpcRequest } from './types'
import type { Socket } from 'socket.io-client'

function safeJsonParse(value: string): unknown {
    try {
        return JSON.parse(value) as unknown
    } catch {
        return null
    }
}

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map()
    private readonly scopePrefix: string
    private readonly logger: (message: string, data?: any) => void
    private socket: Socket | null = null

    constructor(config: RpcHandlerConfig) {
        this.scopePrefix = config.scopePrefix
        this.logger = config.logger || ((msg, data) => defaultLogger.debug(msg, data))
    }

    registerHandler<TRequest = any, TResponse = any>(
        method: string,
        handler: RpcHandler<TRequest, TResponse>
    ): void {
        const prefixedMethod = this.getPrefixedMethod(method)

        this.handlers.set(prefixedMethod, handler)

        if (this.socket) {
            this.socket.emit('rpc-register', { method: prefixedMethod })
        }
    }

    async handleRequest(request: RpcRequest): Promise<string> {
        try {
            const handler = this.handlers.get(request.method)
            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method })
                return JSON.stringify({ error: 'Method not found' })
            }

            const params = safeJsonParse(request.params)
            const result = await handler(params as any)
            return JSON.stringify(result)
        } catch (error) {
            this.logger('[RPC] [ERROR] Error handling request', { error })
            return JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error'
            })
        }
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod })
        }
    }

    onSocketDisconnect(): void {
        this.socket = null
    }

    getHandlerCount(): number {
        return this.handlers.size
    }

    hasHandler(method: string): boolean {
        const prefixedMethod = this.getPrefixedMethod(method)
        return this.handlers.has(prefixedMethod)
    }

    clearHandlers(): void {
        this.handlers.clear()
        this.logger('Cleared all RPC handlers')
    }

    private getPrefixedMethod(method: string): string {
        return `${this.scopePrefix}:${method}`
    }
}

export function createRpcHandlerManager(config: RpcHandlerConfig): RpcHandlerManager {
    return new RpcHandlerManager(config)
}

