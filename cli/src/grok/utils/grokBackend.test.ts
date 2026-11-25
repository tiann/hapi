import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const constructorCalls: Array<Record<string, unknown>> = []

vi.mock('@/agent/backends/acp', () => ({
    AcpSdkBackend: vi.fn().mockImplementation(function (
        this: unknown,
        opts: Record<string, unknown>
    ) {
        constructorCalls.push(opts)
        return { __opts: opts }
    })
}))

import {
    buildGrokAgentArgs,
    createGrokBackend,
    formatGrokError,
    isGrokBuildAuxiliaryQuotaError
} from './grokBackend'

const originalPlatformDescriptor = Object.getOwnPropertyDescriptor(process, 'platform')

afterEach(() => {
    if (originalPlatformDescriptor) {
        Object.defineProperty(process, 'platform', originalPlatformDescriptor)
    }
})

function setWindowsPlatform(): void {
    Object.defineProperty(process, 'platform', { value: 'win32', configurable: true })
}

describe('buildGrokAgentArgs', () => {
    it('starts the official Grok ACP stdio agent', () => {
        expect(buildGrokAgentArgs({ cwd: '/tmp/project' })).toEqual([
            '--cwd', '/tmp/project', 'agent', 'stdio'
        ])
    })

    it('places agent options before the stdio subcommand', () => {
        expect(buildGrokAgentArgs({
            cwd: '/tmp/project',
            model: 'grok-4.5',
            effort: 'low'
        })).toEqual([
            '--cwd', '/tmp/project',
            'agent',
            '--model', 'grok-4.5',
            '--reasoning-effort', 'low',
            'stdio'
        ])
    })

    it('rejects dynamic shell metacharacters before a Windows ACP spawn', () => {
        setWindowsPlatform()

        expect(() => buildGrokAgentArgs({ cwd: 'C:\\repo&whoami' })).toThrow('Invalid cwd')
        expect(() => buildGrokAgentArgs({
            cwd: 'C:\\repo',
            model: 'grok|whoami'
        })).toThrow('Invalid model')
        expect(() => buildGrokAgentArgs({
            cwd: 'C:\\repo',
            effort: 'low%PATH%'
        })).toThrow('Invalid effort')
    })
})

describe('createGrokBackend', () => {
    beforeEach(() => {
        constructorCalls.length = 0
    })

    it('concatenates ACP text chunks as deltas instead of overlap-deduping them', () => {
        createGrokBackend({ cwd: '/tmp/project', model: 'grok-4.6' })
        expect(constructorCalls).toHaveLength(1)
        expect(constructorCalls[0]?.textChunkMode).toBe('delta')
        expect(constructorCalls[0]?.flavor).toBe('grok')
        expect(constructorCalls[0]?.args).toEqual([
            '--cwd', '/tmp/project',
            'agent',
            '--model', 'grok-4.6',
            'stdio'
        ])
    })
})

describe('formatGrokError', () => {
    it('turns ACP auth failures into an actionable login hint', () => {
        expect(formatGrokError(new Error('Authentication required: no auth method id provided')))
            .toContain('grok login --device-auth')
    })

    it('preserves unrelated Grok errors', () => {
        expect(formatGrokError(new Error('Payment Required'))).toBe('Payment Required')
    })

    it('strips terminal color codes from surfaced errors', () => {
        expect(formatGrokError('\u001b[31mERROR\u001b[0m Payment Required'))
            .toBe('ERROR Payment Required')
    })
})

describe('isGrokBuildAuxiliaryQuotaError', () => {
    const auxiliary402 = [
        '\u001b[31mERROR\u001b[0m responses API error status=402 Payment Required',
        'personal-team-blocked:spending-limit: You have run out of credits or need a Grok subscription.',
        'model_id=grok-build'
    ].join(' ')

    it('recognizes the non-fatal grok-build side request when another model is active', () => {
        expect(isGrokBuildAuxiliaryQuotaError(auxiliary402, 'grok-4.5')).toBe(true)
    })

    it('does not hide a quota error when grok-build is the active model', () => {
        expect(isGrokBuildAuxiliaryQuotaError(auxiliary402, 'grok-build')).toBe(false)
    })

    it('does not hide unrelated 402 errors', () => {
        expect(isGrokBuildAuxiliaryQuotaError(
            'status=402 Payment Required model_id=grok-4.5 spending-limit',
            'grok-4.5'
        )).toBe(false)
    })
})
