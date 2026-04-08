import { describe, expect, it } from 'vitest'
import type { SessionProfile } from '@hapi/protocol'
import {
    applyCodexProfile,
    getBaseCodexLaunchState
} from './codexProfileState'

describe('codexProfileState', () => {
    it('returns base Codex launch defaults', () => {
        expect(getBaseCodexLaunchState()).toEqual({
            model: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'default',
            collaborationMode: 'default',
            sessionType: 'simple'
        })
    })

    it('resets to base defaults when no profile is selected', () => {
        const customBase = {
            model: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'default',
            collaborationMode: 'default',
            sessionType: 'simple'
        } as const

        expect(applyCodexProfile(customBase, null)).toEqual(customBase)
    })

    it('applies sparse profile defaults without inventing missing values', () => {
        const profile: SessionProfile = {
            id: 'ice',
            label: 'Ice',
            agent: 'codex',
            defaults: {
                permissionMode: 'safe-yolo',
                collaborationMode: 'plan',
                sessionType: 'worktree'
            }
        }

        expect(applyCodexProfile(getBaseCodexLaunchState(), profile)).toEqual({
            model: 'auto',
            modelReasoningEffort: 'default',
            permissionMode: 'safe-yolo',
            collaborationMode: 'plan',
            sessionType: 'worktree'
        })
    })
})
