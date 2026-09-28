import { describe, expect, it, vi } from 'vitest'
import { Session } from './session'
import { resolveClaudeLocalResumeGuardId } from './utils/claudeResumeGuard'

function makeSession(opts: {
    sessionId: string | null
    claudeArgs?: string[]
}) {
    const metadata: Record<string, unknown> = {
        claudeSessionId: opts.sessionId ?? undefined
    }
    const updateMetadata = vi.fn((handler: (meta: Record<string, unknown>) => Record<string, unknown>) => {
        Object.assign(metadata, handler(metadata))
        return metadata
    })
    const sendSessionEvent = vi.fn()
    const session = new Session({
        api: {} as never,
        client: {
            updateMetadata,
            keepAlive() {},
            emitMessagesConsumed() {},
            sendSessionEvent,
            getMetadata: () => metadata
        } as never,
        path: '/tmp',
        logPath: '/tmp/test.log',
        sessionId: opts.sessionId,
        claudeArgs: opts.claudeArgs,
        mcpServers: {},
        messageQueue: { onBatchConsumed: null } as never,
        onModeChange: () => {},
        startedBy: 'runner',
        startingMode: 'remote',
        hookSettingsPath: '/tmp/hooks.json'
    })
    return { session, metadata, updateMetadata, sendSessionEvent }
}

describe('Session.onSessionFound resume mismatch (#1933)', () => {
    it('does not overwrite claudeSessionId when resume requested A and Claude reports B', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const minted = '3e0eb081-1111-4111-8111-111111111111'
        const { session, metadata, updateMetadata, sendSessionEvent } = makeSession({
            sessionId: requested
        })

        session.onSessionFound(minted)

        // Live process may be on B for transport; durable resume pointer stays A.
        expect(session.sessionId).toBe(minted)
        expect(metadata.claudeSessionId).toBe(requested)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('resume mismatch')
        }))
    })

    it('still adopts a forked child id when --fork-session was requested', () => {
        const parent = 'parent-session-id'
        const child = 'child-session-id'
        const { session, metadata, updateMetadata } = makeSession({
            sessionId: parent,
            claudeArgs: ['--resume', parent, '--fork-session']
        })

        session.onSessionFound(child, { forkedFrom: parent })

        expect(session.sessionId).toBe(child)
        expect(metadata.claudeSessionId).toBe(child)
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('adopts a matching resume id', () => {
        const id = 'same-session-id'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: id })

        session.onSessionFound(id)

        expect(session.sessionId).toBe(id)
        expect(metadata.claudeSessionId).toBe(id)
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('allows a later /clear-style SessionStart to mint a new id after resume adopted', () => {
        const resumed = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const afterClear = 'aaaaaaaa-1111-4111-8111-111111111111'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: resumed })

        session.onSessionFound(resumed)
        expect(metadata.claudeSessionId).toBe(resumed)

        updateMetadata.mockClear()
        session.onSessionFound(afterClear)

        expect(session.sessionId).toBe(afterClear)
        expect(metadata.claudeSessionId).toBe(afterClear)
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('releases the guard when local resume re-emits the same SessionStart id', () => {
        const resumed = 'bbbbbbbb-2222-4222-8222-222222222222'
        const afterClear = 'cccccccc-3333-4333-8333-333333333333'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: resumed })

        // Local successful --resume often skips onSessionFound (same id).
        session.confirmResumeSessionId(resumed)
        updateMetadata.mockClear()
        session.onSessionFound(afterClear)

        expect(session.sessionId).toBe(afterClear)
        expect(metadata.claudeSessionId).toBe(afterClear)
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('on mismatch still notifies listeners for local transport without burning metadata', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const minted = '3e0eb081-1111-4111-8111-111111111111'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: requested })
        const found: string[] = []
        session.addSessionFoundCallback((id) => found.push(id))

        session.onSessionFound(minted)

        expect(metadata.claudeSessionId).toBe(requested)
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(session.sessionId).toBe(minted)
        expect(found).toEqual([minted])
    })

    it('keeps the guard armed after mismatch so a second B cannot burn metadata', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const minted = '3e0eb081-1111-4111-8111-111111111111'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: requested })

        session.onSessionFound(minted)
        updateMetadata.mockClear()
        session.onSessionFound(minted)

        expect(metadata.claudeSessionId).toBe(requested)
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('guards resumes supplied only via --resume in claudeArgs', () => {
        const requested = 'aaaaaaaa-1111-4111-8111-111111111111'
        const minted = 'bbbbbbbb-2222-4222-8222-222222222222'
        const { session, metadata, updateMetadata, sendSessionEvent } = makeSession({
            sessionId: null,
            claudeArgs: ['--resume', requested]
        })

        session.onSessionFound(minted)

        expect(metadata.claudeSessionId).toBeUndefined()
        expect(updateMetadata).not.toHaveBeenCalled()
        expect(sendSessionEvent).toHaveBeenCalledWith(expect.objectContaining({
            type: 'message',
            message: expect.stringContaining('resume mismatch')
        }))
    })

    it('rearms the guard before a later launch so a mismatched relaunch cannot burn metadata', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const minted = '3e0eb081-1111-4111-8111-111111111111'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: requested })

        session.onSessionFound(requested)
        expect(metadata.claudeSessionId).toBe(requested)
        updateMetadata.mockClear()

        session.armResumeGuard(requested)
        session.onSessionFound(minted)

        expect(metadata.claudeSessionId).toBe(requested)
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('keeps the durable resume target after mismatch so a B-live relaunch cannot burn A', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const minted = '3e0eb081-1111-4111-8111-111111111111'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: requested })

        session.onSessionFound(minted)
        expect(session.sessionId).toBe(minted)
        expect(metadata.claudeSessionId).toBe(requested)
        expect(session.getClaudeResumeSessionId()).toBe(requested)
        updateMetadata.mockClear()

        session.armResumeGuard(session.getClaudeResumeSessionId())
        session.onSessionFound(minted)

        expect(metadata.claudeSessionId).toBe(requested)
        expect(updateMetadata).not.toHaveBeenCalled()
    })

    it('local arm accepts an explicit --resume id that differs from the stored id', () => {
        const stored = 'aaaaaaaa-1111-4111-8111-111111111111'
        const selected = 'bbbbbbbb-2222-4222-8222-222222222222'
        const { session, metadata, updateMetadata } = makeSession({
            sessionId: stored,
            claudeArgs: ['--resume', selected]
        })

        session.armResumeGuard(resolveClaudeLocalResumeGuardId(stored, ['--resume', selected]))
        session.onSessionFound(selected)

        expect(metadata.claudeSessionId).toBe(selected)
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('local arm does not guard when --continue overrides a stored id', () => {
        const stored = 'aaaaaaaa-1111-4111-8111-111111111111'
        const continued = 'cccccccc-3333-4333-8333-333333333333'
        const { session, metadata, updateMetadata } = makeSession({
            sessionId: stored,
            claudeArgs: ['--continue']
        })

        session.armResumeGuard(resolveClaudeLocalResumeGuardId(stored, ['--continue']))
        session.onSessionFound(continued)

        expect(metadata.claudeSessionId).toBe(continued)
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('clears durable metadata resume id on /clear so the next launch starts fresh', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const { session, metadata, updateMetadata } = makeSession({ sessionId: requested })

        session.onSessionFound(requested)
        expect(metadata.claudeSessionId).toBe(requested)
        updateMetadata.mockClear()

        session.clearSessionId()

        expect(session.sessionId).toBeNull()
        expect(metadata.claudeSessionId).toBeUndefined()
        expect(session.getClaudeResumeSessionId()).toBeNull()
        expect(updateMetadata).toHaveBeenCalled()
    })

    it('ignores stale metadata.claudeSessionId immediately after /clear', () => {
        const requested = 'c66b46bc-7647-491a-9cd4-06ba640b9910'
        const metadata: Record<string, unknown> = { claudeSessionId: requested }
        const updateMetadata = vi.fn((_handler: (meta: Record<string, unknown>) => Record<string, unknown>) => {
            // Simulate delayed hub ACK: local metadata view still has A.
            return metadata
        })
        const session = new Session({
            api: {} as never,
            client: {
                updateMetadata,
                keepAlive() {},
                emitMessagesConsumed() {},
                sendSessionEvent: vi.fn(),
                getMetadata: () => metadata
            } as never,
            path: '/tmp',
            logPath: '/tmp/test.log',
            sessionId: requested,
            mcpServers: {},
            messageQueue: { onBatchConsumed: null } as never,
            onModeChange: () => {},
            startedBy: 'runner',
            startingMode: 'remote',
            hookSettingsPath: '/tmp/hooks.json'
        })

        session.clearSessionId()

        expect(session.getClaudeResumeSessionId()).toBeNull()
    })

    it('prefers a newly adopted id over stale metadata still returning A', () => {
        const previous = 'aaaaaaaa-1111-4111-8111-111111111111'
        const adopted = 'bbbbbbbb-2222-4222-8222-222222222222'
        const metadata: Record<string, unknown> = { claudeSessionId: previous }
        const session = new Session({
            api: {} as never,
            client: {
                updateMetadata: vi.fn((handler: (meta: Record<string, unknown>) => Record<string, unknown>) => {
                    // Delayed ACK: leave metadata at previous.
                    void handler
                    return metadata
                }),
                keepAlive() {},
                emitMessagesConsumed() {},
                sendSessionEvent: vi.fn(),
                getMetadata: () => metadata
            } as never,
            path: '/tmp',
            logPath: '/tmp/test.log',
            sessionId: previous,
            mcpServers: {},
            messageQueue: { onBatchConsumed: null } as never,
            onModeChange: () => {},
            startedBy: 'runner',
            startingMode: 'remote',
            hookSettingsPath: '/tmp/hooks.json'
        })

        session.armResumeGuard(null)
        session.onSessionFound(adopted)

        expect(session.getClaudeResumeSessionId()).toBe(adopted)
        expect(metadata.claudeSessionId).toBe(previous)
    })
})
