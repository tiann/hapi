import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'
import { HAPI_SESSION_ID_ENV } from '@/agent/hapiSessionEnv'

const harness = vi.hoisted(() => ({
    startOptions: null as unknown,
    cliArgs: [] as string[],
    materialize: vi.fn(async () => true)
}))

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async (_client: unknown, options: { skillLookup?: unknown }) => {
        harness.startOptions = options
        return {
            url: 'http://127.0.0.1:43006/',
            toolNames: options.skillLookup
                ? ['change_title', 'display_image', 'display_video', 'skill_lookup']
                : ['change_title', 'display_image', 'display_video'],
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
            skillLookup
        })
        expect(harness.cliArgs).toEqual([
            'mcp',
            '--url',
            'http://127.0.0.1:43006/',
            '--tools',
            'change_title,display_image,display_video,skill_lookup'
        ])
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            display_image: { approval_mode: 'prompt' },
            display_video: { approval_mode: 'prompt' },
            skill_lookup: { approval_mode: 'approve' }
        })
    })

    it('does not expose skill_lookup for native-skill bridge callers', async () => {
        const bridge = await buildHapiMcpBridge(createClient())

        expect(harness.cliArgs.at(-1)).toBe('change_title,display_image,display_video')
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            display_image: { approval_mode: 'prompt' },
            display_video: { approval_mode: 'prompt' }
        })
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
})
