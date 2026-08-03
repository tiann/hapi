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

    it('accepts cleared as an additive session-end reason', () => {
        expect(SessionEndReasonSchema.parse('cleared')).toBe('cleared')
    })
})
