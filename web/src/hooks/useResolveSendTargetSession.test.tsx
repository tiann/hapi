import { describe, expect, it, vi } from 'vitest'
import {
    describeResolveSendTargetSession,
    getResolveSendTargetSessionFailureToast,
    useResolveSendTargetSession
} from './useResolveSendTargetSession'
import type { ApiClient } from '@/api/client'
import type { DecryptedMessage, Session } from '@/types/api'

function makeApi() {
    return {
        resumeSession: vi.fn(async () => 'session-resolved'),
        takeoverSession: vi.fn(async () => 'session-runner')
    } as unknown as ApiClient
}

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        active: true,
        thinking: false,
        metadata: {
            path: '/tmp/project',
            host: 'localhost',
            flavor: 'codex',
            mirrorSource: 'codex-desktop-sync',
            executionControl: {
                owner: 'desktop-sync',
                generation: 1,
                leaseExpiresAt: null,
                runnerSessionId: null,
                updatedAt: 1
            }
        },
        ...overrides
    } as Session
}

function makeDesktopMirrorMessage(): DecryptedMessage {
    return {
        id: 'msg-1',
        seq: 1,
        localId: 'codex:thread-1:12:abc123',
        content: {
            role: 'user',
            content: { type: 'text', text: 'mirrored from desktop' }
        },
        createdAt: Date.now(),
        status: 'sent'
    } as DecryptedMessage
}

describe('useResolveSendTargetSession', () => {
    it('takes over an active desktop-owned mirror session before send', async () => {
        const api = makeApi()
        const result = useResolveSendTargetSession(api, makeSession(), [])

        await expect(result.resolve('session-1')).resolves.toBe('session-runner')
        expect(api.takeoverSession).toHaveBeenCalledWith('session-1')
        expect(api.resumeSession).not.toHaveBeenCalled()
    })

    it('takes over a message-only desktop mirror session before send', async () => {
        const api = makeApi()
        const session = makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex'
            }
        })
        const result = useResolveSendTargetSession(api, session, [makeDesktopMirrorMessage()])

        await expect(result.resolve('session-1')).resolves.toBe('session-runner')
        expect(api.takeoverSession).toHaveBeenCalledWith('session-1')
        expect(api.resumeSession).not.toHaveBeenCalled()
    })

    it('resumes an inactive native session before send', async () => {
        const api = makeApi()
        const session = makeSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        })
        const result = useResolveSendTargetSession(api, session, [])

        await expect(result.resolve('session-1')).resolves.toBe('session-resolved')
        expect(api.resumeSession).toHaveBeenCalledWith('session-1')
        expect(api.takeoverSession).not.toHaveBeenCalled()
    })

    it('does nothing for an already-active native hapi session', async () => {
        const api = makeApi()
        const session = makeSession({ metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' } })
        const result = useResolveSendTargetSession(api, session, [])

        await expect(result.resolve('session-1')).resolves.toBe('session-1')
        expect(api.resumeSession).not.toHaveBeenCalled()
        expect(api.takeoverSession).not.toHaveBeenCalled()
    })
})

describe('describeResolveSendTargetSession', () => {
    it('describes takeover for a desktop mirror owned by desktop sync', () => {
        expect(describeResolveSendTargetSession(makeSession(), [])).toEqual({ action: 'takeover' })
    })

    it('describes takeover for a message-only desktop mirror without execution control', () => {
        expect(describeResolveSendTargetSession(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        }), [makeDesktopMirrorMessage()])).toEqual({ action: 'takeover' })
    })

    it('describes resume for an inactive non-mirror session', () => {
        expect(describeResolveSendTargetSession(makeSession({
            active: false,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        }), [])).toEqual({ action: 'resume' })
    })

    it('describes native HAPI runner sessions as resumable rather than desktop takeover targets', () => {
        expect(describeResolveSendTargetSession(makeSession({
            active: false,
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'codex',
                startedFromRunner: true,
                startedBy: 'runner'
            }
        }), [makeDesktopMirrorMessage()])).toEqual({ action: 'resume' })
    })

    it('describes none for an active native session', () => {
        expect(describeResolveSendTargetSession(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' }
        }), [])).toEqual({ action: 'none' })
    })
})

describe('getResolveSendTargetSessionFailureToast', () => {
    it('formats takeover failures for a visible toast', () => {
        expect(getResolveSendTargetSessionFailureToast('takeover', new Error('runner busy'))).toEqual({
            title: 'Takeover failed',
            body: 'runner busy'
        })
    })

    it('formats resume failures for a visible toast', () => {
        expect(getResolveSendTargetSessionFailureToast('resume', new Error('session offline'))).toEqual({
            title: 'Resume failed',
            body: 'session offline'
        })
    })
})
