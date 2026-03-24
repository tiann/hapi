export type BarkAttentionPayload = {
    title: string
    body: string
    group: string
    url: string
}

type BarkPushPayload = BarkAttentionPayload & {
    device_key: string
}

export type BarkFetch = (
    input: string | URL | Request,
    init?: RequestInit
) => Promise<Response>

export type BarkDeliveryOptions = {
    baseUrl: string
    deviceKey: string
    fetchImpl?: BarkFetch
    timeoutMs?: number
}

const DEFAULT_TIMEOUT_MS = 5_000

class BarkHttpError extends Error {
    constructor(
        readonly status: number,
        readonly transient: boolean
    ) {
        super(`Bark request failed with status ${status}`)
    }
}

class BarkTransientError extends Error {}

export function normalizeBarkServerUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '')
}

export class BarkDelivery {
    private readonly baseUrl: string
    private readonly deviceKey: string
    private readonly fetchImpl: BarkFetch
    private readonly timeoutMs: number

    constructor(options: BarkDeliveryOptions) {
        this.baseUrl = normalizeBarkServerUrl(options.baseUrl)
        this.deviceKey = options.deviceKey
        this.fetchImpl = options.fetchImpl ?? fetch
        this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
    }

    async send(payload: BarkAttentionPayload): Promise<void> {
        const barkPayload: BarkPushPayload = {
            ...payload,
            device_key: this.deviceKey
        }

        try {
            await this.sendOnce(barkPayload)
            return
        } catch (error) {
            if (!this.shouldRetry(error)) {
                throw error
            }
        }

        await this.sendOnce(barkPayload)
    }

    private async sendOnce(payload: BarkPushPayload): Promise<void> {
        const abortController = new AbortController()
        const timeoutHandle = setTimeout(() => {
            abortController.abort()
        }, this.timeoutMs)

        try {
            const response = await this.fetchImpl(this.getPushUrl(), {
                method: 'POST',
                headers: {
                    'content-type': 'application/json'
                },
                body: JSON.stringify(payload),
                signal: abortController.signal
            })

            if (response.ok) {
                return
            }

            const transient = response.status >= 500
            throw new BarkHttpError(response.status, transient)
        } catch (error) {
            if (error instanceof BarkHttpError) {
                throw error
            }
            if (this.isAbortError(error)) {
                throw new BarkTransientError('Bark request timed out')
            }
            throw new BarkTransientError('Bark request failed')
        } finally {
            clearTimeout(timeoutHandle)
        }
    }

    private shouldRetry(error: unknown): boolean {
        if (error instanceof BarkHttpError) {
            return error.transient
        }
        return error instanceof BarkTransientError
    }

    private isAbortError(error: unknown): boolean {
        if (!(error instanceof Error)) {
            return false
        }
        return error.name === 'AbortError'
    }

    private getPushUrl(): string {
        return `${this.baseUrl}/push`
    }
}
