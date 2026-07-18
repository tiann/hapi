import { describe, expect, it } from 'vitest'
import { createResumeProfileFingerprint } from './resumeProfile'

describe('createResumeProfileFingerprint', () => {
    it('normalizes a fresh implicit default mode to the persisted resume value', () => {
        const freshProfile = {
            provider: 'hermes-moa',
            path: '/tmp/project',
            model: 'gpt-oss-120b',
            effort: null,
            modelReasoningEffort: null,
            serviceTier: null
        }

        const fresh = createResumeProfileFingerprint(freshProfile)
        const resumed = createResumeProfileFingerprint({ ...freshProfile, permissionMode: 'default' })

        expect(fresh).toMatch(/^[a-f0-9]{64}$/)
        expect(resumed).toBe(fresh)
    })

    it('separates profiles whose provider configuration differs', () => {
        const base = {
            provider: 'codex',
            path: '/tmp/project',
            model: 'gpt-5.6-sol',
            effort: null,
            modelReasoningEffort: 'max',
            serviceTier: 'fast',
            permissionMode: 'default'
        }

        expect(createResumeProfileFingerprint(base)).not.toBe(createResumeProfileFingerprint({
            ...base,
            permissionMode: 'yolo'
        }))
    })
})
