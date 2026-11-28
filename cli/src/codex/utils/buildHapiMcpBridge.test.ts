import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'
import { resolveToolAutoApprovalDecision } from '@/modules/common/permission/BasePermissionHandler'

const harness = vi.hoisted(() => ({
    startOptions: null as unknown,
    cliArgs: [] as string[],
    materialize: vi.fn(async () => true)
}))

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async (_client: unknown, options: { skillLookup?: unknown; enabledTools?: string[] }) => {
        harness.startOptions = options
        const defaultTools = options.skillLookup
            ? ['change_title', 'link_pr', 'link_issue', 'display_image', 'display_video', 'display_media', 'list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer', 'session_job', 'skill_lookup']
            : ['change_title', 'link_pr', 'link_issue', 'display_image', 'display_video', 'display_media', 'list_peers', 'ping_peer', 'inspect_peer', 'spawn_peer', 'session_job']
        const toolNames = options.enabledTools
            ? defaultTools.filter((name) => options.enabledTools!.includes(name))
            : defaultTools
        return {
            url: 'http://127.0.0.1:43006/',
            toolNames,
            stop: vi.fn()
        }
    })
}))

vi.mock('@/utils/spawnHappyCLI', () => ({
    getHappyCliCommand: vi.fn((args: string[]) => {
        harness.cliArgs = args
        return { command: 'hapi', args }
    })
}))

import { buildHapiMcpBridge } from './buildHapiMcpBridge'

function createClient(options?: { pending?: boolean; sessionId?: string }): ApiSessionClient {
    let pending = options?.pending ?? false
    return {
        sessionId: options?.sessionId ?? 'hub-session-1',
        isPending: () => pending,
        materialize: async () => {
            const ok = await harness.materialize()
            if (ok) {
                pending = false
            }
            return ok
        }
    } as unknown as ApiSessionClient
}

describe('buildHapiMcpBridge skill lookup config', () => {
    beforeEach(() => {
        harness.startOptions = null
        harness.cliArgs = []
        harness.materialize.mockReset()
        harness.materialize.mockResolvedValue(true)
        delete process.env[HAPI_SESSION_ID_ENV]
    })

    it('forwards the enabled HTTP tool through STDIO and auto-approves it', async () => {
        const skillLookup = {
            workingDirectory: '/repo',
            flavor: 'opencode'
        }

        const bridge = await buildHapiMcpBridge(createClient(), { skillLookup })

        expect(harness.startOptions).toEqual({
            emitTitleSummary: undefined,
            enableChangeTitle: undefined,
            enableLinkPr: undefined,
            workingDirectory: '/repo',
            skillLookup
        })
        expect(harness.cliArgs).toEqual([
            'mcp',
            '--url',
            'http://127.0.0.1:43006/',
            '--tools',
            'change_title,link_pr,link_issue,display_image,display_video,display_media,list_peers,ping_peer,inspect_peer,spawn_peer,session_job,skill_lookup',
            '--hapi-session-id',
            'hub-session-1',
        ])
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            link_pr: { approval_mode: 'prompt' },
            link_issue: { approval_mode: 'prompt' },
            display_image: { approval_mode: 'prompt' },
            display_video: { approval_mode: 'prompt' },
            display_media: { approval_mode: 'prompt' },
            list_peers: { approval_mode: 'approve' },
            session_job: { approval_mode: 'approve' },
            skill_lookup: { approval_mode: 'approve' }
        })
    })

    it('prompts for link_pr so read-only mode still consults the permission handler', async () => {
        const bridge = await buildHapiMcpBridge(createClient())
        const tools = bridge.mcpServers.hapi.tools

        expect(tools).toMatchObject({
            link_pr: { approval_mode: 'prompt' },
            change_title: { approval_mode: 'approve' },
        })
    })

    it('does not expose skill_lookup for native-skill bridge callers', async () => {
        const bridge = await buildHapiMcpBridge(createClient())

        expect(harness.cliArgs).toEqual([
            'mcp',
            '--url',
            'http://127.0.0.1:43006/',
            '--tools',
            'change_title,link_pr,link_issue,display_image,display_video,display_media,list_peers,ping_peer,inspect_peer,spawn_peer,session_job',
            '--hapi-session-id',
            'hub-session-1',
        ])
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            link_pr: { approval_mode: 'prompt' },
            link_issue: { approval_mode: 'prompt' },
            display_image: { approval_mode: 'prompt' },
            display_video: { approval_mode: 'prompt' },
            display_media: { approval_mode: 'prompt' },
            list_peers: { approval_mode: 'approve' },
            session_job: { approval_mode: 'approve' }
        })
    })

    // Regression (bot review, hapi#2147): `approve` here would let Codex
    // itself pre-approve every link_pr call before it ever reaches HAPI's
    // permission handler, silently bypassing resolveToolAutoApprovalDecision's
    // dedicated read-only guard below — `prompt` is what actually routes the
    // call through to that handler, which then auto-approves it in every
    // mode except read-only.
    it('configures link_pr for prompt (not approve) so HAPI\'s read-only guard is reachable', async () => {
        const bridge = await buildHapiMcpBridge(createClient())

        expect(bridge.mcpServers.hapi.tools?.link_pr).toEqual({ approval_mode: 'prompt' })
        // `trustedHapiMcp: true` simulates the context this prompt actually
        // arrives with (a real HAPI MCP transport, same as Codex's bridge) —
        // the guard must still refuse it in read-only even then.
        const trustedContext = { trustedHapiMcp: true }
        expect(resolveToolAutoApprovalDecision('read-only', 'link_pr', 'call-1', undefined, trustedContext)).toBeNull()
        expect(resolveToolAutoApprovalDecision('default', 'link_pr', 'call-1', undefined, trustedContext)).not.toBeNull()
    })

    // Regression (bot review, hapi#2147, third follow-up on the same gap):
    // link_issue mutates session metadata exactly like link_pr and is
    // unconditionally registered (no opt-in toggle) — `approve` here would
    // let Codex pre-approve it before it ever reaches HAPI's permission handler.
    it('configures link_issue for prompt (not approve) so HAPI\'s read-only guard is reachable', async () => {
        const bridge = await buildHapiMcpBridge(createClient())

        expect(bridge.mcpServers.hapi.tools?.link_issue).toEqual({ approval_mode: 'prompt' })
        const trustedContext = { trustedHapiMcp: true }
        expect(resolveToolAutoApprovalDecision('read-only', 'link_issue', 'call-1', undefined, trustedContext)).toBeNull()
    })

    it('materializes pending lazy sessions before starting the MCP server', async () => {
        const client = createClient({ pending: true, sessionId: 'lazy-session-1' })

        await buildHapiMcpBridge(client)

        expect(harness.materialize).toHaveBeenCalledOnce()
        expect(process.env[HAPI_SESSION_ID_ENV]).toBe('lazy-session-1')
        expect(client.isPending()).toBe(false)
    })

    it('fails closed when pending materialization fails', async () => {
        harness.materialize.mockResolvedValue(false)
        const client = createClient({ pending: true, sessionId: 'lazy-session-fail' })

        await expect(buildHapiMcpBridge(client)).rejects.toThrow(
            'Failed to materialize HAPI session lazy-session-fail before MCP bridge start'
        )
        expect(process.env[HAPI_SESSION_ID_ENV]).toBeUndefined()
    })

    it('restricts registered server tools and bridge config when enabledTools is provided', async () => {
        const bridge = await buildHapiMcpBridge(createClient(), {
            workingDirectory: '/repo',
            skillLookup: { workingDirectory: '/repo', flavor: 'agy' },
            enabledTools: ['change_title', 'session_job', 'skill_lookup']
        })

        expect(harness.startOptions).toMatchObject({
            workingDirectory: '/repo',
            skillLookup: { workingDirectory: '/repo', flavor: 'agy' },
            enabledTools: ['change_title', 'session_job', 'skill_lookup']
        })
        const toolsFlagIdx = harness.cliArgs.indexOf('--tools')
        expect(harness.cliArgs[toolsFlagIdx + 1]).toBe('change_title,session_job,skill_lookup')
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            session_job: { approval_mode: 'approve' },
            skill_lookup: { approval_mode: 'approve' }
        })
    })
})
