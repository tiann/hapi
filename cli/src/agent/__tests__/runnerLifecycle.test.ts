import { describe, expect, it } from 'vitest'
import { setControlledByUser } from '../runnerLifecycle'
import type { ApiSessionClient } from '@/api/apiSession'

// Minimal stand-in that applies the update handlers and records the result, so
// we can assert how startingMode/controlledByUser evolve across mode changes.
function fakeSession() {
    const state = { agentState: {} as Record<string, unknown>, metadata: {} as Record<string, unknown> }
    const session = {
        updateAgentState: (h: (s: Record<string, unknown>) => Record<string, unknown>) => { state.agentState = h(state.agentState) },
        updateMetadata: (h: (m: Record<string, unknown>) => Record<string, unknown>) => { state.metadata = h(state.metadata) },
    }
    return { session: session as unknown as ApiSessionClient, state }
}

describe('setControlledByUser', () => {
    it('keeps a PTY launch identity across a pty → local → pty handoff', () => {
        const { session, state } = fakeSession()

        // Launch as PTY.
        setControlledByUser(session, 'pty')
        expect(state.metadata.startingMode).toBe('pty')
        expect(state.agentState.startingMode).toBe('pty')
        expect(state.agentState.controlledByUser).toBe(false)

        // Hand off to local — user is now driving locally, but the session is
        // still PTY-backed so its launch identity must not change.
        setControlledByUser(session, 'local')
        expect(state.metadata.startingMode).toBe('pty')
        expect(state.agentState.controlledByUser).toBe(true)

        // Hand back to PTY (reported as external mode 'remote'): the terminal
        // toggle must remain available, i.e. startingMode stays 'pty'.
        setControlledByUser(session, 'remote')
        expect(state.metadata.startingMode).toBe('pty')
        expect(state.agentState.startingMode).toBe('pty')
        expect(state.agentState.controlledByUser).toBe(false)
    })

    it('tracks the collaboration mode for a non-PTY session (unchanged behavior)', () => {
        const { session, state } = fakeSession()

        setControlledByUser(session, 'remote')
        expect(state.metadata.startingMode).toBe('remote')
        expect(state.agentState.controlledByUser).toBe(false)

        setControlledByUser(session, 'local')
        expect(state.metadata.startingMode).toBe('local')
        expect(state.agentState.controlledByUser).toBe(true)
    })
})
