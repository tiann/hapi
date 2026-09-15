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

function isAbortError(error: unknown): boolean {
    return Boolean(error && typeof error === 'object' && (error as { name?: unknown }).name === 'AbortError')
}

export class RpcHandlerManager {
    private handlers: RpcHandlerMap = new Map()
    private readonly scopePrefix: string
    private readonly logger: (message: string, data?: any) => void
    private socket: Socket | null = null
    private readonly inFlightRequests = new Map<string, AbortController>()

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
        const requestId = request.requestId
        const abortController = requestId ? new AbortController() : null
        if (requestId && abortController) {
            this.inFlightRequests.get(requestId)?.abort()
            this.inFlightRequests.set(requestId, abortController)
        }

        try {
            const handler = this.handlers.get(request.method)
            if (!handler) {
                this.logger('[RPC] [ERROR] Method not found', { method: request.method })
                return JSON.stringify({ error: 'Method not found' })
            }

            const params = safeJsonParse(request.params)
            const result = await handler(params as any, abortController?.signal)
            return JSON.stringify(result)
        } catch (error) {
            if (isAbortError(error)) {
                return JSON.stringify({ error: 'Request aborted' })
            }

            const details = error instanceof Error
                ? { message: error.message, stack: error.stack }
                : { error: String(error) }
            this.logger('[RPC] [ERROR] Error handling request', details)
            return JSON.stringify({
                error: error instanceof Error ? error.message : 'Unknown error'
            })
        } finally {
            if (requestId && abortController && this.inFlightRequests.get(requestId) === abortController) {
                this.inFlightRequests.delete(requestId)
            }
        }
    }

    cancelRequest(requestId: string): boolean {
        const controller = this.inFlightRequests.get(requestId)
        if (!controller) {
            return false
        }

        controller.abort()
        return true
    }

    onSocketConnect(socket: Socket): void {
        this.socket = socket
        for (const [prefixedMethod] of this.handlers) {
            socket.emit('rpc-register', { method: prefixedMethod })
        }
    }

    onSocketDisconnect(): void {
        this.socket = null
        for (const controller of this.inFlightRequests.values()) {
            controller.abort()
        }
        this.inFlightRequests.clear()
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
