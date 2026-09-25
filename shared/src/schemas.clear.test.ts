import { describe, expect, it } from 'vitest'
import { MetadataSchema, SessionEndReasonSchema } from './schemas'

describe('fresh-session clear schema contract', () => {
    it('preserves the archived session replacement link', () => {
        expect(MetadataSchema.parse({
            path: '/tmp/project',
            host: 'host',
            supersededBySessionId: 'new-session-id'
        })).toMatchObject({ supersededBySessionId: 'new-session-id' })
    })

    it('preserves session-job merge redirect fields (must not strip as unknown)', () => {
        const parsed = MetadataSchema.parse({
            path: '/tmp/project',
            host: 'host',
            jobsAcceptedFromSessionIds: ['old-session-id'],
            jobsTransferredToSessionId: 'new-session-id',
            jobKeyRedirects: {
                'old-session-id/beets': 'beets.oldsess1',
            },
        })
        expect(parsed.jobsAcceptedFromSessionIds).toEqual(['old-session-id'])
        expect(parsed.jobsTransferredToSessionId).toBe('new-session-id')
        expect(parsed.jobKeyRedirects).toEqual({
            'old-session-id/beets': 'beets.oldsess1',
        })
    })

    it('accepts cleared as an additive session-end reason', () => {
        expect(SessionEndReasonSchema.parse('cleared')).toBe('cleared')
    })
})
