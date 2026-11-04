import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildGrokLocalArgs, grokLocal } from './grokLocal'
import { spawnWithTerminalGuard } from '@/utils/spawnWithTerminalGuard'
import { getAgentLaunchCommand } from '@/agent/agentLaunchCommand'
import { resetPeerToolsForTests } from '@/modules/common/peerTools'

vi.mock('@/utils/spawnWithTerminalGuard', () => ({
    spawnWithTerminalGuard: vi.fn(async () => {})
}))

vi.mock('@/agent/agentLaunchCommand', () => ({
    getAgentLaunchCommand: vi.fn(() => 'grok')
}))

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
})

function setWindowsPlatform(): void {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
}

describe('buildGrokLocalArgs', () => {
    it('uses a caller-supplied id for a new native session', () => {
        expect(buildGrokLocalArgs({
            sessionId: '11111111-1111-4111-8111-111111111111',
            resume: false
        })).toEqual([
            '--session-id', '11111111-1111-4111-8111-111111111111'
        ])
    })

    it('resumes with low effort and plan mode using official Grok flags', () => {
        expect(buildGrokLocalArgs({
            sessionId: 'grok-session-1',
            resume: true,
            model: 'grok-4.5',
            effort: 'low',
            permissionMode: 'plan'
        })).toEqual([
            '--resume', 'grok-session-1',
            '--model', 'grok-4.5',
            '--reasoning-effort', 'low',
            '--permission-mode', 'plan'
        ])
    })

    it('rejects shell metacharacters in dynamic Windows arguments', () => {
        setWindowsPlatform()

        expect(() => buildGrokLocalArgs({
            sessionId: 'session&whoami',
            resume: true
        })).toThrow('Invalid sessionId')
        expect(() => buildGrokLocalArgs({
            sessionId: 'session-1',
            resume: true,
            model: 'grok|whoami'
        })).toThrow('Invalid model')
        expect(() => buildGrokLocalArgs({
            sessionId: 'session-1',
            resume: true,
            effort: 'low%PATH%'
        })).toThrow('Invalid effort')
    })
})

describe('grokLocal peer-tools child env (#2056)', () => {
    const original = process.env.HAPI_DISABLE_PEER_TOOLS

    afterEach(() => {
        if (original === undefined) {
            delete process.env.HAPI_DISABLE_PEER_TOOLS
        } else {
            process.env.HAPI_DISABLE_PEER_TOOLS = original
        }
        resetPeerToolsForTests()
        vi.mocked(spawnWithTerminalGuard).mockClear()
    })

    async function spawnedEnv(): Promise<NodeJS.ProcessEnv> {
        const call = vi.mocked(spawnWithTerminalGuard).mock.calls.at(-1)
        expect(call).toBeDefined()
        return call![0].env ?? {}
    }

    it('pins the disabled session snapshot into the child env', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        await grokLocal({
            sessionId: 'grok-session-1',
            resume: false,
            path: '/work',
            abort: new AbortController().signal,
            peerToolsDisabled: true
        })
        expect((await spawnedEnv()).HAPI_DISABLE_PEER_TOOLS).toBe('1')
    })

    it('pins an explicit enabled snapshot so later global flips cannot rewrite the child', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        await grokLocal({
            sessionId: 'grok-session-1',
            resume: false,
            path: '/work',
            abort: new AbortController().signal,
            peerToolsDisabled: false
        })
        expect((await spawnedEnv()).HAPI_DISABLE_PEER_TOOLS).toBe('0')
    })

    it('keeps a machine-level deploy override authoritative over the snapshot', async () => {
        process.env.HAPI_DISABLE_PEER_TOOLS = '1'
        await grokLocal({
            sessionId: 'grok-session-1',
            resume: false,
            path: '/work',
            abort: new AbortController().signal,
            peerToolsDisabled: false
        })
        expect((await spawnedEnv()).HAPI_DISABLE_PEER_TOOLS).toBe('1')
    })

    it('falls back to the module state when no snapshot was captured', async () => {
        delete process.env.HAPI_DISABLE_PEER_TOOLS
        await grokLocal({
            sessionId: 'grok-session-1',
            resume: false,
            path: '/work',
            abort: new AbortController().signal
        })
        expect((await spawnedEnv()).HAPI_DISABLE_PEER_TOOLS).toBe('0')
    })
})
