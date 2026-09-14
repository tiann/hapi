import { describe, expect, it } from 'vitest'
import {
    SESSION_MENTION_DRAG_MIME,
    parseSessionMentionDrag,
} from './sessionMentionDrag'

describe('parseSessionMentionDrag', () => {
    it('reads a session mention drag payload', () => {
        const transfer = {
            getData: (type: string) => type === SESSION_MENTION_DRAG_MIME
                ? '{"id":"peer-1","title":"Peer session"}'
                : '',
        }

        expect(parseSessionMentionDrag(transfer)).toEqual({
            id: 'peer-1',
            title: 'Peer session',
        })
    })

    it('rejects malformed drag payloads', () => {
        expect(parseSessionMentionDrag({ getData: () => '{"id":1}' })).toBeNull()
    })
})
