import { randomUUID } from 'node:crypto'

import { getOpenClawTransportConfig, type OpenClawTransportConfig } from './config'
import type { OpenClawCommandAck } from './types'

export interface OpenClawClient {
    ensureDefaultConversation(input: { externalUserKey: string }): Promise<{ conversationId: string; title?: string | null }>
    sendMessage(input: {
        conversationId: string
        text: string
        localMessageId: string
        idempotencyKey: string
    }): Promise<OpenClawCommandAck>
    approve(input: {
        conversationId: string
        requestId: string
        idempotencyKey: string
    }): Promise<OpenClawCommandAck>
    deny(input: {
        conversationId: string
        requestId: string
        idempotencyKey: string
    }): Promise<OpenClawCommandAck>
}

class OfficialOpenClawClient implements OpenClawClient {
    constructor(private readonly config: OpenClawTransportConfig) {}

    async ensureDefaultConversation(input: { externalUserKey: string }): Promise<{ conversationId: string; title?: string | null }> {
        const body = await this.requestJson('/hapi/channel/conversations/default', {
            method: 'POST',
            body: JSON.stringify({
                externalUserKey: input.externalUserKey
            })
        })

        const conversationId = readString(body?.conversationId, body?.id)
        if (!conversationId) {
            throw new Error('OpenClaw default conversation response missing conversationId')
        }

        return {
            conversationId,
            title: readString(body?.title, body?.name) ?? 'OpenClaw'
        }
    }

    async sendMessage(input: {
        conversationId: string
        text: string
        localMessageId: string
        idempotencyKey: string
    }): Promise<OpenClawCommandAck> {
        const body = await this.requestJson('/hapi/channel/messages', {
            method: 'POST',
            headers: {
                'idempotency-key': input.idempotencyKey
            },
            body: JSON.stringify({
                conversationId: input.conversationId,
                text: input.text,
                localMessageId: input.localMessageId
            })
        })

        return {
            accepted: true,
            upstreamRequestId: readString(body?.requestId, body?.id) ?? randomUUID(),
            upstreamConversationId: readString(body?.conversationId) ?? input.conversationId,
            retryAfterMs: readNumber(body?.retryAfterMs) ?? null
        }
    }

    async approve(input: {
        conversationId: string
        requestId: string
        idempotencyKey: string
    }): Promise<OpenClawCommandAck> {
        const body = await this.requestJson(`/hapi/channel/approvals/${encodeURIComponent(input.requestId)}/approve`, {
            method: 'POST',
            headers: {
                'idempotency-key': input.idempotencyKey
            },
            body: JSON.stringify({
                conversationId: input.conversationId
            })
        })

        return {
            accepted: true,
            upstreamRequestId: readString(body?.requestId, body?.id) ?? randomUUID(),
            upstreamConversationId: readString(body?.conversationId) ?? input.conversationId,
            retryAfterMs: readNumber(body?.retryAfterMs) ?? null
        }
    }

    async deny(input: {
        conversationId: string
        requestId: string
        idempotencyKey: string
    }): Promise<OpenClawCommandAck> {
        const body = await this.requestJson(`/hapi/channel/approvals/${encodeURIComponent(input.requestId)}/deny`, {
            method: 'POST',
            headers: {
                'idempotency-key': input.idempotencyKey
            },
            body: JSON.stringify({
                conversationId: input.conversationId
            })
        })

        return {
            accepted: true,
            upstreamRequestId: readString(body?.requestId, body?.id) ?? randomUUID(),
            upstreamConversationId: readString(body?.conversationId) ?? input.conversationId,
            retryAfterMs: readNumber(body?.retryAfterMs) ?? null
        }
    }

    private async requestJson(pathname: string, init: RequestInit): Promise<Record<string, unknown> | null> {
        const baseUrl = this.config.pluginBaseUrl
        const sharedSecret = this.config.sharedSecret

        const controller = new AbortController()
        const timeout = setTimeout(() => controller.abort(), this.config.timeoutMs)
        try {
            const headers = new Headers(init.headers)
            headers.set('authorization', `Bearer ${sharedSecret}`)
            headers.set('content-type', 'application/json')

            const response = await fetch(new URL(pathname, baseUrl).toString(), {
                ...init,
                headers,
                signal: controller.signal
            })

            const bodyText = await response.text()
            if (!response.ok) {
                const detail = bodyText ? `: ${bodyText}` : ''
                throw new Error(`OpenClaw upstream request failed with HTTP ${response.status}${detail}`)
            }

            if (!bodyText) {
                return null
            }

            const parsed = JSON.parse(bodyText) as unknown
            return isRecord(parsed) ? parsed : null
        } catch (error) {
            if (error instanceof Error && error.name === 'AbortError') {
                throw new Error(`OpenClaw upstream request timed out after ${this.config.timeoutMs}ms`)
            }
            throw error
        } finally {
            clearTimeout(timeout)
        }
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readString(...values: unknown[]): string | null {
    for (const value of values) {
        if (typeof value === 'string' && value.length > 0) {
            return value
        }
    }
    return null
}

function readNumber(...values: unknown[]): number | null {
    for (const value of values) {
        if (typeof value === 'number' && Number.isFinite(value)) {
            return value
        }
    }
    return null
}

export function createOpenClawClient(config: OpenClawTransportConfig = getOpenClawTransportConfig()): OpenClawClient {
    return new OfficialOpenClawClient(config)
}
