import { describe, expect, it } from 'vitest'
import { formatSessionMentionChipLabel } from './sessionMentionChip'

describe('formatSessionMentionChipLabel', () => {
    it('matches rich-composer @title chip text', () => {
        expect(formatSessionMentionChipLabel(
            'hapi-inline ownership',
            '3e387783-d48e-4a73-932a-90acebe91702'
        )).toBe('@hapi-inline ownership')
    })

    it('falls back to id prefix when title is empty', () => {
        expect(formatSessionMentionChipLabel(
            '  ',
            '3e387783-d48e-4a73-932a-90acebe91702'
        )).toBe('@3e387783')
    })
})
