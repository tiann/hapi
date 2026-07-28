import { afterEach, describe, expect, it } from 'vitest'
import { buildGrokLocalArgs } from './grokLocal'

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
