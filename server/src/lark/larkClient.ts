type ReceiveIdType = 'chat_id' | 'open_id' | 'user_id' | 'email'

export interface LarkClientConfig {
    appId: string
    appSecret: string
    baseUrl?: string
}

export interface SendTextParams {
    receiveIdType: ReceiveIdType
    receiveId: string
    text: string
}

export interface SendInteractiveParams {
    receiveIdType: ReceiveIdType
    receiveId: string
    card: unknown
}

export interface PatchMessageParams {
    openMessageId: string
    card: unknown
}

type Cid2OcidResponse = {
    code: number
    msg: string
    // Some APIs wrap fields under data; keep flexible for robustness.
    data?: {
        open_chat_id?: string
        [key: string]: unknown
    }
    open_chat_id?: string
}

type TenantAccessTokenResponse = {
    code: number
    msg: string
    tenant_access_token?: string
    expire?: number
}

type SendMessageResponse = {
    code: number
    msg: string
    data?: {
        message_id?: string
        [key: string]: unknown
    }
}

function nowSec(): number {
    return Math.floor(Date.now() / 1000)
}

async function readJsonOrThrow(res: Response): Promise<any> {
    const text = await res.text()
    try {
        return JSON.parse(text)
    } catch {
        throw new Error(`Invalid JSON response (status ${res.status}): ${text.slice(0, 200)}`)
    }
}

function jsonSnippet(value: unknown): string {
    try {
        return JSON.stringify(value).slice(0, 400)
    } catch {
        return '[unserializable]'
    }
}

/**
 * Minimal Lark (Feishu) Open Platform client.
 *
 * KISS:
 * - 仅支持 tenant_access_token/internal
 * - 仅支持发送 text 消息
 */
export class LarkClient {
    private readonly appId: string
    private readonly appSecret: string
    private readonly baseUrl: string

    private cachedToken: { value: string; expiresAtSec: number } | null = null

    constructor(config: LarkClientConfig) {
        this.appId = config.appId
        this.appSecret = config.appSecret
        this.baseUrl = config.baseUrl ?? 'https://open.feishu.cn/open-apis'
    }

    private async getTenantAccessToken(): Promise<string> {
        const cached = this.cachedToken
        const now = nowSec()
        if (cached && cached.expiresAtSec - 60 > now) {
            return cached.value
        }

        const url = `${this.baseUrl}/auth/v3/tenant_access_token/internal`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json'
            },
            body: JSON.stringify({
                app_id: this.appId,
                app_secret: this.appSecret
            })
        })

        const json = (await readJsonOrThrow(res)) as TenantAccessTokenResponse
        if (!res.ok) {
            throw new Error(`tenant_access_token http ${res.status}: ${json?.msg ?? 'unknown error'}`)
        }

        if (json.code !== 0 || !json.tenant_access_token || !json.expire) {
            throw new Error(`tenant_access_token error: code=${json.code} msg=${json.msg}`)
        }

        const expiresAtSec = now + Number(json.expire)
        this.cachedToken = { value: json.tenant_access_token, expiresAtSec }
        return json.tenant_access_token
    }

    async sendText(params: SendTextParams): Promise<void> {
        const token = await this.getTenantAccessToken()

        const url = `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(params.receiveIdType)}`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                receive_id: params.receiveId,
                msg_type: 'text',
                content: JSON.stringify({ text: params.text })
            })
        })

        const json = (await readJsonOrThrow(res)) as SendMessageResponse
        if (!res.ok) {
            throw new Error(`sendText http ${res.status}: ${json?.msg ?? 'unknown error'}; response=${jsonSnippet(json)}`)
        }

        if (json.code !== 0) {
            throw new Error(`sendText error: code=${json.code} msg=${json.msg}; response=${jsonSnippet(json)}`)
        }
    }

    async sendInteractive(params: SendInteractiveParams): Promise<string | undefined> {
        const token = await this.getTenantAccessToken()

        const url = `${this.baseUrl}/im/v1/messages?receive_id_type=${encodeURIComponent(params.receiveIdType)}`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                receive_id: params.receiveId,
                msg_type: 'interactive',
                content: JSON.stringify(params.card)
            })
        })

        const json = (await readJsonOrThrow(res)) as SendMessageResponse
        if (!res.ok) {
            throw new Error(`sendInteractive http ${res.status}: ${json?.msg ?? 'unknown error'}; response=${jsonSnippet(json)}`)
        }
        if (json.code !== 0) {
            throw new Error(`sendInteractive error: code=${json.code} msg=${json.msg}; response=${jsonSnippet(json)}`)
        }
        return json.data?.message_id
    }

    async patchMessage(params: PatchMessageParams): Promise<void> {
        const token = await this.getTenantAccessToken()

        const url = `${this.baseUrl}/im/v1/messages/${encodeURIComponent(params.openMessageId)}`
        const res = await fetch(url, {
            method: 'PATCH',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                msg_type: 'interactive',
                content: JSON.stringify(params.card)
            })
        })

        const json = (await readJsonOrThrow(res)) as SendMessageResponse
        if (!res.ok) {
            throw new Error(`patchMessage http ${res.status}: ${json?.msg ?? 'unknown error'}; response=${jsonSnippet(json)}`)
        }
        if (json.code !== 0) {
            throw new Error(`patchMessage error: code=${json.code} msg=${json.msg}; response=${jsonSnippet(json)}`)
        }
    }

    async cid2ocid(chatId: string): Promise<string> {
        const token = await this.getTenantAccessToken()
        const url = `${this.baseUrl}/exchange/v3/cid2ocid`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({ chat_id: chatId })
        })

        const json = (await readJsonOrThrow(res)) as Cid2OcidResponse
        if (!res.ok) {
            throw new Error(`cid2ocid http ${res.status}: ${json?.msg ?? 'unknown error'}`)
        }
        if (json.code !== 0) {
            throw new Error(`cid2ocid error: code=${json.code} msg=${json.msg}`)
        }
        const ocid = json.data?.open_chat_id ?? json.open_chat_id
        if (!ocid) {
            throw new Error(`cid2ocid missing open_chat_id; response=${jsonSnippet(json)}`)
        }
        return ocid
    }

    async validateAuthCode(code: string): Promise<{ open_id: string; name?: string; user_id?: string }> {
        const token = await this.getTenantAccessToken()
        const url = `${this.baseUrl}/authen/v1/access_token`
        const res = await fetch(url, {
            method: 'POST',
            headers: {
                'content-type': 'application/json; charset=utf-8',
                'authorization': `Bearer ${token}`
            },
            body: JSON.stringify({
                grant_type: 'authorization_code',
                code
            })
        })

        const json = await readJsonOrThrow(res)
        if (!res.ok) {
             throw new Error(`validateAuthCode http ${res.status}: ${json?.msg ?? 'unknown error'}`)
        }
        if (json.code !== 0) {
            throw new Error(`validateAuthCode error: code=${json.code} msg=${json.msg}`)
        }
        
        // data: { access_token, token_type, expires_in, name, en_name, avatar_url, open_id, union_id, email, user_id, ... }
        return {
            open_id: json.data?.open_id,
            name: json.data?.name,
            user_id: json.data?.user_id
        }
    }
}
