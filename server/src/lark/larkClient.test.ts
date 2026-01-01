import { describe, expect, test } from 'bun:test'
import { LarkClient } from './larkClient'

function jsonResponse(body: unknown, status: number = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' }
    })
}

describe('LarkClient.cid2ocid', () => {
    test('parses open_chat_id from data.open_chat_id', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: any, init?: any) => {
            const url = String(input)
            if (url.includes('/auth/v3/tenant_access_token/internal')) {
                return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 })
            }
            if (url.includes('/exchange/v3/cid2ocid')) {
                const body = init?.body ? JSON.parse(init.body) : {}
                expect(body.chat_id).toBe('7493035463154860051')
                return jsonResponse({ code: 0, msg: 'ok', data: { open_chat_id: 'oc_123' } })
            }
            return jsonResponse({ code: 404, msg: 'unexpected url' }, 404)
        }) as any

        try {
            const client = new LarkClient({ appId: 'a', appSecret: 's' })
            const ocid = await client.cid2ocid('7493035463154860051')
            expect(ocid).toBe('oc_123')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('parses open_chat_id from top-level open_chat_id when data wrapper is absent', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: any) => {
            const url = String(input)
            if (url.includes('/auth/v3/tenant_access_token/internal')) {
                return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 })
            }
            if (url.includes('/exchange/v3/cid2ocid')) {
                return jsonResponse({ code: 0, msg: 'ok', open_chat_id: 'oc_root' })
            }
            return jsonResponse({ code: 404, msg: 'unexpected url' }, 404)
        }) as any

        try {
            const client = new LarkClient({ appId: 'a', appSecret: 's' })
            const ocid = await client.cid2ocid('1')
            expect(ocid).toBe('oc_root')
        } finally {
            globalThis.fetch = originalFetch
        }
    })

    test('throws with response snippet when open_chat_id is missing', async () => {
        const originalFetch = globalThis.fetch
        globalThis.fetch = (async (input: any) => {
            const url = String(input)
            if (url.includes('/auth/v3/tenant_access_token/internal')) {
                return jsonResponse({ code: 0, msg: 'ok', tenant_access_token: 't', expire: 7200 })
            }
            if (url.includes('/exchange/v3/cid2ocid')) {
                return jsonResponse({ code: 0, msg: 'ok', data: {} })
            }
            return jsonResponse({ code: 404, msg: 'unexpected url' }, 404)
        }) as any

        try {
            const client = new LarkClient({ appId: 'a', appSecret: 's' })
            await expect(client.cid2ocid('1')).rejects.toThrow(/missing open_chat_id/)
        } finally {
            globalThis.fetch = originalFetch
        }
    })
})

