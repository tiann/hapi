import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ApiSessionClient } from '@/api/apiSession'

const harness = vi.hoisted(() => ({
    startOptions: null as unknown,
    cliArgs: [] as string[]
}))

vi.mock('@/claude/utils/startHappyServer', () => ({
    startHappyServer: vi.fn(async (_client: unknown, options: { skillLookup?: unknown }) => {
        harness.startOptions = options
        return {
            url: 'http://127.0.0.1:43006/',
            toolNames: options.skillLookup
                ? ['change_title', 'display_image', 'skill_lookup']
                : ['change_title', 'display_image'],
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

describe('buildHapiMcpBridge skill lookup config', () => {
    const client = {} as ApiSessionClient

    beforeEach(() => {
        harness.startOptions = null
        harness.cliArgs = []
    })

    it('forwards the enabled HTTP tool through STDIO and auto-approves it', async () => {
        const skillLookup = {
            workingDirectory: '/repo',
            flavor: 'opencode'
        }

        const bridge = await buildHapiMcpBridge(client, { skillLookup })

        expect(harness.startOptions).toEqual({
            emitTitleSummary: undefined,
            skillLookup
        })
        expect(harness.cliArgs).toEqual([
            'mcp',
            '--url',
            'http://127.0.0.1:43006/',
            '--tools',
            'change_title,display_image,skill_lookup'
        ])
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' },
            skill_lookup: { approval_mode: 'approve' }
        })
    })

    it('does not expose skill_lookup for native-skill bridge callers', async () => {
        const bridge = await buildHapiMcpBridge(client)

        expect(harness.cliArgs.at(-1)).toBe('change_title,display_image')
        expect(bridge.mcpServers.hapi.tools).toEqual({
            change_title: { approval_mode: 'approve' }
        })
    })
})
