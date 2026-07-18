import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { z } from 'zod'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import {
    startHappyServer,
    type HapiMcpToolRegistration,
} from './startHappyServer'

function sleep(milliseconds: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, milliseconds))
}

function createApiClient(): ApiSessionClient {
    return {
        sendClaudeSessionMessage: vi.fn(),
        getMetadataSnapshot: vi.fn(() => null),
        updateMetadata: vi.fn(),
        sendAgentMessage: vi.fn(),
    } as unknown as ApiSessionClient
}

function echoMarkerTool(): HapiMcpToolRegistration {
    return {
        name: 'echo_marker',
        description: 'Echo a marker after an optional delay',
        title: 'Echo Marker',
        inputSchema: z.object({
            marker: z.string(),
            delayMs: z.number().int().min(0).max(1_000),
        }),
        handler: async (args) => {
            const marker = String(args.marker)
            const delayMs = Number(args.delayMs)
            if (delayMs > 0) await sleep(delayMs)
            return {
                content: [{ type: 'text', text: marker }],
                isError: false,
            }
        },
    }
}

async function connectClient(url: string, name: string): Promise<Client> {
    const client = new Client(
        { name, version: '1.0.0' },
        { capabilities: {} },
    )
    await client.connect(new StreamableHTTPClientTransport(new URL(url)))
    return client
}

describe('HAPI stateless MCP HTTP server', () => {
    const clients: Client[] = []
    const stops: Array<() => void> = []

    afterEach(async () => {
        await Promise.allSettled(clients.splice(0).map((client) => client.close()))
        for (const stop of stops.splice(0)) stop()
    })

    it('isolates concurrent requests from two independently initialized clients', async () => {
        const server = await startHappyServer(createApiClient(), { extraTools: [echoMarkerTool()] })
        stops.push(server.stop)
        const first = await connectClient(server.url, 'collision-first')
        const second = await connectClient(server.url, 'collision-second')
        clients.push(first, second)

        const [a, b] = await Promise.race([
            Promise.all([
                first.callTool({ name: 'echo_marker', arguments: { marker: 'slow-a', delayMs: 75 } }),
                second.callTool({ name: 'echo_marker', arguments: { marker: 'fast-b', delayMs: 0 } }),
            ]),
            new Promise<never>((_, reject) => setTimeout(() => reject(new Error('MCP collision timeout')), 5_000)),
        ])

        expect(JSON.stringify(a)).toContain('slow-a')
        expect(JSON.stringify(a)).not.toContain('fast-b')
        expect(JSON.stringify(b)).toContain('fast-b')
        expect(JSON.stringify(b)).not.toContain('slow-a')
    }, 10_000)

    it('supports sequential stateless reconnects and registers built-in tools every time', async () => {
        const server = await startHappyServer(createApiClient(), { extraTools: [echoMarkerTool()] })
        stops.push(server.stop)

        for (const [name, marker] of [['reconnect-first', 'first'], ['reconnect-second', 'second']] as const) {
            const client = await connectClient(server.url, name)
            clients.push(client)
            const tools = await client.listTools()
            expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
                'change_title',
                'send_attachment',
                'echo_marker',
            ]))
            const result = await client.callTool({
                name: 'echo_marker',
                arguments: { marker, delayMs: 0 },
            })
            expect(JSON.stringify(result)).toContain(marker)
            await client.close()
            clients.splice(clients.indexOf(client), 1)
        }
    }, 10_000)

    it('cleans an aborted request before accepting the next stateless client', async () => {
        const server = await startHappyServer(createApiClient(), { extraTools: [echoMarkerTool()] })
        stops.push(server.stop)
        const abortedClient = await connectClient(server.url, 'abort-first')
        clients.push(abortedClient)
        const controller = new AbortController()
        const pending = abortedClient.callTool(
            { name: 'echo_marker', arguments: { marker: 'aborted', delayMs: 250 } },
            undefined,
            { signal: controller.signal },
        )
        setTimeout(() => controller.abort(), 10)

        await expect(pending).rejects.toThrow()
        await sleep(300)
        await abortedClient.close()
        clients.splice(clients.indexOf(abortedClient), 1)

        const next = await connectClient(server.url, 'abort-next')
        clients.push(next)
        const result = await next.callTool({
            name: 'echo_marker',
            arguments: { marker: 'after-abort', delayMs: 0 },
        })
        expect(JSON.stringify(result)).toContain('after-abort')
        expect(JSON.stringify(result)).not.toContain('"aborted"')
    }, 10_000)
})
