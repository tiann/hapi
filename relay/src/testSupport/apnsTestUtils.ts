/**
 * Test-only helpers shared by apns.test.ts and relay.integration.test.ts:
 * a local node:http2 mock standing in for APNs, plus ES256 key generation.
 * Never imported by production code.
 */
import {
    createServer,
    type Http2Server,
    type IncomingHttpHeaders,
    type ServerHttp2Session,
    type ServerHttp2Stream
} from 'node:http2'
import { exportPKCS8, generateKeyPair } from 'jose'

export type RecordedRequest = {
    headers: IncomingHttpHeaders
    body: string
}

export type Responder = (stream: ServerHttp2Stream, request: RecordedRequest) => void

const defaultResponder: Responder = (stream) => {
    stream.respond({ ':status': 200, 'apns-id': 'mock-apns-id' })
    stream.end()
}

/**
 * Minimal APNs stand-in: plaintext (h2c) node:http2 server that records
 * every request and answers from a queue of scripted responders (default:
 * 200 with an apns-id header).
 */
export class MockApnsServer {
    readonly requests: RecordedRequest[] = []
    sessionCount = 0

    private readonly server: Http2Server
    private readonly responders: Responder[] = []
    private readonly sessions = new Set<ServerHttp2Session>()
    private portValue = 0

    constructor() {
        this.server = createServer()
        this.server.on('session', (session) => {
            this.sessionCount += 1
            this.sessions.add(session)
            session.on('close', () => this.sessions.delete(session))
        })
        this.server.on('stream', (stream: ServerHttp2Stream, headers: IncomingHttpHeaders) => {
            let body = ''
            stream.setEncoding('utf8')
            stream.on('data', (chunk: string) => {
                body += chunk
            })
            stream.on('error', () => {
                // client cancelled (e.g. timeout test) - ignore
            })
            stream.on('end', () => {
                const recorded: RecordedRequest = { headers: { ...headers }, body }
                this.requests.push(recorded)
                const responder = this.responders.shift() ?? defaultResponder
                responder(stream, recorded)
            })
        })
    }

    /** Script the next response (FIFO). Unscripted requests get a 200. */
    queue(responder: Responder): void {
        this.responders.push(responder)
    }

    /** Script the next response as a status + optional JSON body. */
    queueStatus(status: number, body?: unknown): void {
        this.queue((stream) => {
            stream.respond({ ':status': status })
            stream.end(body === undefined ? '' : JSON.stringify(body))
        })
    }

    get port(): number {
        return this.portValue
    }

    get url(): string {
        return `http://127.0.0.1:${this.portValue}`
    }

    async start(): Promise<void> {
        await new Promise<void>((resolve) => {
            this.server.listen(0, '127.0.0.1', () => resolve())
        })
        const addr = this.server.address()
        if (typeof addr === 'object' && addr !== null) {
            this.portValue = addr.port
        }
    }

    async stop(): Promise<void> {
        for (const session of this.sessions) {
            try {
                session.destroy()
            } catch {
                // already gone
            }
        }
        await new Promise<void>((resolve) => {
            this.server.close(() => resolve())
        })
    }
}

export type TestKeys = {
    /** PKCS#8 PEM private key, same format as an Apple .p8 file. */
    privateKeyPem: string
    publicKey: Awaited<ReturnType<typeof generateKeyPair>>['publicKey']
}

export async function makeTestKeys(): Promise<TestKeys> {
    const { publicKey, privateKey } = await generateKeyPair('ES256', { extractable: true })
    return { privateKeyPem: await exportPKCS8(privateKey), publicKey }
}
