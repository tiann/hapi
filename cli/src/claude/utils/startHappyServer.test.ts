import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { ToolListChangedNotificationSchema } from '@modelcontextprotocol/sdk/types.js'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { ApiSessionClient } from '@/api/apiSession'
import { upsertSessionExternalRef } from '@/api/upsertSessionExternalRef'
import { fetchGithubPrAwarenessEnabled } from '@/api/fetchGithubPrAwareness'
import { linkIssue as linkIssueViaHub } from '@/modules/linkIssue/linkIssue'
import * as peerMessages from '@/modules/pingPeer/pingPeer'
import * as peerSpawn from '@/modules/spawnPeer/spawnPeer'
import { startHappyServer, toClaudeAllowedHapiMcpTools } from './startHappyServer'

vi.mock('@/api/upsertSessionExternalRef', () => ({
    upsertSessionExternalRef: vi.fn()
}))

vi.mock('@/api/fetchGithubPrAwareness', () => ({
    fetchGithubPrAwarenessEnabled: vi.fn(async () => false)
}))

vi.mock('@/modules/linkIssue/linkIssue', () => ({
    linkIssue: vi.fn()
}))

const mockUpsertSessionExternalRef = vi.mocked(upsertSessionExternalRef)
const mockFetchGithubPrAwarenessEnabled = vi.mocked(fetchGithubPrAwarenessEnabled)
const mockLinkIssueViaHub = vi.mocked(linkIssueViaHub)

type ToolResult = {
    content?: Array<{ type: string; text?: string }>
    isError?: boolean
}

describe('startHappyServer skill_lookup', () => {
    const originalHome = process.env.HOME
    let sandboxDir: string
    let workingDirectory: string
    let client: Client | null
    let stopServer: (() => void) | null
    let sendAgentMessage: ReturnType<typeof vi.fn>

    beforeEach(async () => {
        sandboxDir = await mkdtemp(join(tmpdir(), 'hapi-skill-mcp-'))
        workingDirectory = join(sandboxDir, 'repo')
        process.env.HOME = join(sandboxDir, 'home')
        await mkdir(join(workingDirectory, '.git'), { recursive: true })
        await mkdir(process.env.HOME, { recursive: true })
        client = null
        stopServer = null
    })

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        if (originalHome === undefined) {
            delete process.env.HOME
        } else {
            process.env.HOME = originalHome
        }
        await rm(sandboxDir, { recursive: true, force: true })
    })

    async function connect(enableSkillLookup = true): Promise<Client> {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            sessionId: 'parent-id',
            getMetadata: () => ({ name: 'Parent', path: workingDirectory, flavor: 'codex' }),
            updateMetadata: vi.fn(),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, enableSkillLookup
            ? {
                enableLinkPr: false,
                skillLookup: {
                    workingDirectory,
                    flavor: 'opencode'
                }
            }
            : { enableLinkPr: false })
        stopServer = server.stop

        client = new Client(
            { name: 'hapi-skill-lookup-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('returns a discovered SKILL.md body', async () => {
        const skillDir = join(workingDirectory, '.agents', 'skills', 'review')
        await mkdir(skillDir, { recursive: true })
        await writeFile(join(skillDir, 'SKILL.md'), [
            '---',
            'name: review',
            'description: Review changes safely',
            '---',
            '',
            '# Review instructions',
            '',
            'Inspect the diff before editing.'
        ].join('\n'))

        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'review' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Skill: review')
        expect(result.content?.[0]?.text).toContain('Description: Review changes safely')
        expect(result.content?.[0]?.text).toContain('# Review instructions')
    })

    it('returns a tool error for an unknown skill', async () => {
        const mcp = await connect()
        const result = await mcp.callTool({
            name: 'skill_lookup',
            arguments: { name: 'missing' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Skill not found: missing')
    })

    it('does not expose the fallback tool to native-skill sessions', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()

        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
            'change_title',
            'display_image',
            'display_media',
            'display_video',
            'inspect_peer',
            'link_issue',
            'list_peers',
            'ping_peer',
            'session_job',
            'spawn_peer',
        ])
    })

    it('invokes onChangeTitle when change_title succeeds', async () => {
        sendAgentMessage = vi.fn()
        const sessionClient = {
            updateMetadata: vi.fn(),
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const server = await startHappyServer(sessionClient, { onChangeTitle })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        await mcp.callTool({
            name: 'change_title',
            arguments: { title: '  Manual\n Title  ' }
        })

        expect(onChangeTitle).toHaveBeenCalledWith('Manual Title')
        expect(sessionClient.flushMetadata).toHaveBeenCalledTimes(2)
    })

    it('does not invoke onChangeTitle when the metadata update fails', async () => {
        sendAgentMessage = vi.fn()
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage,
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const server = await startHappyServer(sessionClient, { onChangeTitle })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        updateMetadata.mockImplementation(() => { throw new Error('update failed') })
        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: 'Manual Title' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(onChangeTitle).not.toHaveBeenCalled()
    })

    it.each([
        { title: '   ', options: {}, isError: true },
        { title: 'Child Title', options: { emitTitleSummary: false }, isError: false }
    ])('does not rename or mark manual precedence for $title with $options', async ({ title, options, isError }) => {
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const server = await startHappyServer(sessionClient, { ...options, onChangeTitle })
        stopServer = server.stop
        client = new Client({ name: 'hapi-title-test', version: '1.0.0' })
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        updateMetadata.mockClear()
        const result = await client.callTool({ name: 'change_title', arguments: { title } }) as ToolResult

        expect(result.isError).toBe(isError)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(onChangeTitle).not.toHaveBeenCalled()
    })

    it('describes display_image as user output rather than image input', async () => {
        const mcp = await connect(false)
        const tools = await mcp.listTools()
        const displayImage = tools.tools.find((tool) => tool.name === 'display_image')

        expect(displayImage?.description).toContain('human user')
        expect(displayImage?.description).toContain('does not provide image input to the model')
        expect(displayImage?.description).toContain('cannot be used to read, inspect, or analyze image contents')
    })

    it('exposes concise delivery contracts for all media tools', async () => {
        const mcp = await connect(false)
        const { tools } = await mcp.listTools()
        for (const name of ['display_image', 'display_video', 'display_media']) {
            const description = tools.find(tool => tool.name === name)?.description
            expect(description).toContain('absolute filesystem path')
            expect(description).toContain('25 MiB')
            expect(description).toContain('explicit delivery preferences')
            expect(description).not.toContain('Web/PWA')
            expect(description).not.toContain('iOS')
        }
    })

    it.each([
        [undefined, 'accepted'],
        [undefined, 'steered'],
        ['auto', 'accepted'],
        ['auto', 'steered'],
        ['auto', 'invoked'],
        ['queue', 'accepted'],
        ['steer', 'steered'],
        ['steer', 'invoked']
    ] as const)('forwards ping_peer mode %s and reports %s through MCP', async (deliveryMode, delivery) => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false,
            localId: 'ping-peer-test', delivery
        })
        try {
            const mcp = await connect(false)
            const tools = await mcp.listTools()
            const tool = tools.tools.find((entry) => entry.name === 'ping_peer')
            expect(tool?.inputSchema.properties?.deliveryMode).toMatchObject({ enum: ['auto', 'queue', 'steer'] })
            expect(tool?.description).toContain('auto (default)')
            const result = await mcp.callTool({
                name: 'ping_peer',
                arguments: { sessionIdPrefix: 'peer-id', message: 'hello', ...(deliveryMode ? { deliveryMode } : {}) }
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(ping).toHaveBeenCalledWith({ sessionIdPrefix: 'peer-id', message: 'hello', deliveryMode, wake: false })
            expect(result.content?.[0]?.text).toBe(delivery === 'accepted'
                ? 'Accepted for peer-id (Peer) localId=ping-peer-test — delivery shows in the recipient chat when its runtime consumes it'
                : `${delivery} to peer-id (Peer) localId=ping-peer-test`)
        } finally {
            ping.mockRestore()
        }
    })

    it.each([
        'steer not attempted: target is idle',
        'steer rejected by hub: Session not found',
        'steer not confirmed; delivery unresolved: Steer outcome is being reconciled'
    ])('appends the auto steer note to an accepted ping_peer receipt without claiming nothing was sent: %s', async (steerNote) => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: false,
            localId: 'ping-peer-test', delivery: 'accepted', steerNote
        })
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'ping_peer', arguments: { sessionIdPrefix: 'peer-id', message: 'hello' }
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(result.content?.[0]?.text).toBe(
                `Accepted for peer-id (Peer) localId=ping-peer-test — delivery shows in the recipient chat when its runtime consumes it (${steerNote})`)
            expect(result.content?.[0]?.text).not.toMatch(/no message sent/i)
        } finally {
            ping.mockRestore()
        }
    })

    it('forwards ping_peer wake only when explicitly requested', async () => {
        const ping = vi.spyOn(peerMessages, 'pingPeer').mockResolvedValue({
            sessionId: 'peer-id', name: 'Peer', resumed: true,
            localId: 'ping-peer-test', delivery: 'accepted'
        })
        try {
            const mcp = await connect(false)
            const tools = await mcp.listTools()
            const tool = tools.tools.find((entry) => entry.name === 'ping_peer')
            expect(tool?.inputSchema.properties?.wake).toMatchObject({ type: 'boolean' })
            expect(tool?.description).toContain('Never broadcast')
            const result = await mcp.callTool({
                name: 'ping_peer',
                arguments: { sessionIdPrefix: 'peer-id', message: 'take over the build', wake: true }
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(ping).toHaveBeenCalledWith({
                sessionIdPrefix: 'peer-id', message: 'take over the build', deliveryMode: undefined, wake: true
            })
            expect(result.content?.[0]?.text).toContain('(resumed)')
        } finally {
            ping.mockRestore()
        }
    })

    it('forwards inspect_peer through MCP and returns the formatted report', async () => {
        const inspect = vi.spyOn(peerMessages, 'inspectPeer').mockResolvedValue({} as Awaited<ReturnType<typeof peerMessages.inspectPeer>>)
        const format = vi.spyOn(peerMessages, 'formatInspectPeerReport').mockReturnValue('INSPECT REPORT')
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'inspect_peer',
                arguments: { sessionIdPrefix: 'peer-id', messageLimit: 12 },
            }) as ToolResult
            expect(inspect).toHaveBeenCalledWith({ sessionIdPrefix: 'peer-id', messageLimit: 12 })
            expect(format).toHaveBeenCalledOnce()
            expect(result.isError).toBe(false)
            expect(result.content?.[0]?.text).toBe('INSPECT REPORT')
        } finally {
            inspect.mockRestore()
            format.mockRestore()
        }
    })

    it('lists active peers by default and forwards includeInactive', async () => {
        const list = vi.spyOn(peerMessages, 'listPeerSessions').mockResolvedValue([])
        try {
            const mcp = await connect(false)
            await mcp.callTool({ name: 'list_peers', arguments: {} })
            expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: false }))
            await mcp.callTool({ name: 'list_peers', arguments: { includeInactive: true } })
            expect(list).toHaveBeenLastCalledWith(expect.objectContaining({ includeInactive: true }))
        } finally {
            list.mockRestore()
        }
    })

    it('rejects invalid ping_peer delivery modes at the MCP boundary', async () => {
        const ping = vi.spyOn(peerMessages, 'pingPeer')
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'ping_peer', arguments: { sessionIdPrefix: 'peer-id', message: 'hello', deliveryMode: 'interrupt' }
            }) as ToolResult
            expect(result.isError).toBe(true)
            expect(ping).not.toHaveBeenCalled()
        } finally {
            ping.mockRestore()
        }
    })

    it('forwards the spawned peer\'s reply when waitForReply is set', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({
            sessionId: 'child-id', name: 'Worker', localId: 'ping-peer-1', flavor: 'codex'
        })
        const forward = vi.spyOn(peerMessages, 'forwardPeerReply').mockResolvedValue()
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'spawn_peer',
                arguments: { directory: '/srv/project', message: 'Run the tests', waitForReply: true },
            }) as ToolResult
            expect(result.content?.[0]?.text).toBe('Spawned child-id (Worker); its reply will be posted here')
            expect(forward).toHaveBeenCalledWith({ peerSessionId: 'child-id', taskLocalId: 'ping-peer-1', callerSessionId: 'parent-id' })
        } finally {
            spawn.mockRestore()
            forward.mockRestore()
        }
    })

    it('forwards cross-machine spawn settings with the calling session identity and cwd', async () => {
        const spawn = vi.spyOn(peerSpawn, 'spawnPeer').mockResolvedValue({
            sessionId: 'child-id', name: 'Worker', flavor: 'codex'
        })
        try {
            const mcp = await connect(false)
            const result = await mcp.callTool({
                name: 'spawn_peer',
                arguments: {
                    directory: '/srv/project',
                    message: 'Run the tests',
                    machine: 'remote-host',
                    agent: 'codex',
                    model: 'gpt-5.6-sol',
                    effort: 'high',
                    permissionMode: 'default',
                },
            }) as ToolResult
            expect(result.isError).toBe(false)
            expect(spawn).toHaveBeenCalledWith(expect.objectContaining({
                directory: '/srv/project',
                cwd: workingDirectory,
                message: 'Run the tests',
                machine: 'remote-host',
                agent: 'codex',
                model: 'gpt-5.6-sol',
                effort: 'high',
                permissionMode: 'default',
                parent: { sessionId: 'parent-id', name: 'Parent', agentSessionId: null },
                requireParent: true,
            }))
        } finally {
            spawn.mockRestore()
        }
    })

    it('displays audio through display_media and emits a generated media message', async () => {
        const path = join(sandboxDir, 'sample.wav')
        await writeFile(path, Buffer.from('RIFFxxxxWAVE'))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'sample.wav' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: sample.wav')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'sample.wav',
            mimeType: 'audio/wav',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('preserves the source extension when display_media title omits one', async () => {
        const path = join(sandboxDir, 'plan-a.zip')
        await writeFile(path, Buffer.from([0x50, 0x4b, 0x03, 0x04]))
        const mcp = await connect(false)

        const result = await mcp.callTool({
            name: 'display_media',
            arguments: { path, title: 'Cursor Plan A Markdown 导出' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Displayed media: Cursor Plan A Markdown 导出.zip')
        expect(sendAgentMessage).toHaveBeenCalledWith(expect.objectContaining({
            type: 'generated-image',
            fileName: 'Cursor Plan A Markdown 导出.zip',
            mimeType: 'application/octet-stream',
            source: { ingress: 'mcp', toolName: 'display_media' }
        }))
    })

    it('does not expose change_title when native ACP titles are enabled', async () => {
        const sessionClient = {
            sessionId: 'test-session-id',
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false, enableLinkPr: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-test', version: '1.0.0' })
        client = mcp

        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const tools = await mcp.listTools()

        expect(server.toolNames).toEqual([
            'link_issue',
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'ping_peer',
            'inspect_peer',
            'spawn_peer',
            'session_job',
        ])
        expect(tools.tools.map((tool) => tool.name).sort()).toEqual([
            'display_image',
            'display_media',
            'display_video',
            'inspect_peer',
            'link_issue',
            'list_peers',
            'ping_peer',
            'session_job',
            'spawn_peer',
        ])
    })

    it('links a github issue and reports success only after the hub acks the write', async () => {
        mockLinkIssueViaHub.mockReset()
        mockLinkIssueViaHub.mockResolvedValue(undefined)
        const sessionClient = {
            sessionId: 'session-link-issue-ok',
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableLinkPr: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-link-issue-test', version: '1.0.0' })
        client = mcp
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        const result = await mcp.callTool({
            name: 'link_issue',
            arguments: { url: 'heavygee/hapi#235' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Linked heavygee/hapi#235')
        expect(mockLinkIssueViaHub).toHaveBeenCalledWith('session-link-issue-ok', 'heavygee/hapi#235')
    })

    it('reports failure instead of a false success when the hub rejects the write', async () => {
        mockLinkIssueViaHub.mockReset()
        mockLinkIssueViaHub.mockRejectedValue(new Error('request failed'))
        const sessionClient = {
            sessionId: 'session-link-issue-fail',
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, { enableLinkPr: false })
        stopServer = server.stop
        const mcp = new Client({ name: 'hapi-link-issue-fail-test', version: '1.0.0' })
        client = mcp
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        const result = await mcp.callTool({
            name: 'link_issue',
            arguments: { url: 'heavygee/hapi#235' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Failed to link issue')
    })

})

describe('startHappyServer link_pr', () => {
    let stopServer: (() => void) | null
    let mcp: Client | null

    afterEach(async () => {
        await mcp?.close()
        stopServer?.()
        mcp = null
        stopServer = null
        mockUpsertSessionExternalRef.mockReset()
    })

    async function connectWithClient(sessionClient: ApiSessionClient): Promise<Client> {
        const server = await startHappyServer(sessionClient, { enableChangeTitle: false, enableLinkPr: true })
        stopServer = server.stop
        mcp = new Client({ name: 'hapi-link-pr-test', version: '1.0.0' })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return mcp
    }

    it('reports success when hub upsert persists the ref', async () => {
        const linkedRef = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'primary' as const,
            source: 'agent' as const,
            linkedAt: 1_700_000_000_000
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [linkedRef]
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [linkedRef] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Linked tiann/hapi#1163')
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            repo: 'tiann/hapi',
            number: 1163
        }))
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })

    it('forwards Enterprise PR URLs to the hub unchanged', async () => {
        const linkedRef = {
            kind: 'github_pr' as const,
            repo: 'owner/repo',
            number: 42,
            url: 'https://acme.ghe.com/owner/repo/pull/42',
            role: 'primary' as const,
            source: 'agent' as const,
            linkedAt: 1
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [linkedRef]
        })
        const sessionClient = {
            sessionId: 'sess-ghes',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [linkedRef] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://acme.ghe.com/owner/repo/pull/42' }
        }) as ToolResult

        expect(result.isError).toBeFalsy()
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledWith('sess-ghes', expect.objectContaining({
            repo: 'owner/repo',
            number: 42,
            url: 'https://acme.ghe.com/owner/repo/pull/42'
        }))
    })

    // Review finding (hapi#2147, follow-up on the port-stripping identity
    // bug): the persisted-check rebuilt its own comparison host via
    // `new URL(ref.url).hostname`, which strips a non-default port — that
    // mismatched hostFromGithubPrUrl's (now port-retaining) output for the
    // hub's stored ref, so a successfully-persisted port-qualified PR link
    // reported a false "Hub did not persist the PR link" error.
    it('persists a port-qualified GHES PR URL without a false "not persisted" error', async () => {
        const linkedRef = {
            kind: 'github_pr' as const,
            repo: 'owner/repo',
            number: 42,
            url: 'https://tenant.ghe.com:8443/owner/repo/pull/42',
            role: 'primary' as const,
            source: 'agent' as const,
            linkedAt: 1
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [linkedRef]
        })
        const sessionClient = {
            sessionId: 'sess-ghes-port',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [linkedRef] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://tenant.ghe.com:8443/owner/repo/pull/42' }
        }) as ToolResult

        expect(result.isError).toBeFalsy()
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledWith('sess-ghes-port', expect.objectContaining({
            repo: 'owner/repo',
            number: 42,
            url: 'https://tenant.ghe.com:8443/owner/repo/pull/42'
        }))
    })

    it('upserts without wiping other github_pr refs', async () => {
        const existing = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 100,
            url: 'https://github.com/tiann/hapi/pull/100',
            role: 'primary' as const,
            source: 'user' as const,
            linkedAt: 1
        }
        const secondary = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'secondary' as const,
            source: 'agent' as const,
            linkedAt: 2
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [existing, secondary]
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [existing, secondary] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163', role: 'secondary' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledWith('sess-1', expect.objectContaining({
            repo: 'tiann/hapi',
            number: 1163,
            role: 'secondary'
        }))
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })

    it('preserves cached health when re-linking the same PR', async () => {
        const existing = {
            kind: 'github_pr' as const,
            repo: 'tiann/hapi',
            number: 1163,
            url: 'https://github.com/tiann/hapi/pull/1163',
            role: 'primary' as const,
            source: 'agent' as const,
            linkedAt: 300,
            openState: 'open' as const,
            checks: 'pending' as const,
            merge: 'unstable' as const,
            statusCheckedAt: 200,
            estateCode: 'ci_pending'
        }
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [existing]
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [existing] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledOnce()
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })

    it('errors when the hub does not persist the linked ref', async () => {
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: []
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Hub did not persist the PR link')
    })

    it('fails once at MAX_EXTERNAL_REFS without queueing metadata retries', async () => {
        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: false,
            status: 400,
            error: 'at most 32 external refs are allowed'
        })
        const sessionClient = {
            sessionId: 'sess-1',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const client = await connectWithClient(sessionClient)
        const result = await client.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('at most 32 external refs')
        expect(mockUpsertSessionExternalRef).toHaveBeenCalledOnce()
        expect(sessionClient.flushMetadata).not.toHaveBeenCalled()
    })
})

describe('startHappyServer dynamic link_pr awareness', () => {
    let stopServer: (() => void) | null
    let mcp: Client | null

    afterEach(async () => {
        await mcp?.close()
        stopServer?.()
        mcp = null
        stopServer = null
        mockFetchGithubPrAwarenessEnabled.mockReset()
        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(false)
        mockUpsertSessionExternalRef.mockReset()
    })

    function sessionClient(): ApiSessionClient {
        return {
            sessionId: 'sess-awareness',
            updateMetadata: vi.fn(),
            flushMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => ({ externalRefs: [] })),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
    }

    it('toggles link_pr list visibility without dropping the MCP session', async () => {
        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(false)
        const server = await startHappyServer(sessionClient(), {
            enableChangeTitle: false,
            awarenessPollMs: 0,
        })
        stopServer = server.stop
        expect(server.toolNames).toContain('link_pr')

        mcp = new Client({ name: 'hapi-awareness-dynamic', version: '1.0.0' })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))

        const offTools = await mcp.listTools()
        expect(offTools.tools.map((tool) => tool.name)).not.toContain('link_pr')

        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(true)
        // Any request re-syncs visibility; listTools is enough.
        const onTools = await mcp.listTools()
        expect(onTools.tools.map((tool) => tool.name)).toContain('link_pr')

        mockUpsertSessionExternalRef.mockResolvedValue({
            ok: true,
            status: 200,
            externalRefs: [{
                kind: 'github_pr',
                repo: 'tiann/hapi',
                number: 1163,
                url: 'https://github.com/tiann/hapi/pull/1163',
                role: 'primary',
                source: 'agent',
                linkedAt: 1
            }]
        })
        const linked = await mcp.callTool({
            name: 'link_pr',
            arguments: { url: 'https://github.com/tiann/hapi/pull/1163' }
        }) as ToolResult
        expect(linked.isError).toBeFalsy()

        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(false)
        const offAgain = await mcp.listTools()
        expect(offAgain.tools.map((tool) => tool.name)).not.toContain('link_pr')

        // Unrelated tools remain available on the same connection.
        expect(offAgain.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining([
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'ping_peer',
            'inspect_peer',
        ]))
    })

    it('does not emit tools/list_changed when awareness is unchanged', async () => {
        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(false)
        const server = await startHappyServer(sessionClient(), {
            enableChangeTitle: false,
            awarenessPollMs: 0,
        })
        stopServer = server.stop

        mcp = new Client({ name: 'hapi-awareness-idempotent', version: '1.0.0' })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        await mcp.listTools()

        let listChanged = 0
        mcp.setNotificationHandler(ToolListChangedNotificationSchema, () => {
            listChanged += 1
        })

        await mcp.listTools()
        await mcp.listTools()
        expect(listChanged).toBe(0)

        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(true)
        await mcp.listTools()
        expect(listChanged).toBe(1)

        await mcp.listTools()
        await mcp.listTools()
        expect(listChanged).toBe(1)
    })

    it('polls hub awareness so idle HTTP clients learn about flips', async () => {
        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(false)
        const server = await startHappyServer(sessionClient(), {
            enableChangeTitle: false,
            awarenessPollMs: 40,
            // Prove the poll path alone updates registration (no per-request sync).
            syncLinkPrOnRequest: false,
        })
        stopServer = server.stop

        mcp = new Client({ name: 'hapi-awareness-poll', version: '1.0.0' })
        await mcp.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        const baseline = await mcp.listTools()
        expect(baseline.tools.map((tool) => tool.name)).not.toContain('link_pr')

        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(true)
        await vi.waitFor(async () => {
            const onTools = await mcp!.listTools()
            expect(onTools.tools.map((tool) => tool.name)).toContain('link_pr')
        }, { timeout: 2000, interval: 50 })

        mockFetchGithubPrAwarenessEnabled.mockResolvedValue(false)
        await vi.waitFor(async () => {
            const offTools = await mcp!.listTools()
            expect(offTools.tools.map((tool) => tool.name)).not.toContain('link_pr')
        }, { timeout: 2000, interval: 50 })
    })
})

describe('startHappyServer change_title', () => {
    let stopServer: (() => void) | null
    let client: Client | null

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        client = null
        stopServer = null
    })

    async function connectChangeTitleServer(sessionClient: ApiSessionClient, options?: Parameters<typeof startHappyServer>[1]) {
        const server = await startHappyServer(sessionClient, options)
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-change-title-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return client
    }

    it('renames via metadata.name so spawn --name sessions update visibly', async () => {
        const updateMetadata = vi.fn()
        const sendClaudeSessionMessage = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()
        sendClaudeSessionMessage.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: '  Renamed triage peer  ' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(result.content?.[0]?.text).toContain('Successfully changed chat title to: "Renamed triage peer"')
        expect(updateMetadata).toHaveBeenCalledTimes(1)
        const handler = updateMetadata.mock.calls[0]?.[0] as (metadata: {
            path: string
            host: string
            name?: string
            summary?: { text: string }
        }) => {
            path: string
            host: string
            name?: string
            summary?: { text: string }
        }
        expect(handler({
            path: '/tmp',
            host: 'localhost',
            name: 'issue-triage-#54',
            summary: { text: 'stale' }
        })).toEqual({
            path: '/tmp',
            host: 'localhost',
            name: 'Renamed triage peer',
            summary: { text: 'stale' }
        })
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })

    it.each([false, true])('reports a user lock, including one acquired while the title write is pending (%s)', async (inFlight) => {
        let locked = !inFlight
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: () => ({ path: '/tmp', host: 'localhost', name: 'Pinned', titleLocked: locked }),
            flushMetadata: vi.fn(async () => { locked = true; return true }),
            sendAgentMessage: vi.fn()
        } as unknown as ApiSessionClient
        const onChangeTitle = vi.fn()
        const mcp = await connectChangeTitleServer(sessionClient, { onChangeTitle })
        updateMetadata.mockClear()
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Agent' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('locked by the user')
        expect(updateMetadata).toHaveBeenCalledTimes(inFlight ? 1 : 0)
        expect(onChangeTitle).not.toHaveBeenCalled()
    })

    it.each([1, 2])('does not acknowledge a rename when metadata flush %s fails', async (failedFlush) => {
        const onChangeTitle = vi.fn()
        let flushes = 0
        const sessionClient = {
            updateMetadata: vi.fn(),
            refreshMetadata: vi.fn(async () => true),
            getMetadata: () => null,
            flushMetadata: vi.fn(async () => {
                flushes++
                if (flushes === 2) expect(onChangeTitle).toHaveBeenCalledWith('Manual Title')
                return flushes !== failedFlush
            })
        } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient, { onChangeTitle })
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Manual Title' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(flushes).toBe(failedFlush)
        expect(onChangeTitle).toHaveBeenCalledTimes(failedFlush === 1 ? 0 : 1)
    })

    it('reports a user lock acquired while flushing manual-title precedence', async () => {
        let locked = false
        let flushes = 0
        const onChangeTitle = vi.fn()
        const sessionClient = {
            updateMetadata: vi.fn(),
            refreshMetadata: vi.fn(async () => true),
            getMetadata: () => ({ path: '/tmp', host: 'localhost', titleLocked: locked }),
            flushMetadata: vi.fn(async () => { locked = ++flushes === 2; return true })
        } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient, { onChangeTitle })
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Manual' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('locked by the user')
        expect(onChangeTitle).toHaveBeenCalledTimes(1)
    })

    it('refreshes a stale cached lock before allowing an explicit rename', async () => {
        let locked = true
        const sessionClient = {
            updateMetadata: vi.fn(), refreshMetadata: vi.fn(async () => { locked = false; return true }),
            getMetadata: () => ({ path: '/tmp', host: 'localhost', titleLocked: locked }),
            flushMetadata: vi.fn(async () => true), sendAgentMessage: vi.fn()
        } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient)
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Unlocked' } }) as ToolResult
        expect(result.isError).toBe(false)
        expect(sessionClient.refreshMetadata).toHaveBeenCalled()
    })

    it('fails without mutating when the Hub lock cannot be read', async () => {
        const updateMetadata = vi.fn()
        const sessionClient = { updateMetadata, refreshMetadata: vi.fn(async () => false), sendAgentMessage: vi.fn() } as unknown as ApiSessionClient
        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()
        const result = await mcp.callTool({ name: 'change_title', arguments: { title: 'Unknown' } }) as ToolResult
        expect(result.isError).toBe(true)
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('returns an error for blank titles instead of claiming success', async () => {
        const updateMetadata = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient)
        updateMetadata.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: '   ' }
        }) as ToolResult

        expect(result.isError).toBe(true)
        expect(result.content?.[0]?.text).toContain('Failed to change chat title')
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('does not write titles when emitTitleSummary is disabled (Codex child isolation)', async () => {
        const updateMetadata = vi.fn()
        const sendClaudeSessionMessage = vi.fn()
        const sessionClient = {
            updateMetadata,
            refreshMetadata: vi.fn(async () => true),
            getMetadata: vi.fn(() => null),
            flushMetadata: vi.fn(async () => true),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage
        } as unknown as ApiSessionClient

        const mcp = await connectChangeTitleServer(sessionClient, { emitTitleSummary: false })
        updateMetadata.mockClear()
        sendClaudeSessionMessage.mockClear()

        const result = await mcp.callTool({
            name: 'change_title',
            arguments: { title: 'Child Title' }
        }) as ToolResult

        expect(result.isError).toBe(false)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(sendClaudeSessionMessage).not.toHaveBeenCalled()
    })
})
describe('toClaudeAllowedHapiMcpTools', () => {
    it('keeps local-path and peer tools registered but out of Claude --allowedTools', () => {
        expect(toClaudeAllowedHapiMcpTools([
            'change_title',
            'link_issue',
            'link_pr',
            'display_image',
            'display_video',
            'display_media',
            'list_peers',
            'ping_peer',
            'inspect_peer',
            'spawn_peer',
            'session_job',
            'skill_lookup'
        ])).toEqual([
            'mcp__hapi__change_title',
            'mcp__hapi__link_issue',
            'mcp__hapi__display_image',
            'mcp__hapi__list_peers',
            'mcp__hapi__session_job',
            'mcp__hapi__skill_lookup'
        ])
        expect(toClaudeAllowedHapiMcpTools(['display_video'])).not.toContain('mcp__hapi__display_video')
        expect(toClaudeAllowedHapiMcpTools(['display_media'])).not.toContain('mcp__hapi__display_media')
    })

    // Regression (bot review, hapi#2147, same class found on the Claude side
    // while fixing the Codex bridge's equivalent gap): pre-approving link_pr
    // via --allowedTools would let Claude skip HAPI's permission handler
    // entirely, bypassing resolveToolAutoApprovalDecision's dedicated
    // read-only guard the same way the Codex bridge's `approval_mode:
    // 'approve'` did.
    it('keeps link_pr off --allowedTools so HAPI\'s read-only guard is reachable', () => {
        expect(toClaudeAllowedHapiMcpTools(['link_pr'])).not.toContain('mcp__hapi__link_pr')
    })
})

describe('resolveMcpSpawnPeerCwd', () => {
    it('prefers launcher workingDirectory over skillLookup and session path', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({
            workingDirectory: '/launcher/cwd',
            skillWorkingDirectory: '/skill/cwd',
            sessionPath: '/session/path',
        })).toBe('/launcher/cwd')
    })

    it('prefers skillLookup workingDirectory over session metadata path', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({
            skillWorkingDirectory: '/skill/cwd',
            sessionPath: '/session/path',
        })).toBe('/skill/cwd')
    })

    it('falls back to session metadata.path when skillLookup is absent', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({
            skillWorkingDirectory: undefined,
            sessionPath: '/session/path',
        })).toBe('/session/path')
        expect(resolveMcpSpawnPeerCwd({
            skillWorkingDirectory: '  ',
            sessionPath: '  /session/path  ',
        })).toBe('/session/path')
    })

    it('returns undefined when neither cwd source is available', async () => {
        const { resolveMcpSpawnPeerCwd } = await import('./startHappyServer')
        expect(resolveMcpSpawnPeerCwd({})).toBeUndefined()
    })
})

describe('startHappyServer peer tools kill switch', () => {
    const originalFlag = process.env.HAPI_DISABLE_PEER_TOOLS
    let client: Client | null
    let stopServer: (() => void) | null

    afterEach(async () => {
        await client?.close()
        stopServer?.()
        if (originalFlag === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = originalFlag
        }
    })

    async function startServer(options: Parameters<typeof startHappyServer>[1] = {}): Promise<{ url: string; toolNames: string[] }> {
        const sessionClient = {
            updateMetadata: vi.fn(),
            sendAgentMessage: vi.fn(),
            sendClaudeSessionMessage: vi.fn()
        } as unknown as ApiSessionClient
        const server = await startHappyServer(sessionClient, options)
        stopServer = server.stop
        client = new Client(
            { name: 'hapi-peer-tools-test', version: '1.0.0' },
            { capabilities: {} }
        )
        await client.connect(new StreamableHTTPClientTransport(new URL(server.url)))
        return { url: server.url, toolNames: server.toolNames }
    }


    it('supports a peer-only explicit tool allowlist', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        const { toolNames } = await startServer({
            enableChangeTitle: false,
            enabledTools: ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'],
        })
        expect(toolNames).toEqual(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'])
        const tools = await client!.listTools()
        expect(tools.tools.map((tool) => tool.name)).toEqual(expect.arrayContaining(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer']))
    })

    it('does not let the allowlist bypass HAPI_DISABLE_PEER_TOOLS', async () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
        await expect(startServer({
            enableChangeTitle: false,
            enabledTools: ['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer'],
        })).rejects.toThrow('startHappyServer requires at least one enabled tool')
    })
    it('registers peer tools by default', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        const { toolNames } = await startServer()
        expect(toolNames).toEqual(expect.arrayContaining(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer']))
        const tools = await client!.listTools()
        const names = tools.tools.map((tool) => tool.name)
        expect(names).toEqual(expect.arrayContaining(['list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer']))
    })

    it('omits peer tools from registration and toolNames when HAPI_DISABLE_PEER_TOOLS is set', async () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
        const { toolNames } = await startServer()
        // session_job is own-session (not peer) — stays available when peer tools are off.
        expect(toolNames).toEqual([
            'change_title',
            'link_pr',
            'link_issue',
            'display_image',
            'display_video',
            'display_media',
            'session_job',
        ])
        const tools = await client!.listTools()
        const names = tools.tools.map((tool) => tool.name)
        expect(names).not.toContain('list_peers')
        expect(names).not.toContain('ping_peer')
        expect(names).not.toContain('inspect_peer')
        expect(names).not.toContain('spawn_peer')
        expect(names).toEqual(expect.arrayContaining([
            'display_image',
            'display_video',
            'display_media',
            'session_job',
        ]))
    })
})
