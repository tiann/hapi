import { afterEach, describe, expect, it, vi } from 'vitest'
import { realtimeClientTools, registerSessionStore } from './realtimeClientTools'

vi.mock('./RealtimeSession', () => ({
    getCurrentRealtimeSessionId: () => 'session-1',
}))

vi.mock('./voiceConfig', () => ({
    VOICE_CONFIG: {
        ENABLE_DEBUG_LOGGING: false,
    },
}))

afterEach(() => {
    registerSessionStore(null)
})

describe('realtimeClientTools processPermissionRequest local mode', () => {
    it('returns an error when local-mode approval is refused by the session store', async () => {
        const approvePermission = vi.fn(async () => {
            throw new Error('Approve this in the local terminal, or switch to remote mode first.')
        })
        const denyPermission = vi.fn()

        registerSessionStore({
            getSession: () => ({
                agentState: {
                    controlledByUser: true,
                    requests: {
                        'perm-1': { tool: 'Bash' },
                    },
                },
            }),
            sendMessage: vi.fn(),
            approvePermission,
            denyPermission,
        })

        const result = await realtimeClientTools.processPermissionRequest({ decision: 'allow' })

        expect(result).toBe('error (failed to allow permission)')
        expect(approvePermission).toHaveBeenCalledWith('session-1', 'perm-1')
        expect(denyPermission).not.toHaveBeenCalled()
    })

    it('approves when remote session store accepts the decision', async () => {
        const approvePermission = vi.fn(async () => {})
        const denyPermission = vi.fn()

        registerSessionStore({
            getSession: () => ({
                agentState: {
                    controlledByUser: false,
                    requests: {
                        'perm-1': { tool: 'Bash' },
                    },
                },
            }),
            sendMessage: vi.fn(),
            approvePermission,
            denyPermission,
        })

        const result = await realtimeClientTools.processPermissionRequest({ decision: 'allow' })

        expect(result).toContain('done')
        expect(approvePermission).toHaveBeenCalledWith('session-1', 'perm-1')
    })
})
