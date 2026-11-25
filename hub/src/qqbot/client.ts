import { isObject } from '@hapi/protocol'

const API_BASE = 'https://api.bot.qq.com'
const REQUEST_TIMEOUT_MS = 5_000
const TOKEN_REFRESH_MARGIN_MS = 60_000

export type QqBotCredentials = {
    appId: string
    appSecret: string
    userOpenId: string
}

export type QqBotFetch = (url: string, init: RequestInit) => Promise<Response>

type AccessToken = { value: string; refreshAt: number }

export class QqBotClient {
    private token: AccessToken | undefined
    private tokenRequest: Promise<AccessToken> | undefined

    constructor(
        private readonly credentials: QqBotCredentials,
        private readonly fetcher: QqBotFetch = fetch,
        private readonly now: () => number = Date.now
    ) {}

    async sendMarkdown(content: string, shouldSend: () => boolean = () => true): Promise<void> {
        if (!shouldSend()) return
        let token = await this.getToken()
        // The session can change while authentication is in flight.
        if (!shouldSend()) return
        let response = await this.postMessage(content, token)
        // Retry only an explicit authentication rejection, never an uncertain delivery.
        if (response.status === 401) {
            void response.body?.cancel().catch(() => {})
            this.invalidate(token)
            if (!shouldSend()) return
            token = await this.getToken()
            if (!shouldSend()) return
            response = await this.postMessage(content, token)
            if (response.status === 401) this.invalidate(token)
        }
        const data = await this.readResponse('message', response)
        if (typeof data?.id !== 'string' || !data.id) {
            throw new Error('QQ Bot returned an invalid message response')
        }
    }

    private invalidate(token: AccessToken): void {
        // A concurrent request may already have refreshed the token we used.
        if (this.token === token) this.token = undefined
    }

    private getToken(): Promise<AccessToken> {
        if (this.token && this.now() < this.token.refreshAt) return Promise.resolve(this.token)
        this.tokenRequest ??= this.authenticate().finally(() => { this.tokenRequest = undefined })
        return this.tokenRequest
    }

    private async authenticate(): Promise<AccessToken> {
        const startedAt = this.now()
        const response = await this.post('token', '/app/getAppAccessToken', {
            appId: this.credentials.appId,
            clientSecret: this.credentials.appSecret
        })
        const data = await this.readResponse('token', response)
        const value = data?.access_token
        const seconds = typeof data?.expires_in === 'string' && /^\d+$/.test(data.expires_in)
            ? Number(data.expires_in)
            : data?.expires_in
        const lifetime = typeof seconds === 'number' ? seconds * 1_000 : 0
        if (typeof value !== 'string' || !/^[\x21-\x7e]+$/.test(value)
            || !Number.isSafeInteger(lifetime) || lifetime <= 0) {
            throw new Error('QQ Bot returned an invalid token response')
        }
        this.token = { value, refreshAt: startedAt + lifetime - Math.min(TOKEN_REFRESH_MARGIN_MS, lifetime / 2) }
        return this.token
    }

    private postMessage(content: string, token: AccessToken): Promise<Response> {
        const openId = encodeURIComponent(this.credentials.userOpenId)
        return this.post('message', `/v2/users/${openId}/messages`, {
            msg_type: 2,
            markdown: { content }
        }, token.value)
    }

    private async post(operation: 'token' | 'message', path: string, payload: object, token?: string): Promise<Response> {
        const headers: Record<string, string> = { 'content-type': 'application/json' }
        if (token) headers.authorization = `QQBot ${token}`
        try {
            return await this.fetcher(`${API_BASE}${path}`, {
                method: 'POST', headers, body: JSON.stringify(payload), redirect: 'error',
                signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS)
            })
        } catch {
            // Fetch errors can include the recipient's URL or credentials; do not log them.
            throw new Error(`QQ Bot ${operation} request failed`)
        }
    }

    private async readResponse(operation: 'token' | 'message', response: Response): Promise<Record<string, unknown> | null> {
        const body = await response.json().catch(() => null)
        const data = isObject(body) ? body : null
        const rawCode = data?.code
        const code = typeof rawCode === 'string' && /^\d{1,9}$/.test(rawCode) ? Number(rawCode) : rawCode
        const safeCode = typeof code === 'number' && Number.isSafeInteger(code) ? code : null
        if (!response.ok || (safeCode !== null && safeCode !== 0)) {
            throw new Error(`QQ Bot ${operation} failed (HTTP ${response.status}${safeCode ? `, code ${safeCode}` : ''})`)
        }
        return data
    }
}
