import { describe, expect, it } from 'vitest'
import { canChangeSessionPermissionMode } from './session-config-controls'

describe('session config controls', () => {
    it('does not offer permission changes for a locally controlled session', () => {
        expect(canChangeSessionPermissionMode({
            active: true,
            agentState: {
                controlledByUser: true,
                requests: {},
                completedRequests: {},
            },
        })).toBe(false)
    })

    it('offers permission changes only for active remote sessions', () => {
        expect(canChangeSessionPermissionMode({
            active: true,
            agentState: {
                controlledByUser: false,
                requests: {},
                completedRequests: {},
            },
        })).toBe(true)
        expect(canChangeSessionPermissionMode({
            active: false,
            agentState: {
                controlledByUser: false,
                requests: {},
                completedRequests: {},
            },
        })).toBe(false)
    })
})
