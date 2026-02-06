import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { createHmac } from 'node:crypto'

const baseUrl = process.env.HAPI_BASE_URL ?? 'http://127.0.0.1:3006'
const cliTokenEnv = process.env.HAPI_CLI_TOKEN ?? ''
const jwtEnv = process.env.HAPI_JWT ?? ''
const outSse = process.env.HAPI_SSE_OUT ?? 'hub_go/test/recordings/sse/sse-events.json'
const outSocket = process.env.HAPI_SOCKET_OUT ?? 'hub_go/test/recordings/socket/socket-events.json'
const maxEvents = Number.parseInt(process.env.HAPI_SSE_MAX ?? '50', 10)
const timeoutMs = Number.parseInt(process.env.HAPI_SSE_TIMEOUT_MS ?? '8000', 10)

async function loadCliToken(): Promise<string> {
    if (cliTokenEnv) return cliTokenEnv
    try {
        const raw = await readFile('/root/.hapi/settings.json', 'utf8')
        const data = JSON.parse(raw) as { cliApiToken?: string }
        return data.cliApiToken ?? ''
    } catch {
        return ''
    }
}

async function generateJwt(): Promise<string> {
    try {
        const secretRaw = await readFile('/root/.hapi/jwt-secret.json', 'utf8')
        const ownerRaw = await readFile('/root/.hapi/owner-id.json', 'utf8')
        const secret = JSON.parse(secretRaw).secretBase64 as string
        const owner = JSON.parse(ownerRaw).ownerId as number
        const now = Math.floor(Date.now() / 1000)
        const header = { alg: 'HS256', typ: 'JWT' }
        const payload = { uid: owner, ns: 'default', iat: now, exp: now + 900 }
        const b64 = (obj: unknown) => Buffer.from(JSON.stringify(obj)).toString('base64url')
        const data = `${b64(header)}.${b64(payload)}`
        const sig = createHmac('sha256', Buffer.from(secret, 'base64')).update(data).digest('base64url')
        return `${data}.${sig}`
    } catch {
        return ''
    }
}

async function fetchWithTimeout(url: string, init: RequestInit, timeout: number): Promise<Response> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), timeout)
    try {
        return await fetch(url, { ...init, signal: controller.signal })
    } finally {
        clearTimeout(timer)
    }
}

async function getJwt(cliToken: string): Promise<string> {
    if (jwtEnv) return jwtEnv
    const generated = await generateJwt()
    if (generated) return generated
    if (!cliToken) return ''
    const response = await fetchWithTimeout(`${baseUrl}/api/auth`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ accessToken: cliToken })
    }, 4000)
    if (!response.ok) return ''
    const body = await response.json().catch(() => null)
    if (!body || typeof body.token !== 'string') return ''
    return body.token
}

async function recordSse(jwtToken: string, sessionId: string): Promise<any[]> {
    if (!jwtToken) {
        console.error('Missing JWT token for SSE recording')
        return []
    }
    const query = new URLSearchParams()
    query.set('all', 'true')
    query.set('visibility', process.env.HAPI_VISIBILITY ?? 'visible')
    query.set('token', jwtToken)
    if (sessionId) {
        query.set('sessionId', sessionId)
    }

    const url = `${baseUrl}/api/events?${query.toString()}`
    const response = await fetchWithTimeout(url, { headers: { accept: 'text/event-stream' } }, timeoutMs + 1000)
    if (!response.ok || !response.body) {
        console.error(`SSE connect failed: ${response.status}`)
        return []
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const events: any[] = []
    let buffer = ''
    const start = Date.now()

    const readWithTimeout = async (ms: number): Promise<{ done: boolean; value?: Uint8Array }> => {
        return await Promise.race([
            reader.read(),
            new Promise<{ done: boolean; value?: Uint8Array }>((resolve) => {
                setTimeout(() => resolve({ done: true }), ms)
            })
        ]).catch(() => ({ done: true }))
    }

    while (events.length < maxEvents && Date.now() - start < timeoutMs) {
        const { done, value } = await readWithTimeout(500)
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const parts = buffer.split('\n\n')
        buffer = parts.pop() ?? ''
        for (const part of parts) {
            const line = part.split('\n').find((l) => l.startsWith('data: '))
            if (!line) continue
            const json = line.replace(/^data:\s*/, '')
            try {
                events.push(JSON.parse(json))
                if (events.length >= maxEvents) break
            } catch {
                continue
            }
        }
    }

    await mkdir(dirname(outSse), { recursive: true })
    await writeFile(outSse, JSON.stringify(events, null, 4))
    console.log(`Recorded ${events.length} SSE events to ${outSse}`)
    return events
}

async function recordSocket(cliToken: string, sessionId: string): Promise<void> {
    try {
        const mod = await import('socket.io-client')
        const io = mod.io ?? mod.default
        if (!io) {
            console.error('socket.io-client not available')
            return
        }
        if (!cliToken) {
            console.error('Missing CLI token for Socket.IO recording')
            return
        }
        const events: Array<{ namespace: string; direction: string; event: string; payload: any }> = []
        const listenerAuth: Record<string, string> = { token: cliToken }
        if (sessionId) {
            listenerAuth.sessionId = sessionId
        }
        const listener = io(`${baseUrl}/cli`, {
            path: '/socket.io',
            transports: ['websocket'],
            auth: listenerAuth
        })
        const sender = io(`${baseUrl}/cli`, {
            path: '/socket.io',
            transports: ['websocket'],
            auth: { token: cliToken }
        })
        let updateResolve: (() => void) | null = null
        const updatePromise = new Promise<void>((resolve) => {
            updateResolve = resolve
        })
        const waitForListenerConnect = new Promise<void>((resolve) => {
            listener.on('connect', () => {
                events.push({ namespace: '/cli', direction: 'server->client', event: 'connect', payload: { id: listener.id } })
                resolve()
            })
        })
        listener.on('connect_error', (error: any) => {
            events.push({ namespace: '/cli', direction: 'server->client', event: 'connect_error', payload: { message: String(error?.message ?? error) } })
        })
        listener.onAny((event: string, payload: any) => {
            events.push({ namespace: '/cli', direction: 'server->client', event, payload })
            if (event === 'update' && updateResolve) {
                updateResolve()
                updateResolve = null
            }
        })
        const waitForSenderConnect = new Promise<void>((resolve) => {
            sender.on('connect', () => {
                resolve()
            })
        })
        await Promise.race([
            Promise.all([waitForListenerConnect, waitForSenderConnect]),
            new Promise((resolve) => setTimeout(resolve, 1500))
        ])
        if (sessionId) {
            const alivePayload = { sid: sessionId, time: Date.now(), thinking: false }
            const messagePayload = { sid: sessionId, message: { role: 'user', content: 'recording' } }
            events.push({ namespace: '/cli', direction: 'client->server', event: 'session-alive', payload: alivePayload })
            events.push({ namespace: '/cli', direction: 'client->server', event: 'message', payload: messagePayload })
            sender.emit('session-alive', alivePayload)
            sender.emit('message', messagePayload)
        }
        await Promise.race([
            updatePromise,
            new Promise((resolve) => setTimeout(resolve, 8000))
        ])
        listener.close()
        sender.close()
        await mkdir(dirname(outSocket), { recursive: true })
        await writeFile(outSocket, JSON.stringify(events, null, 4))
        console.log(`Recorded ${events.length} Socket.IO events to ${outSocket}`)
    } catch (error) {
        console.error('Socket.IO recording skipped', error)
    }
}

async function postJson(url: string, token: string, body: unknown): Promise<any> {
    const response = await fetchWithTimeout(url, {
        method: 'POST',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
    }, 4000)
    return await response.json().catch(() => null)
}

async function patchJson(url: string, token: string, body: unknown): Promise<any> {
    const response = await fetchWithTimeout(url, {
        method: 'PATCH',
        headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${token}`
        },
        body: JSON.stringify(body)
    }, 4000)
    return await response.json().catch(() => null)
}

async function deleteJson(url: string, token: string): Promise<any> {
    const response = await fetchWithTimeout(url, {
        method: 'DELETE',
        headers: {
            authorization: `Bearer ${token}`
        }
    }, 4000)
    return await response.json().catch(() => null)
}

async function main(): Promise<void> {
    const cliToken = await loadCliToken()
    const jwt = await getJwt(cliToken)

    const sessionResp = await postJson(`${baseUrl}/cli/sessions`, cliToken, {
        tag: `contract-record-${Date.now()}`,
        metadata: { name: 'Contract Recording', path: '/tmp' },
        agentState: null
    })
    const sessionId = sessionResp?.session?.id ?? ''

    const ssePromise = recordSse(jwt, sessionId)

    if (sessionId) {
        await patchJson(`${baseUrl}/api/sessions/${sessionId}`, jwt, { name: 'Contract Recording Updated' })
    }

    await postJson(`${baseUrl}/cli/machines`, cliToken, {
        id: `machine-contract-${Date.now()}`,
        metadata: { host: 'recording-host' },
        runnerState: null
    })

    await recordSocket(cliToken, sessionId)

    if (sessionId) {
        await postJson(`${baseUrl}/api/sessions/${sessionId}/messages`, jwt, {
            text: 'contract recording message',
            attachments: []
        })
    }

    if (sessionId) {
        await deleteJson(`${baseUrl}/api/sessions/${sessionId}`, jwt)
    }

    await ssePromise
}

main().catch((error) => {
    console.error(error)
    process.exit(1)
})
