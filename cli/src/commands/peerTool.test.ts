import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { ApiSessionClient } from '@/api/apiSession'
import { startHappyServer } from '@/claude/utils/startHappyServer'
import * as peerMessages from '@/modules/pingPeer/pingPeer'
import * as peerSpawn from '@/modules/spawnPeer/spawnPeer'
import { initializeToken } from '@/ui/tokenInit'
import { spawnHappyCLI } from '@/utils/spawnHappyCLI'
import { peerToolCommand, runPeerToolCommand } from './peerTool'
import { resolveCommand } from './registry'

vi.mock('@/ui/tokenInit', () => ({
    initializeToken: vi.fn(async () => {})
}))

vi.mock('@/api/fetchGithubPrAwareness', () => ({
    fetchGithubPrAwarenessEnabled: vi.fn(async () => false)
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    spawnHappyCLI: vi.fn(() => ({ on: vi.fn(), unref: vi.fn() }))
}))

const mockInitializeToken = vi.mocked(initializeToken)
const mockSpawnHappyCLI = vi.mocked(spawnHappyCLI)

const input = (value: unknown) => async () => typeof value === 'string' ? value : JSON.stringify(value)

describe('hapi peer-tool', () => {
    beforeEach(() => {
        vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', '')
        vi.stubEnv('HAPI_SESSION_ID', 'parent-id')
        mockInitializeToken.mockClear()
        mockSpawnHappyCLI.mockClear()
    })

    afterEach(() => {
        vi.unstubAllEnvs()
        vi.restoreAllMocks()
    })

    it('is registered as a command that needs no runtime assets', async () => {
        const resolved = await resolveCommand(['peer-tool', 'list_peers'])
        expect(resolved?.command.name).toBe('peer-tool')
        expect(resolved?.command.requiresRuntimeAssets).toBe(false)
        expect(resolved?.context.commandArgs).toEqual(['list_peers'])
    })

    it.each([
        [[], '{}', 'missing tool name'],
        [['search_peers'], '{}', "unknown peer tool 'search_peers'"],
        [['list_peers', 'extra'], '{}', 'unexpected arg: extra'],
        [['list_peers'], 'not json', 'arguments on stdin must be JSON'],
        [['ping_peer'], '{"sessionIdPrefix":"peer-id","message":"hi","deliveryMode":"interrupt"}', 'invalid arguments for ping_peer: deliveryMode'],
        [['inspect_peer'], '{}', 'invalid arguments for inspect_peer: sessionIdPrefix'],
    ])('rejects usage error %j %s before contacting the hub', async (args, stdin, message) => {
        const list = vi.spyOn(peerMessages, 'listPeerSessions')
        const ping = vi.spyOn(peerMessages, 'pingPeer')
        await expect(runPeerToolCommand(args, input(stdin))).rejects.toThrow(message)
        expect(mockInitializeToken).not.toHaveBeenCalled()
        expect(list).not.toHaveBeenCalled()
        expect(ping).not.toHaveBeenCalled()
    })

    it('refuses every tool when HAPI_DISABLE_PEER_TOOLS is set', async () => {
        vi.stubEnv('HAPI_DISABLE_PEER_TOOLS', '1')
        for (const name of ['list_peers', 'inspect_peer', 'ping_peer', 'spawn_peer']) {
            await expect(runPeerToolCommand([name], input({}))).rejects.toThrow('HAPI_DISABLE_PEER_TOOLS')
        }
        expect(mockInitializeToken).not.toHaveBeenCalled()
    })

    it('treats empty stdin as no arguments and excludes the calling session', async () => {
        const list = vi.spyOn(peerMessages, 'listPeerSessions').mockResolvedValue([])
        const result = await runPeerToolCommand(['list_peers'], input(''))
        expect(result?.isError).toBe(false)
        expect(mockInitializeToken).toHaveBeenCalledOnce()
        expect(list).toHaveBeenCalledWith(expect.objectContaining({ includeInactive: false }))
    })

    it('spawns with the env parent identity without requiring one', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({
            sessionId: 'child-id', name: 'Worker', flavor: 'codex'
        })
        const result = await runPeerToolCommand(['spawn_peer'], input({ directory: '/srv/project', message: 'Run the tests' }))
        expect(result?.content[0]?.text).toBe('Spawned child-id (Worker)')
        const options = spawn.mock.calls[0]![0]
        expect(options).toMatchObject({ directory: '/srv/project', message: 'Run the tests', requireParent: false })
        expect(options).not.toHaveProperty('parent')
    })

    it('writes the tool result as JSON on stdout and exits 1 on tool errors', async () => {
        vi.spyOn(peerMessages, 'inspectPeer').mockRejectedValue(new peerMessages.PingPeerError('not_found', 'no session matches nope'))
        const write = vi.spyOn(process.stdout, 'write').mockReturnValue(true)
        const stdin = vi.spyOn(process, 'stdin', 'get')
        const { Readable } = await import('node:stream')
        stdin.mockReturnValue(Readable.from([Buffer.from('{"sessionIdPrefix":"nope"}')]) as typeof process.stdin)
        const previousExitCode = process.exitCode
        try {
            await peerToolCommand.run({ args: ['peer-tool', 'inspect_peer'], subcommand: 'peer-tool', commandArgs: ['inspect_peer'] })
            expect(JSON.parse(String(write.mock.calls.at(-1)?.[0]))).toEqual({
                content: [{ type: 'text', text: 'Failed to inspect peer: no session matches nope' }],
                isError: true,
            })
            expect(process.exitCode).toBe(1)
        } finally {
            process.exitCode = previousExitCode
        }
    })

    it('returns a JSON tool error when hub credentials are missing', async () => {
        mockInitializeToken.mockRejectedValueOnce(new Error('CLI_API_TOKEN is required. Set it via environment variable or run `hapi auth login`.'))
        const list = vi.spyOn(peerMessages, 'listPeerSessions')
        const result = await runPeerToolCommand(['list_peers'], input({}))
        expect(result).toEqual({
            content: [{ type: 'text', text: 'Failed to run list_peers: CLI_API_TOKEN is required. Set it via environment variable or run `hapi auth login`.' }],
            isError: true,
        })
        expect(list).not.toHaveBeenCalled()
    })

    it('hands waitForReply forwarding to a detached process and returns at once', async () => {
        vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false, localId: 'ping-peer-1', delivery: 'invoked'
        })
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue()
        const result = await runPeerToolCommand(['ping_peer'], input({ sessionIdPrefix: 'peer-id', message: 'hi', waitForReply: true }))
        expect(result?.content[0]?.text).toContain('its reply will be posted here')
        expect(forward).not.toHaveBeenCalled()
        expect(mockSpawnHappyCLI).toHaveBeenCalledWith(
            ['peer-tool', '__forward_reply', 'peer-id', 'ping-peer-1', 'parent-id'],
            { detached: true, stdio: 'ignore' }
        )
        const child = mockSpawnHappyCLI.mock.results[0]!.value as { unref: ReturnType<typeof vi.fn> }
        expect(child.unref).toHaveBeenCalledOnce()
    })

    it('runs the detached reply forwarder in-process', async () => {
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue()
        await expect(runPeerToolCommand(['__forward_reply', 'peer-id', 'ping-peer-1', 'parent-id'], input(''))).resolves.toBeNull()
        expect(mockInitializeToken).toHaveBeenCalledOnce()
        expect(forward).toHaveBeenCalledWith({ peerSessionId: 'peer-id', taskLocalId: 'ping-peer-1', callerSessionId: 'parent-id' })
        await expect(runPeerToolCommand(['__forward_reply', 'peer-id'], input(''))).rejects.toThrow('usage: hapi peer-tool __forward_reply')
    })

    it('exits 2 on usage errors', async () => {
        const exit = vi.spyOn(process, 'exit').mockImplementation(((code?: number) => {
            throw new Error(`exit ${code}`)
        }) as typeof process.exit)
        vi.spyOn(console, 'error').mockImplementation(() => {})
        await expect(peerToolCommand.run({ args: ['peer-tool'], subcommand: 'peer-tool', commandArgs: [] })).rejects.toThrow('exit 2')
        expect(exit).toHaveBeenCalledWith(2)
    })

    describe('parity with the in-process MCP tools', () => {
        let client: Client | null = null
        let stopServer: (() => void) | null = null

        afterEach(async () => {
            await client?.close()
            stopServer?.()
            client = null
            stopServer = null
        })

        async function connect(): Promise<Client> {
            const sessionClient = {
                sessionId: 'parent-id',
                getMetadata: () => ({ name: 'Parent', path: '/srv', flavor: 'codex' }),
                updateMetadata: vi.fn(),
                sendAgentMessage: vi.fn(),
                sendClaudeSessionMessage: vi.fn()
            } as unknown as ApiSessionClient
            const server = await startHappyServer(sessionClient, { enableLinkPr: false })
            stopServer = server.stop
            client = new Client({ name: 'hapi-peer-tool-test', version: '1.0.0' }, { capabilities: {} })
            await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
            return client
        }

        it.each([
            ['ping_peer', { sessionIdPrefix: 'peer-id', message: 'hello', deliveryMode: 'queue', wake: true }],
            ['ping_peer', { sessionIdPrefix: 'missing', message: 'hello' }],
            ['spawn_peer', { directory: '/srv/project', message: 'Run the tests', waitForReply: true }],
            ['inspect_peer', { sessionIdPrefix: 'peer-id', messageLimit: 5 }],
            ['list_peers', { limit: 1, includeInactive: true }],
        ] as const)('%s %j returns the same result as MCP', async (name, args) => {
            vi.spyOn(peerMessages, 'pingPeer').mockImplementation(async (options) => {
                if (options.sessionIdPrefix === 'missing') throw new peerMessages.PingPeerError('not_found', 'no session matches missing')
                return { sessionId: 'peer-id', name: 'Peer', resumed: true, localId: 'ping-peer-1', delivery: 'invoked' }
            })
            vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({
                sessionId: 'child-id', name: 'Worker', localId: 'ping-peer-2', flavor: 'codex'
            })
            vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue()
            vi.spyOn(peerMessages, 'inspectPeer').mockResolvedValue({} as Awaited<ReturnType<typeof peerMessages.inspectPeer>>)
            vi.spyOn(peerMessages, 'formatInspectPeerReport').mockReturnValue('INSPECT REPORT')
            vi.spyOn(peerMessages, 'listPeerSessions').mockResolvedValue([
                { id: 'parent-id', active: true, updatedAt: 2, metadata: { name: 'Parent', flavor: 'codex', path: '/srv' } },
                { id: 'peer-a', active: true, updatedAt: 1, metadata: { name: 'A', flavor: 'claude', path: '/srv/a' } },
                { id: 'peer-b', active: false, updatedAt: 0, metadata: { name: 'B', flavor: 'claude', path: '/srv/b' } },
            ])

            const mcp = await connect()
            const viaMcp = await mcp.callTool({ name, arguments: args })
            const viaCli = await runPeerToolCommand([name], input(args))
            expect(viaCli).toEqual(viaMcp)
        })
    })
})
