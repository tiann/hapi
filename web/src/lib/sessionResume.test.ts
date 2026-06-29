import { describe, expect, it } from 'vitest'
import type { Session } from '@/types/api'
import { inactiveSessionCanResume, resolveAgentSessionIdFromMetadata } from './sessionResume'

function makeSession(overrides: Partial<Session> = {}): Session {
    return {
        id: 'session-1',
        active: false,
        thinking: false,
        activeAt: 0,
        updatedAt: 0,
        metadata: { path: '/tmp/project', host: 'localhost', flavor: 'cursor' },
        ...overrides,
    } as Session
}

describe('sessionResume', () => {
    it('resolveAgentSessionIdFromMetadata picks the id matching the session flavor', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'codex',
            codexSessionId: 'codex-1',
            cursorSessionId: 'cursor-1',
        })).toBe('codex-1')
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'cursor',
            cursorSessionId: 'cursor-1',
        })).toBe('cursor-1')
    })

    it('resolveAgentSessionIdFromMetadata returns ompSessionId for omp flavor', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'omp',
            ompSessionId: 'omp-1',
            // cross-flavor ids must be ignored
            codexSessionId: 'codex-1',
        })).toBe('omp-1')
    })

    it('resolveAgentSessionIdFromMetadata ignores stale cross-flavor ids', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'cursor',
            codexSessionId: 'codex-1',
        })).toBeUndefined()
    })

    it('resolveAgentSessionIdFromMetadata defaults to claude when flavor is missing', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            claudeSessionId: 'claude-1',
        })).toBe('claude-1')
    })

    it('inactiveSessionCanResume is true for active sessions', () => {
        expect(inactiveSessionCanResume(makeSession({ active: true }), 0)).toBe(true)
    })

    it('inactiveSessionCanResume allows fresh spawn when no agent id and no messages', () => {
        expect(inactiveSessionCanResume(makeSession(), 0)).toBe(true)
    })

    it('inactiveSessionCanResume allows resume when agent id exists', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                cursorSessionId: 'cursor-thread-1',
            },
        }), 5)).toBe(true)
    })

    it('resolveAgentSessionIdFromMetadata still returns cursorSessionId regardless of protocol', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'cursor',
            cursorSessionId: 'acp-thread-1',
            cursorSessionProtocol: 'acp',
        })).toBe('acp-thread-1')
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'cursor',
            cursorSessionId: 'legacy-thread-1',
            cursorSessionProtocol: 'stream-json',
        })).toBe('legacy-thread-1')
    })

    it('inactiveSessionCanResume rejects inactive sessions with messages but no agent id', () => {
        expect(inactiveSessionCanResume(makeSession(), 3)).toBe(false)
    })

    it('inactiveSessionCanResume rejects when stale cross-flavor agent id is present but no messages', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                codexSessionId: 'stale-codex-1',
            },
        }), 0)).toBe(true)
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'cursor',
                codexSessionId: 'stale-codex-1',
            },
        }), 3)).toBe(false)
    })

    it('inactiveSessionCanResume rejects when metadata path is missing', () => {
        expect(inactiveSessionCanResume(makeSession({ metadata: { path: '', host: 'localhost' } }), 0)).toBe(false)
    })

    it('inactiveSessionCanResume allows claude resume by message recovery when no claudeSessionId is stored', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'claude' },
        }), 3)).toBe(true)
    })

    it('inactiveSessionCanResume allows claude recovery when flavor is missing (defaults to claude)', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost' },
        }), 3)).toBe(true)
    })

    it('inactiveSessionCanResume rejects non-claude flavors with messages but no flavor-specific id (no recovery path)', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'codex' },
        }), 3)).toBe(false)
    })
})

describe('sessionResume — pi flavor', () => {
    it('resolveAgentSessionIdFromMetadata returns piSessionId when flavor is pi', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'pi',
            piSessionId: 'pi-sess-123',
        })).toBe('pi-sess-123')
    })

    it('resolveAgentSessionIdFromMetadata returns undefined when flavor is pi but no piSessionId', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'pi',
        })).toBeUndefined()
    })

    it('resolveAgentSessionIdFromMetadata ignores stale cross-flavor ids when flavor is pi', () => {
        // Stale ids from other flavors must not satisfy a Pi resume — hub
        // will reject them and the web layer would otherwise claim the
        // session is resumable.
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'pi',
            claudeSessionId: 'claude-stale',
            codexSessionId: 'codex-stale',
        })).toBeUndefined()
    })

    it('resolveAgentSessionIdFromMetadata prefers piSessionId over other ids when flavor is pi', () => {
        // Defensive: even if a stale id slipped in, the pi id should win.
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p',
            host: 'h',
            flavor: 'pi',
            piSessionId: 'pi-sess-real',
            claudeSessionId: 'claude-stale',
        })).toBe('pi-sess-real')
    })

    it('inactiveSessionCanResume allows resume of pi session when piSessionId is present', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'pi',
                piSessionId: 'pi-sess-abc',
            },
        }), 0)).toBe(true)
    })

    it('inactiveSessionCanResume allows fresh pi spawn when path is set and there are no messages', () => {
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
        }), 0)).toBe(true)
    })

    it('inactiveSessionCanResume rejects inactive pi session with messages but no piSessionId (no Pi recovery fallback)', () => {
        // Pi does not have a recover-from-messages path the way Claude does.
        // If the cli lost the session id, the user must start a new session
        // (or click resume in the cli to re-establish the id).
        expect(inactiveSessionCanResume(makeSession({
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
        }), 3)).toBe(false)
    })

    it('inactiveSessionCanResume rejects pi session whose only id is a stale cross-flavor id', () => {
        // Stale codexSessionId alone does NOT satisfy Pi resume.
        expect(inactiveSessionCanResume(makeSession({
            metadata: {
                path: '/tmp/project',
                host: 'localhost',
                flavor: 'pi',
                codexSessionId: 'stale-codex',
            },
        }), 3)).toBe(false)
    })

    it('inactiveSessionCanResume allows active pi session unconditionally', () => {
        expect(inactiveSessionCanResume(makeSession({
            active: true,
            metadata: { path: '/tmp/project', host: 'localhost', flavor: 'pi' },
        }), 3)).toBe(true)
    })
})

describe('sessionResume — regression for all other flavor ids', () => {
    // Every flavor-specific id resolver must still work; the switch in
    // sessionResume.ts grew a new 'pi' branch and the existing branches
    // must not be regressed.
    it('codex', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'codex', codexSessionId: 'cx-1',
        })).toBe('cx-1')
    })
    it('gemini', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'gemini', geminiSessionId: 'gm-1',
        })).toBe('gm-1')
    })
    it('opencode', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'opencode', opencodeSessionId: 'oc-1',
        })).toBe('oc-1')
    })
    it('cursor', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'cursor', cursorSessionId: 'cu-1',
        })).toBe('cu-1')
    })
    it('kimi', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'kimi', kimiSessionId: 'ki-1',
        })).toBe('ki-1')
    })
    it('claude (default branch)', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'claude', claudeSessionId: 'cl-1',
        })).toBe('cl-1')
    })
    it('unknown flavor falls back to claude branch', () => {
        expect(resolveAgentSessionIdFromMetadata({
            path: '/p', host: 'h', flavor: 'mystery', claudeSessionId: 'cl-1',
        })).toBe('cl-1')
    })
})
